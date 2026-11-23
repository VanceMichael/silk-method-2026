// 质检员 HTTP 操作台：同步、订单分项状态、缺项落点、页件与回执复核、交付/停用。
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { Station } from './station.mjs'

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createStationApp(station) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      const { pathname } = url
      if (pathname === '/health') return send(response, 200, { ok: true, sequence: station.state.sequence })

      if (request.method === 'POST' && pathname === '/sync') {
        const body = await readJson(request).catch(() => ({}))
        return send(response, 200, await station.sync({ packs: body.packs || [] }))
      }
      if (pathname === '/orders' && request.method === 'GET') {
        return send(response, 200, station.evaluation())
      }
      if (pathname === '/missing' && request.method === 'GET') {
        return send(response, 200, station.missingView())
      }
      if (pathname === '/packs' && request.method === 'GET') {
        return send(response, 200, station.packsView())
      }
      if (pathname === '/receipts' && request.method === 'GET') {
        return send(response, 200, station.receiptView())
      }
      if (pathname === '/corrections' && request.method === 'GET') {
        return send(response, 200, station.traceCorrections())
      }
      if (pathname === '/deliveries' && request.method === 'GET') {
        return send(response, 200, station.state.deliveries)
      }
      if (pathname === '/syncs' && request.method === 'GET') {
        return send(response, 200, station.state.syncs)
      }
      const pageMatch = /^\/pages\/([0-9a-f]{64})$/.exec(pathname)
      if (pageMatch && request.method === 'GET') {
        const buffer = await station.storedPage(pageMatch[1])
        if (!buffer) return send(response, 404, { error: '没有该内容寻址页件' })
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': buffer.length,
          'X-SHA-256': pageMatch[1]
        })
        return response.end(buffer)
      }
      if (pathname === '/withdraw' && request.method === 'POST') {
        const body = await readJson(request)
        const result = await station.requestWithdraw(body)
        return send(response, result.status, result.body)
      }
      if (pathname === '/deliver' && request.method === 'POST') {
        const body = await readJson(request)
        const result = await station.requestDeliver(body)
        const payload = result.sent ? { ...result.body, sent: result.sent } : result.body
        return send(response, result.status, payload)
      }
      return send(response, 404, { error: '没有该路由' })
    } catch (error) {
      return send(response, 500, { error: error.message })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const station = new Station({
    dataDir: process.env.STATION_DIR || './station-data',
    sourceRoot: process.env.SOURCE_ROOT || 'http://127.0.0.1:8700',
    providerRoot: process.env.PROVIDER_ROOT || 'http://127.0.0.1:8701'
  })
  await station.load()
  const server = createStationApp(station)
  server.listen(Number(process.env.STATION_PORT || 8702), '127.0.0.1', () => {
    console.log('采集台已启动：http://127.0.0.1:' + server.address().port)
  })
}
