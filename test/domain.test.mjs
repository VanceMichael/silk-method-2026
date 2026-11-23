import assert from 'node:assert/strict'
import test from 'node:test'
import { equivalencePath, correctionMap, effectiveReport, parseRegistry } from '../station/domain.mjs'

function registryWith(equiv, corrected = []) {
  return parseRegistry({
    orders: [], bindings: [], tests: [], evidence: [],
    equiv, issued: [], corrected
  })
}

test('等效是有向边，且只在买家、条件和左闭右开适用日内成立', () => {
  const registry = registryWith([
    ['A', 'M1', 'M2', 'wet', '5', '10'],
    ['A', 'M2', 'M3', 'wet', '5', '10'],
    ['B', 'M1', 'M3', 'wet', '0', '10'],
    ['A', 'M1', 'M3', 'dry', '0', '10']
  ])

  // 多跳有向路径。
  assert.deepEqual(equivalencePath(registry, 'A', 'M1', 'M3', 'wet', 6), ['M1', 'M2', 'M3'])
  // 反向不成立。
  assert.equal(equivalencePath(registry, 'A', 'M3', 'M1', 'wet', 6), null)
  // 适用日左闭右开：第 5 天可以，第 10 天不行。
  assert.deepEqual(equivalencePath(registry, 'A', 'M1', 'M2', 'wet', 5), ['M1', 'M2'])
  assert.equal(equivalencePath(registry, 'A', 'M1', 'M2', 'wet', 10), null)
  // 条件隔离：wet 的边不能用于 dry。
  assert.equal(equivalencePath(registry, 'A', 'M2', 'M3', 'dry', 6), null)
  // 买家隔离：B 的 M1->M3 不出现在 A 的图里。
  assert.equal(equivalencePath(registry, 'A', 'M1', 'M3', 'wet', 6)?.includes('M3'), true)
  assert.equal(equivalencePath(registry, 'B', 'M1', 'M2', 'wet', 6), null)
  // 同方法平凡路径。
  assert.deepEqual(equivalencePath(registry, 'A', 'M1', 'M1', 'wet', 6), ['M1'])
})

test('改签键精确到报告加指标，其余指标不动', () => {
  const registry = registryWith([], [
    ['rep1', 'tear', 'rep2'],
    ['repK', '耐受', 'repK2']
  ])
  const corrections = correctionMap(registry)
  assert.equal(effectiveReport(corrections, 'rep1', 'tear'), 'rep2')
  assert.equal(effectiveReport(corrections, 'rep1', 'rub'), 'rep1')
  assert.equal(effectiveReport(corrections, 'repK', '耐受'), 'repK2')
})
