import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

import { createHash } from 'node:crypto'
test('清单先变但原件迟到，买家确认前不接替换件', async t => {
  const root = await listen(t)
  await post(root, '/lab?stage=corrected')
  const manifest = await (await fetch(root + '/labpacks/manifest?id=K1')).json()
  const hash = async () => createHash('sha256').update(Buffer.from(await (await fetch(root + '/labpacks/p1')).arrayBuffer())).digest('hex')
  assert.notEqual(await hash(), manifest.members[0].sha256)
  assert.equal((await post(root, '/buyers/withdraw', { order: 'J1', receipt: 'T1' })).status, 202)
  assert.equal((await post(root, '/buyers/deliver', { order: 'J1' })).status, 409)
  await post(root, '/lab?stage=withdrawn')
  assert.equal(await hash(), manifest.members[0].sha256)
})
