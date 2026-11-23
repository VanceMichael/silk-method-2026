// 纯领域逻辑：资料版解析、等效路径、改签替换、原件索引与分项判定。
// 全部函数无副作用，便于按同一状态重复计算、重复办理。

// ---- 资料版行记录解析为带字段名的登记册 ----
export function parseRegistry(streams) {
  const pick = (name, headers) => (streams[name] || []).map(cells =>
    Object.fromEntries(headers.map((field, idx) => [field, cells[idx]])))
  return {
    orders: pick('orders', ['buyer', 'order', 'lot', 'method', 'condition', 'orientation', 'day']),
    bindings: pick('bindings', ['lab', 'receipt', 'sample', 'lot', 'orientation']),
    tests: pick('tests', ['lab', 'receipt', 'sample', 'report', 'item', 'method', 'condition', 'value', 'draft']),
    evidence: pick('evidence', ['draft', 'item', 'method', 'condition']),
    equiv: pick('equiv', ['buyer', 'from', 'to', 'condition', 'fromDay', 'untilDay']),
    issued: pick('issued', ['order', 'item', 'report', 'draft']),
    corrected: pick('corrected', ['oldReport', 'item', 'newReport'])
  }
}

// 改签表：某报告的某指标只被替换为新报告；其余指标不受影响。
export function correctionMap(registry) {
  const map = new Map()
  for (const row of registry.corrected) {
    map.set(row.oldReport + '\u0000' + row.item, row.newReport)
  }
  return map
}

// 同键报告去重（同一报告号在流里可能重复出现，取字段完整的一条）。
function indexTests(registry) {
  const byReport = new Map()
  for (const test of registry.tests) byReport.set(test.report + '\u0000' + test.item, test)
  return byReport
}

// 等效是有向边：买家专属、只在具体条件与左闭右开的适用日内有效。
// 返回从来源方法到目标方法的整条方法链（含两端），无路径返回 null。
export function equivalencePath(registry, buyer, sourceMethod, targetMethod, condition, day) {
  if (sourceMethod === targetMethod) return [sourceMethod]
  const edges = registry.equiv.filter(row =>
    row.buyer === buyer && row.condition === condition &&
    Number(day) >= Number(row.fromDay) && Number(day) < Number(row.untilDay))
  const queue = [[sourceMethod]]
  const seen = new Set([sourceMethod])
  while (queue.length) {
    const path = queue.shift()
    const current = path[path.length - 1]
    for (const edge of edges) {
      if (edge.from !== current || seen.has(edge.to)) continue
      const next = [...path, edge.to]
      if (edge.to === targetMethod) return next
      seen.add(edge.to)
      queue.push(next)
    }
  }
  return null
}

// 改签后某报告+指标当前应使用的报告号；未被改签则原样返回。
export function effectiveReport(corrections, report, item) {
  return corrections.get(report + '\u0000' + item) || report
}

// 把历史清单/页件观察整理成按包、按 path 的最新页件状态。
// 同一包档案号跨清单代时，path 可能复用但 sha 不同——以“当前清单代”为准，
// 旧代页件保留在 observations 里供旧回执追溯，绝不充作新证明。
export function buildPackIndex(observedPacks) {
  const index = new Map()
  for (const observation of observedPacks) {
    const pack = index.get(observation.packId) || {
      packId: observation.packId, generation: observation.generation,
      members: new Map(), generations: new Set(), observations: []
    }
    pack.generation = observation.generation
    pack.generations.add(observation.generation)
    for (const member of observation.manifest.members || []) {
      const current = pack.members.get(member.path)
      // 同代的页件核实结果落到成员上；换代后旧 page 不得沿用，等新代自己的核实。
      const sameGeneration = current?.generation === observation.generation
      const result = (observation.members || []).find(m => m.path === member.path)
      const page = result
        ? { status: result.status, sha256: result.sha256 ?? member.sha256, stored: result.stored ?? null, error: result.error || '' }
        : (sameGeneration ? current.page : null)
      const history = current ? [...current.history] : []
      if (current && current.generation !== observation.generation && current.page) {
        history.push({ generation: current.generation, page: current.page })
      }
      pack.members.set(member.path, {
        path: member.path,
        item: member.item,
        sha256: member.sha256,
        generation: observation.generation,
        page,
        history
      })
    }
    pack.observations.push({ at: observation.at, generation: observation.generation })
    index.set(observation.packId, pack)
  }
  return index
}

// 成员 path 与样品朝向的对应：/back 等反面 path 归 back，其余按绑定朝向。
export function inferOrientation(memberPath, bindingsForSample) {
  if (/back/i.test(memberPath)) {
    return bindingsForSample.find(binding => binding.orientation === 'back')?.orientation || 'back'
  }
  return bindingsForSample.find(binding => binding.orientation === 'face')?.orientation
    || bindingsForSample[0]?.orientation || 'face'
}

// 为一个包建立“成员 -> 实验室接收单/朝向”的落点，缺页也要落到实际接收单。
export function locatePackMembers(pack, registry) {
  // 包号即底稿号；先找该底稿涉及的样品本地号与检验批。
  const relatedTests = registry.tests.filter(test => test.draft === pack.packId)
  const sampleLots = new Set(relatedTests.map(test => test.sample + '\u0000' + (
    registry.bindings.find(b => b.lab === test.lab && b.receipt === test.receipt && b.sample === test.sample)?.lot || '')))
  // 同一样品号在不同实验室是不同接收单，全部纳入后再按朝向区分，绝不跨实验室混用。
  const bindings = registry.bindings.filter(binding =>
    sampleLots.has(binding.sample + '\u0000' + binding.lot))
  return [...pack.members.values()].map(member => {
    const orientation = inferOrientation(member.path, bindings)
    const binding = bindings.find(candidate => candidate.orientation === orientation)
      || bindings.find(candidate => candidate.lab === relatedTests[0]?.lab)
      || bindings[0] || null
    return {
      path: member.path,
      item: member.item,
      sha256: member.sha256,
      generation: member.generation,
      orientation,
      binding: binding ? { lab: binding.lab, receipt: binding.receipt, sample: binding.sample, lot: binding.lot } : null,
      page: member.page
        ? { status: member.page.status, sha256: member.page.sha256, stored: member.page.stored, error: member.page.error }
        : { status: 'missing', sha256: member.sha256, stored: null, error: '清单已列页但原件未到达' }
    }
  })
}

