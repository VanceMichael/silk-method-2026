import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv, toBaseUnit } from '../station/csv.mjs'

test('演练页按 BOM、CRLF 与引号内逗号正确解析', () => {
  const buffer = Buffer.from(
    '﻿样品号,指标,测量值,单位\r\n"SP,02",耐受,23,厘牛\r\n', 'utf8')
  const { headers, rows } = parseCsv(buffer)
  assert.deepEqual(headers, ['样品号', '指标', '测量值', '单位'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]['样品号'], 'SP,02')
  assert.equal(rows[0]['测量值'], '23')
})

test('厘牛按实验室公布系数 0.01 换算为牛', () => {
  assert.deepEqual(toBaseUnit('23', '厘牛'), { value: 0.23, unit: '牛' })
  assert.deepEqual(toBaseUnit('4', '牛'), { value: 4, unit: '牛' })
})
