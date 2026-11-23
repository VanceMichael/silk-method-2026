import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { Station } from '../station/station.mjs'
import { createStationApp } from '../station/server.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + server.address().port
}

async function harness(t) {
  const sourceServer = createSource()
  const providerServer = provider()
  const sourceRoot = await listen(sourceServer)
  const providerRoot = await listen(providerServer)
  t.after(() => sourceServer.close())
  t.after(() => providerServer.close())
  const dataDir = await mkdtemp(join(tmpdir(), 'silk-station-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  let ticks = 0
  const station = new Station({
    dataDir, sourceRoot, providerRoot,
    clock: () => '2026-11-23T00:00:0' + (ticks++ % 10) + 'Z'
  })
  await station.load()
  const app = createStationApp(station)
  const stationRoot = await listen(app)
  t.after(() => app.close())
  const call = async (path, init) => {
    const response = await fetch(stationRoot + path, init)
    return { status: response.status, body: await response.json() }
  }
  const post = (path, value) => call(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  })
  return { station, dataDir, sourceRoot, providerRoot, call, post }
}

test('r1：按底稿与页版收原件，跨实验室样品不混用，缺页只挂相关指标', async t => {
  const h = await harness(t)
  const result = await h.post('/sync', { packs: ['K1'] })
  assert.equal(result.status, 200)
  assert.equal(result.body.edition, 'r1')

  // K1 清单 o1 的 p1 与 silk-o1.csv 摘要一致，核实通过。
  const pack = result.body.packs[0]
  assert.equal(pack.ok, true)
  assert.equal(pack.generation, 'o1')
  assert.equal(pack.members[0].status, 'verified')
  // 23 厘牛 = 0.23 牛，与测试摘要 0.23 一致。
  assert.equal(pack.members[0].crossCheck.rows[0].anyConsistent, true)
  assert.equal(pack.members[0].crossCheck.rows[0].matches[0].unit, '牛')

  const orders = (await h.call('/orders')).body
  const ob = orders.find(o => o.order === 'OB')
  const tolerance = ob.items.find(i => i.item === '耐受')
  // OB 已确认的 T1 与当前原件一致，状态为已交付且可追溯到当时原件。
  assert.equal(tolerance.state, 'delivered')
  assert.equal(tolerance.receipt.receipt, 'T1')
  assert.equal(tolerance.usable[0].binding.lab, 'L')
  assert.equal(tolerance.usable[0].binding.receipt, 'R2')
  // 同编号样品 SP,02 在 Q 实验室是 back 接收单，不能与 L 的 face 原件混用。
  assert.equal(tolerance.candidates.every(c => c.binding.lab === 'L'), true)

  // r1 的等效只允许 A：M1->M2(wet)，不能到 M3，OA 的 rub 无替代依据。
  const oa = orders.find(o => o.order === 'OA')
  const rub = oa.items.find(i => i.item === 'rub')
  // Q/R1 的 rep9 是 back 朝向，不能用于 face 订单；raw1 又无 M3 等效。
  assert.equal(rub.state, 'no-basis')
  assert.ok(rub.candidates.every(c => c.binding.orientation === 'face'))

  // 页件按内容寻址保存，可重复取。
  const sha = pack.members[0].sha256
  const stored = await readFile(join(h.dataDir, 'pages', sha))
  assert.ok(stored.toString('utf8').includes('耐受'))
})

test('r1 业务流分页与 ETag：采集台通过分页取全量并缓存 ETag', async t => {
  const h = await harness(t)
  const first = await h.post('/sync', { packs: [] })
  assert.equal(first.body.edition, 'r1')
  const registry = h.station.registryView()
  // tests 流共 4 行（每页 2 行，分两页）。
  assert.equal(registry.tests.length, 4)
  const etagsBefore = { ...h.station.state.etags }
  await h.post('/sync', { packs: [] })
  // 第二轮来源未换版，ETag 保持不变。
  assert.deepEqual(h.station.state.etags, etagsBefore)
})

test('corrected：清单先换代而原件迟到，旧回执进入复核且交付被拦', async t => {
  const h = await harness(t)
  await h.post('/sync', { packs: ['K1'] })
  // 切到 r2 业务资料与 corrected 演练档。
  await fetch(h.sourceRoot + '/control?edition=r2', { method: 'POST' })
  await h.station.provider.stage('corrected')

  const synced = await h.post('/sync', { packs: ['K1'] })
  assert.equal(synced.body.edition, 'r2')
  const pack = synced.body.packs[0]
  assert.equal(pack.generation, 'o2')
  // p1 仍返回 o1 字节，与 o2 清单摘要不符：坏页不得充新证明。
  const p1 = pack.members.find(m => m.path === '/labpacks/p1')
  assert.equal(p1.status, 'mismatch')
  // back 页 425 尚未出页，作为独立缺项。
  const back = pack.members.find(m => m.path === '/labpacks/back')
  assert.equal(back.status, 'missing')
  assert.equal(back.httpStatus, 425)

  // 缺项落到实际实验室接收单 Q/R2（back 朝向）与页版 o2。
  const missing = (await h.call('/missing')).body
  const backGap = missing.find(m => m.path === '/labpacks/back')
  assert.equal(backGap.generation, 'o2')
  assert.equal(backGap.binding.lab, 'Q')
  assert.equal(backGap.binding.receipt, 'R2')
  assert.equal(backGap.pageStatus, 'missing')

  // 改签 repK/耐受 -> repK2：追查用到旧报告的买家 OB。
  const trace = (await h.call('/corrections')).body
  assert.ok(trace.some(x => x.oldReport === 'repK' && x.item === '耐受' && x.orders.includes('OB')))

  // OB 已确认的 T1 依据变成无效，进入复核，从当前可再发列表移走但签收保留。
  const orders = (await h.call('/orders')).body
  const obTolerance = orders.find(o => o.order === 'OB').items.find(i => i.item === '耐受')
  assert.equal(obTolerance.state, 'review')
  assert.equal(obTolerance.receipt.state, 'confirmed')
  assert.equal(obTolerance.usable.length, 0)

  // 未停用时直接交付 -> 409。
  const blocked = await h.post('/deliver', { order: 'OB', item: '耐受' })
  assert.equal(blocked.status, 409)

  // 申请停用：provider 记 pending，本地同步标记。
  const withdrawn = await h.post('/withdraw', { order: 'OB', item: '耐受', receipt: 'T1' })
  assert.equal(withdrawn.status, 202)
  const stillBlocked = await h.post('/deliver', { order: 'OB', item: '耐受' })
  assert.equal(stillBlocked.status, 409)
  const reviewNow = (await h.call('/orders')).body
    .find(o => o.order === 'OB').items.find(i => i.item === '耐受')
  assert.equal(reviewNow.state, 'review')
  assert.equal(reviewNow.receipt.state, 'pending')
})

test('withdrawn：新原件核实后两订单可共用同一实际原件，交付成功且可追溯', async t => {
  const h = await harness(t)
  await h.post('/sync', { packs: ['K1'] })
  await fetch(h.sourceRoot + '/control?edition=r2', { method: 'POST' })
  await h.station.provider.stage('corrected')
  await h.post('/sync', { packs: ['K1'] })
  await h.post('/withdraw', { order: 'OB', item: '耐受', receipt: 'T1' })
  await h.station.provider.stage('withdrawn')

  const synced = await h.post('/sync', { packs: ['K1'] })
  const p1 = synced.body.packs[0].members.find(m => m.path === '/labpacks/p1')
  assert.equal(p1.status, 'verified')
  // 24 厘牛 = 0.24 牛，与 repK2 摘要一致（repK 旧值 0.23 已被改签）。
  assert.equal(p1.crossCheck.rows[0].anyConsistent, true)
  assert.equal(p1.crossCheck.allRowsConsistent, true)

  const receipts = (await h.call('/receipts')).body
  assert.equal(receipts.find(r => r.receipt === 'T1').state, 'withdrawn')

  const orders = (await h.call('/orders')).body
  const ob = orders.find(o => o.order === 'OB').items.find(i => i.item === '耐受')
  const oa = orders.find(o => o.order === 'OA').items.find(i => i.item === '耐受')
  assert.equal(ob.state, 'ready')
  // r2 中 A 的 M1->M3(wet, 5<=6<10) 成立，OA 也可用同一物理页。
  assert.equal(oa.state, 'ready')
  assert.equal(ob.usable[0].page.sha256, oa.usable[0].page.sha256)
  assert.equal(ob.usable[0].page.stored, oa.usable[0].page.stored)

  // back 仍缺，继续挂在 Q/R2 与 o2 页版上，但不挡 face 订单。
  const missing = (await h.call('/missing')).body
  assert.ok(missing.some(m => m.path === '/labpacks/back' && m.pageStatus === 'missing'))

  const delivered = await h.post('/deliver', { order: 'OB', item: '耐受' })
  assert.equal(delivered.status, 201)
  assert.equal(delivered.body.receipt, 'T2')
  assert.equal(delivered.body.sent.manifest, 'o2')
  assert.equal(delivered.body.sent.members[0].sha256, p1.sha256)

  // 重复办理同一交付：幂等，不产生第二张回执。
  const again = await h.post('/deliver', { order: 'OB', item: '耐受' })
  assert.equal(again.status, 200)
  assert.equal(again.body.idempotent, true)

  // 旧回执 T1 的历史原件代仍可追溯，未被新页覆盖。
  const packs = (await h.call('/packs')).body[0]
  assert.deepEqual(packs.generations, ['o1', 'o2'])
  assert.ok(packs.observations.length >= 2)
})

test('改签只替换单一指标：tear 的新旧报告分开判定，湿态条件不匹配不发证', async t => {
  const h = await harness(t)
  await h.post('/sync', { packs: [] })
  await fetch(h.sourceRoot + '/control?edition=r2', { method: 'POST' })
  await h.post('/sync', { packs: [] })
  const trace = (await h.call('/corrections')).body
  const tear = trace.find(x => x.oldReport === 'rep1' && x.item === 'tear')
  assert.equal(tear.newReport, 'rep2')
  // raw2 证书范围是 dry，订单条件为 wet：有报告但条件不成立，只能待补/无依据。
  const orders = h.station.evaluation()
  const obTear = orders.find(o => o.order === 'OB').items.find(i => i.item === 'tear')
  assert.ok(['no-basis', 'pending-supply'].includes(obTear.state))
})

test('同步不存在的包时该包报错但不拖垮整轮同步', async t => {
  const h = await harness(t)
  const result = await h.post('/sync', { packs: ['NO-SUCH-PACK'] })
  assert.equal(result.status, 200)
  assert.equal(result.body.edition, 'r1')
  assert.equal(result.body.packs[0].ok, false)
  // 业务流与回执仍可用。
  const orders = await h.call('/orders')
  assert.equal(orders.status, 200)
})

test('重启后状态保留，办理可重复', async t => {
  const h = await harness(t)
  await h.post('/sync', { packs: ['K1'] })
  const restarted = new Station({
    dataDir: h.dataDir, sourceRoot: h.sourceRoot, providerRoot: h.providerRoot
  })
  await restarted.load()
  assert.equal(restarted.state.sequence, 1)
  const view = evaluate(restarted)
  assert.ok(view.some(o => o.items.some(i => i.item === '耐受')))
  const sha = restarted.state.observedPacks[0].members[0].sha256
  const buffer = await restarted.storedPage(sha)
  assert.ok(buffer)
})

function evaluate(station) {
  return station.evaluation()
}