function pathOrientation(memberPath) {
  return /back/i.test(memberPath) ? 'back' : 'face'
}

function findVerifiedPage(packIndex, draftId, item, orientation) {
  const pack = packIndex.get(draftId)
  if (!pack) return null
  const hit = [...pack.members.values()].find(member =>
    member.item === item && member.page?.status === 'verified' &&
    pathOrientation(member.path) === orientation)
  return hit ? { path: hit.path, sha256: hit.sha256, generation: hit.generation, stored: hit.page.stored } : null
}

// 分项判定：对一张订单的一个指标，给出可交/待补/复核的实际依据。
export function evaluateOrderItem(registry, order, item, packIndex, receiptView, corrections, byReport) {
  const day = Number(order.day)
  const candidates = []
  const seenEffective = new Set()
  for (const test0 of registry.tests.filter(t => t.item === item)) {
    const reportNow = effectiveReport(corrections, test0.report, item)
    // 同一份有效报告只判定一次，避免旧报告记录与改签后新报告重复成候选。
    if (seenEffective.has(reportNow)) continue
    seenEffective.add(reportNow)
    const test = byReport.get(reportNow + '\u0000' + item) || test0
    const correctedFrom = reportNow !== test0.report ? test0.report : null
    // 样品身份必须落在同一实验室、同一接收单、同一本地样品号上。
    const binding = registry.bindings.find(b =>
      b.lab === test.lab && b.receipt === test.receipt && b.sample === test.sample
      && b.lot === order.lot && b.orientation === order.orientation)
    if (!binding) continue
    if (test.condition !== order.condition) continue
    // 方法链：从实测方法到买家指定方法，按买家等效规则与适用日判断。
    const path = equivalencePath(registry, order.buyer, test.method, order.method, order.condition, day)
    if (!path) continue
    // 底稿与支持证书范围必须覆盖该指标、方法、条件。
    if (test.draft === '-' || test.draft === '') continue
    const scope = registry.evidence.some(e =>
      e.draft === test.draft && e.item === item && e.method === test.method && e.condition === test.condition)
    if (!scope) continue

    const page = findVerifiedPage(packIndex, test.draft, item, order.orientation)
    const blockers = []
    if (!page) {
      const pack = packIndex.get(test.draft)
      if (!pack) blockers.push('原件包尚未采集：' + test.draft)
      else {
        const located = locatePackMembers(pack, registry)
        const member = located.find(m => m.item === item && m.orientation === order.orientation)
          || located.find(m => m.item === item)
        blockers.push(member?.page?.error ? member.page.error : '缺少通过核实的页件')
      }
    }
    candidates.push({
      report: test.report,
      replacedReport: correctedFrom,
      lab: test.lab,
      receipt: test.receipt,
      sample: test.sample,
      method: test.method,
      methodPath: path,
      condition: test.condition,
      value: test.value,
      draft: test.draft,
      binding: { lab: binding.lab, receipt: binding.receipt, sample: binding.sample, orientation: binding.orientation },
      page,
      blockers
    })
  }

  // 已确认的旧回执要能追到当时的原件；改签使其依据失效时进入复核。
  const receipts = (receiptView || []).filter(r => r.order === order.order && r.item === item)
  const activeReceipt = receipts.find(r => r.state === 'confirmed' || r.state === 'pending')
  const usable = candidates.filter(c => c.page && c.blockers.length === 0)
  let state
  if (activeReceipt && activeReceipt.state === 'pending') state = 'review'
  else if (activeReceipt && activeReceipt.state === 'confirmed') {
    const stillGood = usable.some(c => c.draft === activeReceipt.draft && c.report === activeReceipt.report)
    state = stillGood ? 'delivered' : 'review'
  } else if (usable.length > 0) state = 'ready'
  else if (candidates.length > 0) state = 'pending-supply'
  else state = 'no-basis'

  return {
    order: order.order,
    buyer: order.buyer,
    item,
    required: { method: order.method, condition: order.condition, orientation: order.orientation, day: order.day },
    state,
    receipt: activeReceipt || null,
    candidates,
    usable
  }
}

// 订单需要评估的指标集合：测试流中与订单同批的指标，并上买家已回执/已签发指标。
export function itemsForOrder(registry, order) {
  const lots = new Set(registry.bindings.filter(b => b.lot === order.lot).map(b => b.lab + '\u0000' + b.receipt + '\u0000' + b.sample))
  const items = new Set()
  for (const test of registry.tests) {
    if (lots.has(test.lab + '\u0000' + test.receipt + '\u0000' + test.sample)) items.add(test.item)
  }
  for (const issued of registry.issued) if (issued.order === order.order) items.add(issued.item)
  return [...items]
}

export function evaluateAll(registry, packIndex, receiptView) {
  const corrections = correctionMap(registry)
  const byReport = indexTests(registry)
  return registry.orders.map(order => ({
    order: order.order,
    buyer: order.buyer,
    lot: order.lot,
    items: itemsForOrder(registry, order).map(item =>
      evaluateOrderItem(registry, order, item, packIndex, receiptView, corrections, byReport))
  }))
}
