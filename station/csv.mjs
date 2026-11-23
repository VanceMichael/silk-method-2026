// 带 UTF-8 BOM、CRLF 和引号逗号的简易 RFC4180 风格 CSV 解析。
// 演练页第一行为中文列名，返回 { headers, rows }，rows 为对象数组。
export function parseCsv(buffer) {
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const records = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      records.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    records.push(row)
  }
  const nonEmpty = records.filter(cells => cells.length > 1 || (cells.length === 1 && cells[0] !== ''))
  if (nonEmpty.length === 0) return { headers: [], rows: [] }
  const headers = nonEmpty[0]
  return {
    headers,
    rows: nonEmpty.slice(1).map(cells => Object.fromEntries(headers.map((name, idx) => [name, cells[idx] ?? ''])))
  }
}

// 实验室公布的单位换算：厘牛 -> 牛，系数 0.01。
export const unitConversions = {
  厘牛: { unit: '牛', factor: 0.01 }
}

export function toBaseUnit(value, unit) {
  const number = Number(value)
  const rule = unitConversions[unit]
  if (!rule) return { value: number, unit }
  return { value: number * rule.factor, unit: rule.unit }
}
