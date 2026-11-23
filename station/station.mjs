// 采集台编排：同步两个来源、内容寻址保存页件、持久化状态，
// 并把领域判定结果组织成质检员可直接使用的视图。
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { SourceClient } from './source-client.mjs'
import { ProviderClient } from './provider-client.mjs'
import { parseCsv, toBaseUnit } from './csv.mjs'
import {
  parseRegistry, buildPackIndex, evaluateAll, locatePackMembers,
  correctionMap
} from './domain.mjs'

const STATE_FILE = 'state.json'

export class Station {
  constructor({ dataDir, sourceRoot, providerRoot, clock = () => new Date().toISOString() }) {
    this.dataDir = dataDir
    this.pagesDir = join(dataDir, 'pages')
    this.source = new SourceClient(sourceRoot)
    this.provider = new ProviderClient(providerRoot)
    this.clock = clock
    this.state = {
      sequence: 0,
      registry: null,
      etags: {},
      observedPacks: [],
      receipts: [],
      localReceipts: [],
      deliveries: [],
      syncs: []
    }
  }

  async load() {
    await mkdir(this.pagesDir, { recursive: true })
    try {
      const raw = await readFile(join(this.dataDir, STATE_FILE), 'utf8')
      this.state = JSON.parse(raw)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  async save() {
    const tmp = join(this.dataDir, STATE_FILE + '.tmp')
    await writeFile(tmp, JSON.stringify(this.state, null, 2))
    await rename(tmp, join(this.dataDir, STATE_FILE))
  }

  registryView() {
    if (!this.state.registry) throw new Error('尚未同步业务来源')
    return parseRegistry(this.state.registry.streams)
  }

  packIndex() {
    return buildPackIndex(this.state.observedPacks)
  }

  // 回执视图：provider 实况 + 本地停用申请叠加，并补出报告/底稿依据。
  receiptView() {
    const registry = this.registryView()
    const issuedIndex = new Map(registry.issued.map(row => [row.order + '\u0000' + row.item, row]))
    const merged = new Map()
    for (const receipt of this.state.receipts) {
      merged.set(receipt.order + '\u0000' + receipt.item + '\u0000' + receipt.receipt, { ...receipt })
    }
    for (const local of this.state.localReceipts) {
      const key = local.order + '\u0000' + local.item + '\u0000' + local.receipt
      merged.set(key, { ...(merged.get(key) || {}), ...local })
    }
    return [...merged.values()].map(receipt => {
      const issued = issuedIndex.get(receipt.order + '\u0000' + receipt.item)
      return {
        ...receipt,
        report: receipt.report || issued?.report || null,
        draft: receipt.draft || issued?.draft || null
      }
    })
  }

  // ---- 同步第一来源（总目录、分页流、ETag）----
  async syncRegistry() {
    const previous = this.state.registry
      ? { edition: this.state.registry.edition, streams: this.state.registry.streams, etags: this.state.etags }
      : { etags: {} }
    const snapshot = await this.source.pullAll(undefined, previous)
    this.state.registry = { edition: snapshot.edition, streams: snapshot.streams, at: this.clock() }
    this.state.etags = snapshot.etags
    return snapshot.edition
  }

  async storePage(buffer) {
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const target = join(this.pagesDir, sha256)
    let already = true
    try {
      await readFile(target)
    } catch {
      already = false
      await writeFile(target, buffer)
    }
    return { sha256, stored: 'pages/' + sha256, already }
  }

  // 页件数值与测试摘要值按实验室公布换算交叉核对。
  crossCheckPage(buffer, manifestItem) {
    let parsed
    try {
      parsed = parseCsv(buffer)
    } catch (error) {
      return { checked: false, error: '页件 CSV 无法解析：' + error.message }
    }
    const registry = this.registryView()
    const rows = parsed.rows
      .filter(row => row['指标'] === manifestItem.item)
      .map(row => {
        const converted = toBaseUnit(row['测量值'], row['单位'])
        const matches = registry.tests
          .filter(test => test.item === manifestItem.item && test.sample === row['样品号']
            && test.condition === row['条件'])
          .map(test => {
            const expected = Number(test.value)
            return {
              report: test.report,
              abstract: expected,
              pageBase: converted.value,
              unit: converted.unit,
              consistent: Math.abs(expected - converted.value) < 1e-9
            }
          })
        // 改签会同号并存新旧报告：页值只要与至少一份当前摘要一致即可读。
        return {
          sample: row['样品号'], condition: row['条件'], orientation: row['朝向'],
          matches, anyConsistent: matches.some(match => match.consistent)
        }
      })
    return {
      checked: true,
      headers: parsed.headers,
      rows,
      allRowsConsistent: rows.length > 0 && rows.every(row => row.anyConsistent)
    }
  }

  // ---- 同步一个原件包：清单先于页件也能记录，坏页/缺页单独呈现 ----
  async syncPack(packId) {
    const manifestResult = await this.provider.manifest(packId)
    if (!manifestResult.ok) {
      return { packId, ok: false, status: manifestResult.status, error: manifestResult.error }
    }
    const manifest = manifestResult.manifest
    const at = this.clock()
    const memberResults = []
    for (const member of manifest.members) {
      const fetched = await this.provider.fetchPage(member.path, member.sha256)
      if (!fetched.ok) {
        memberResults.push({
          path: member.path, item: member.item, expected: member.sha256,
          status: fetched.status === 200 ? 'mismatch' : 'missing',
          error: fetched.error, httpStatus: fetched.status
        })
        continue
      }
      const stored = await this.storePage(fetched.buffer)
      const cross = this.crossCheckPage(fetched.buffer, member)
      memberResults.push({
        path: member.path, item: member.item,
        status: 'verified', sha256: fetched.sha256, stored: stored.stored,
        httpStatus: fetched.status, crossCheck: cross
      })
    }
    this.state.observedPacks.push({
      packId, at, generation: manifest.generation,
      manifest: { id: manifest.id, generation: manifest.generation, members: manifest.members },
      members: memberResults
    })
    return { packId, ok: true, generation: manifest.generation, members: memberResults }
  }

  // 同步一个回执阶段：拉买家回执实况；本地 pending 仅在 provider 确认停用时清除。
  // 该阶段暂未提供回执清单时保留上一次实况并标注，不让整轮同步失败。
  async syncReceipts() {
    const result = await this.provider.receipts()
    if (!result.ok) {
      return { receipts: this.state.receipts, receiptsAvailable: false }
    }
    this.state.receipts = result.receipts
    this.state.localReceipts = this.state.localReceipts.filter(local => {
      const live = result.receipts.find(r => r.receipt === local.receipt && r.order === local.order)
      return !(live && live.state === 'withdrawn')
    })
    return { receipts: result.receipts, receiptsAvailable: true }
  }

  async sync({ packs = [] }) {
    const startedAt = this.clock()
    const edition = await this.syncRegistry()
    const packResults = []
    for (const packId of packs) packResults.push(await this.syncPack(packId))
    const receiptResult = await this.syncReceipts()
    this.state.sequence += 1
    this.state.syncs.push({
      sequence: this.state.sequence, at: startedAt, edition,
      receiptsAvailable: receiptResult.receiptsAvailable,
      packs: packResults.map(r => ({ packId: r.packId, ok: r.ok, generation: r.generation }))
    })
    await this.save()
    return {
      sequence: this.state.sequence, edition,
      packs: packResults, receipts: receiptResult.receipts,
      receiptsAvailable: receiptResult.receiptsAvailable
    }
  }

  // ---- 质检员视图 ----
  evaluation() {
    const registry = this.registryView()
    return evaluateAll(registry, this.packIndex(), this.receiptView())
  }

  // 缺项：落到实际实验室接收单、清单代与页版；无订单受影响时 blocks 为空。
  missingView() {
    const registry = this.registryView()
    const output = []
    for (const pack of this.packIndex().values()) {
      for (const member of locatePackMembers(pack, registry)) {
        if (member.page.status === 'verified') continue
        const blocks = []
        for (const order of registry.orders) {
          for (const test of registry.tests.filter(t => t.draft === pack.packId && t.item === member.item)) {
            const binding = registry.bindings.find(b =>
              b.lab === test.lab && b.receipt === test.receipt && b.sample === test.sample
              && b.lot === order.lot && b.orientation === member.orientation)
            if (!binding) continue
            blocks.push({ order: order.order, item: member.item, orientation: member.orientation })
          }
        }
        output.push({
          pack: pack.packId,
          generation: member.generation,
          path: member.path,
          item: member.item,
          expectedSha256: member.sha256,
          pageStatus: member.page.status,
          error: member.page.error,
          binding: member.binding,
          blocks: [...new Map(blocks.map(b => [b.order + b.item + b.orientation, b])).values()]
        })
      }
    }
    return output
  }

  packsView() {
    const registry = this.registryView()
    return [...this.packIndex().values()].map(pack => ({
      packId: pack.packId,
      generation: pack.generation,
      generations: [...pack.generations],
      members: locatePackMembers(pack, registry),
      observations: pack.observations
    }))
  }

  // 追查哪些买家的回领用了被改签报告；仍成立的分项保留在可再发列表。
  traceCorrections() {
    const registry = this.registryView()
    const corrections = correctionMap(registry)
    const impacted = []
    for (const [key, newReport] of corrections) {
      const [oldReport, item] = key.split('\u0000')
      const users = registry.issued.filter(row => row.report === oldReport && row.item === item)
      impacted.push({ oldReport, item, newReport, orders: users.map(u => u.order) })
    }
    return impacted
  }

  // ---- 买家停用申请 ----
  async requestWithdraw({ order, item, receipt }) {
    if (!order || !receipt) return { status: 422, body: { error: 'order 与 receipt 必填' } }
    const live = this.state.receipts.find(r => r.order === order && r.receipt === receipt)
    if (!live) return { status: 404, body: { error: '没有该买家回执' } }
    const result = await this.provider.withdraw({ order, item, receipt })
    if (result.status === 202 || result.status === 200) {
      const mark = { order, item: item || live.item, receipt, state: 'pending', requestedAt: this.clock() }
      this.state.localReceipts = [
        ...this.state.localReceipts.filter(r => !(r.order === order && r.receipt === receipt)), mark
      ]
      await this.save()
    }
    return { status: result.status, body: result.body }
  }

  // ---- 分项交付：先过本地复核闸，再按清单代与成员校验值提交 ----
  async requestDeliver({ order, item }) {
    if (!order || !item) return { status: 422, body: { error: 'order 与 item 必填' } }
    const evaluated = this.evaluation()
      .flatMap(o => o.items).find(i => i.order === order && i.item === item)
    if (!evaluated) return { status: 404, body: { error: '订单没有该指标' } }
    if (evaluated.state === 'review') {
      return { status: 409, body: { error: '旧凭据尚未停用确认', receipt: evaluated.receipt?.receipt } }
    }
    const chosen = evaluated.usable[0]
    if (!chosen) return { status: 409, body: { error: '没有通过核实的可交原件', blockers: evaluated.candidates.map(c => c.blockers).flat() } }
    const pack = this.packIndex().get(chosen.draft)
    const payload = {
      order,
      item,
      manifest: pack.generation,
      members: [{ path: chosen.page.path, sha256: chosen.page.sha256 }]
    }
    // 幂等键：订单+指标+清单代+成员校验值。重复办理同一原件不再向外部重复发件。
    const duplicate = this.state.deliveries.find(d =>
      d.outcome === 'created' && d.order === order && d.item === item
      && d.manifest === payload.manifest
      && d.members[0].sha256 === payload.members[0].sha256)
    if (duplicate) return { status: 200, body: { receipt: duplicate.receipt, idempotent: true } }
    const result = await this.provider.deliver(payload)
    const record = {
      at: this.clock(), order, item,
      manifest: payload.manifest, members: payload.members,
      outcome: result.status === 201 ? 'created' : 'rejected',
      status: result.status, body: result.body,
      receipt: result.body?.receipt || null
    }
    this.state.deliveries.push(record)
    await this.save()
    return { status: result.status, body: result.body, sent: payload }
  }

  async storedPage(sha256) {
    const names = await readdir(this.pagesDir)
    if (!names.includes(sha256)) return null
    return readFile(join(this.pagesDir, sha256))
  }
}
