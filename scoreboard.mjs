// scoreboard.mjs - intelligence-per-cost ranking from the live catalog.
// Uses the catalog's artificial_analysis benchmark family (intelligence_index,
// coding_index, agentic_index) as selectable intelligence scores, and the
// model's real per-call cost at the given token mix. No score is invented;
// models without a benchmark score for the selected metric are excluded.
//
// metrics map: which sub-score to rank on. 'composite' blends the three AA
// sub-indices into a single 0-100 score (balanced weights, only models that
// have all three).

const oneM = n => n == null ? null : (Number(n) * 1e6);
const normId = s => String(s || '').toLowerCase().split('/').pop().replace(/_/g, '-');

const METRICS = {
  intelligence: m => m.benchmarks?.artificial_analysis?.intelligence_index,
  coding: m => m.benchmarks?.artificial_analysis?.coding_index,
  agentic: m => m.benchmarks?.artificial_analysis?.agentic_index,
};

export function scoreMetric(m, metric) {
  if (metric === 'composite') {
    const aa = m.benchmarks?.artificial_analysis;
    if (!aa) return null;
    const v = [aa.intelligence_index, aa.coding_index, aa.agentic_index];
    if (v.some(x => x == null)) return null;
    return v.reduce((a, b) => a + b, 0) / 3;
  }
  const fn = METRICS[metric] || METRICS.intelligence;
  return fn(m);
}

export function scoreboard(catalog, opts = {}) {
  const cachedK = opts.cachedK ?? 80;
  const freshK = opts.freshK ?? 4;
  const outK = opts.outK ?? 4;
  const metric = opts.metric || 'intelligence';
  const ccSet = new Set((opts.commandCodeIds || []).map(normId));
  // Deal overlay (deals.json): per-model promo rates and expiry. A deal keyed
  // by normalized id replaces the catalog price for cost/weekCost and adds a
  // visible deal tag. Keyed with the same normId() used below.
  const dealMap = new Map();
  for (const d of (opts.deals || [])) {
    for (const id of (d.ids || [])) dealMap.set(normId(id), d);
  }
  const rows = catalog.map(m => {
    const score = scoreMetric(m, metric);
    if (score == null) return null;
    const p = m.pricing || {};
    const cr = oneM(p.input_cache_read);
    const pr = oneM(p.prompt);
    const co = oneM(p.completion);
    if (cr == null || pr == null || co == null) return null;
    const deal = dealMap.get(normId(m.id)) || null;
    const effCr = deal && deal.cacheRead != null ? Number(deal.cacheRead) : cr;
    const effPr = deal && deal.prompt != null ? Number(deal.prompt) : pr;
    const effCo = deal && deal.completion != null ? Number(deal.completion) : co;
    const cost = (cachedK * effCr + freshK * effPr + outK * effCo) / 1000;
    const free = cost === 0;
    // Real-mix weekly cost: apply the user's actual 7-day traffic profile
    // (requests/week, cache-read/fresh/output tokens per request) to this
    // model's live prices. Honest dollars per week, not a guessed mix.
    // Deal-adjusted: a deal rate is per-1M USD, converted to the same
    // per-token unit the catalog prices use.
    const rm = opts.realMix;
    const ratePerToken = (v, fallback) => deal && v != null ? Number(v) / 1e6 : fallback;
    const weekCost = rm ? rm.reqPerWeek * (
      ratePerToken(deal ? deal.cacheRead : null, Number(p.input_cache_read) || 0) * rm.cachePerReq +
      ratePerToken(deal ? deal.prompt : null, Number(p.prompt) || 0) * rm.freshPerReq +
      ratePerToken(deal ? deal.completion : null, Number(p.completion) || 0) * rm.outPerReq
    ) : null;
    return {
      id: m.id,
      name: m.name,
      metric,
      intelligence: m.benchmarks?.artificial_analysis?.intelligence_index ?? null,
      coding: m.benchmarks?.artificial_analysis?.coding_index ?? null,
      agentic: m.benchmarks?.artificial_analysis?.agentic_index ?? null,
      score,
      cost,
      weekCost,
      ratio: free ? null : (score / cost),
      ctx: m.context_length || 0,
      reasoning: !!m.reasoning,
      cacheRead: effCr,
      free,
      deal: deal ? { label: deal.label, expiry: deal.expiry || null, note: deal.note || null } : null,
      provider: ccSet.has(normId(m.id)) ? 'both' : 'nous',
      sources: ccSet.has(normId(m.id)) ? ['nous', 'commandcode'] : ['nous'],
      weekReq: rm ? rm.reqPerWeek : null,
    };
  }).filter(Boolean);
  return rows;
}

