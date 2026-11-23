// 第一来源客户端：/catalog 与 /records/{stream}。
// 处理 Link rel="next" 分页、X-Edition、ETag/304 条件请求；继续标记失效时整轮重取。
export class SourceClient {
  constructor(root) {
    this.root = root
  }

  async catalog() {
    const response = await fetch(this.root + '/catalog')
    if (!response.ok) throw new Error('总目录读取失败：HTTP ' + response.status)
    return response.json()
  }

  // 拉取某资料版下某流的全部行；etag 命中 304 时返回 unchanged。
  async pullStream(stream, edition, previousEtag = null) {
    let target = new URL(this.root + '/records/' + stream)
    target.searchParams.set('edition', edition)
    const rows = []
    let etag = null
    for (;;) {
      const headers = {}
      if (rows.length === 0 && previousEtag) headers['If-None-Match'] = previousEtag
      const response = await fetch(target, { headers })
      if (response.status === 304 && rows.length === 0) return { unchanged: true, etag: previousEtag }
      if (response.status === 409) {
        // 继续标记只对同一资料版与筛选条件有效；失效后从第一页重新开始。
        if (rows.length > 0) {
          target = new URL(this.root + '/records/' + stream)
          target.searchParams.set('edition', edition)
          rows.length = 0
          continue
        }
        throw new Error(stream + ' 继续标记被来源拒绝')
      }
      if (!response.ok) throw new Error(stream + ' 读取失败：HTTP ' + response.status)
      etag = response.headers.get('ETag')
      const text = await response.text()
      rows.push(...text.split('\n').filter(Boolean).map(line => line.split('\t')))
      const link = response.headers.get('Link') || response.headers.get('link')
      const next = link && /rel="next"/.test(link) ? /^<([^>]+)>/.exec(link)?.[1] : null
      if (!next) break
      target = new URL(next, this.root)
    }
    return { unchanged: false, rows, etag }
  }

  async pullAll(edition, previous = {}) {
    const catalog = await this.catalog()
    const selected = edition || catalog.edition
    // ETag/继续标记仅对同一资料版有效：换版后必须放弃条件请求整轮重取。
    const reusable = previous.edition === selected
    const streams = {}
    const etags = {}
    for (const stream of catalog.streams) {
      const result = await this.pullStream(stream, selected,
        reusable ? (previous.etags?.[stream] ?? null) : null)
      if (result.unchanged) {
        streams[stream] = previous.streams[stream]
        etags[stream] = previous.etags[stream]
      } else {
        streams[stream] = result.rows
        etags[stream] = result.etag
      }
    }
    return { edition: selected, streams, etags }
  }
}
