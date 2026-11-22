import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const scenarios = JSON.parse(await readFile(new URL('../records/provider.json', import.meta.url), 'utf8'))

function write(response, status, body, headers = {}) {
  if (Buffer.isBuffer(body)) {
    response.writeHead(status, { 'Content-Type': 'application/octet-stream', ...headers })
    response.end(body)
  } else {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
}

export function provider() {
  let stage = Object.keys(scenarios.stages)[0]
  const arrivals = []
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname === '/lab') {
        if (request.method === 'POST') {
          const target = url.searchParams.get('stage')
          if (!Object.hasOwn(scenarios.stages, target)) return write(response, 404, { error: '没有该演练档' })
          stage = target
        }
        return write(response, 200, { stage, arrivals })
      }
      const headers = request.headers
      const body = []
      for await (const chunk of request) body.push(chunk)
      const payload = body.length ? JSON.parse(Buffer.concat(body).toString('utf8')) : undefined
      arrivals.push({ stage, method: request.method, path: url.pathname + url.search, payload })
      const route = [...scenarios.stages[stage], ...scenarios.common].find(candidate =>
        (candidate.method || 'GET') === request.method && candidate.path === url.pathname &&
        Object.entries(candidate.query || {}).every(([key, value]) => url.searchParams.get(key) === value) &&
        Object.entries(candidate.match || {}).every(([key, value]) => headers[key] === value) &&
        Object.entries(candidate.payload || {}).every(([key, value]) => JSON.stringify(payload?.[key]) === JSON.stringify(value)))
      if (!route) return write(response, 404, { error: '没有相应的资料或操作' })
      if (route.next) stage = route.next
      if (route.drop) return request.socket.destroy()
      if (!route.file) return write(response, route.status || 200, route.body, route.headers)
      const file = await readFile(new URL('../records/media/' + route.file, import.meta.url))
      const etag = route.headers?.ETag || '"' + route.file + '"'
      const meta = { 'Accept-Ranges': 'bytes', ETag: etag, ...route.headers }
      if (headers['if-match'] && headers['if-match'] !== etag) return write(response, 412, undefined, meta)
      if (!headers.range) return write(response, 200, file, { ...meta, 'Content-Length': file.length })
      const matched = /^bytes=(\d+)-(\d*)$/.exec(headers.range)
      if (!matched) return write(response, 416, undefined, { 'Content-Range': 'bytes */' + file.length })
      const first = Number(matched[1])
      const last = matched[2] ? Math.min(Number(matched[2]), file.length - 1) : file.length - 1
      if (first >= file.length || first > last) {
        return write(response, 416, undefined, { 'Content-Range': 'bytes */' + file.length })
      }
      return write(response, 206, file.subarray(first, last + 1), {
        ...meta, 'Content-Range': `bytes ${first}-${last}/${file.length}`, 'Content-Length': last - first + 1
      })
    } catch (error) {
      return write(response, 400, { error: error.message })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provider().listen(Number(process.env.PROVIDER_PORT || 8701), '127.0.0.1', () => {
    console.log('外部来源演练服务已启动')
  })
}
