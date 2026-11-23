// 第二来源客户端：实验室原件包清单、页件、买家回执与交付/停用操作。
import { createHash } from 'node:crypto'

export class ProviderClient {
  constructor(root) {
    this.root = root
  }

  async manifest(packId) {
    const response = await fetch(this.root + '/labpacks/manifest?id=' + encodeURIComponent(packId))
    if (!response.ok) return { ok: false, status: response.status, error: (await response.json().catch(() => ({})))?.error || '' }
    return { ok: true, status: response.status, manifest: await response.json() }
  }

  // 只按清单给的 path 与 sha256 取页，返回页字节与完整性结论；不做任何“同号沿用”。
  async fetchPage(path, expectedSha256) {
    const response = await fetch(this.root + path)
    if (!response.ok) {
      return { ok: false, status: response.status, error: (await response.json().catch(() => ({})))?.error || '页件不可取' }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(buffer).digest('hex')
    return {
      ok: actual === expectedSha256,
      status: response.status,
      buffer,
      sha256: actual,
      expected: expectedSha256,
      error: actual === expectedSha256 ? '' : '页件摘要不匹配'
    }
  }

  async receipts() {
    const response = await fetch(this.root + '/buyers/receipts')
    if (response.status === 404) return { ok: false, status: 404, receipts: null }
    if (!response.ok) throw new Error('买家回执读取失败：HTTP ' + response.status)
    return { ok: true, status: response.status, receipts: await response.json() }
  }

  async withdraw(payload) {
    const response = await fetch(this.root + '/buyers/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  async deliver(payload) {
    const response = await fetch(this.root + '/buyers/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  async stage(name) {
    const response = await fetch(this.root + '/lab?stage=' + encodeURIComponent(name), { method: 'POST' })
    if (!response.ok) throw new Error('演练档切换失败：HTTP ' + response.status)
    return response.json()
  }
}
