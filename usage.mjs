// usage.mjs - parse the usage CSV and compute cache-aware model recommendations.
// Input: usage.csv rows (date,credit_source,product,model,key,tool_action,user,requests,input_tokens,
//        output_tokens,cache_read_tokens,cache_write_tokens,debited_usd,credited_usd,net_usd)
// Plus the live catalog from /api/models.
import { readFile } from 'node:fs/promises';

export function parseUsageCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const rows = [];
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const model = (c[idx.model] || '').trim();
    const product = (c[idx.product] || '').trim();
    const action = (c[idx.tool_action] || '').trim();
    if (!model && !action) continue;
    rows.push({
      date: c[idx.date],
      model,
      product,
      key: c[idx.key],
      action,
      requests: Number(c[idx.requests]) || 0,
      input: Number(c[idx.input_tokens]) || 0,
      output: Number(c[idx.output_tokens]) || 0,
      cacheRead: Number(c[idx.cache_read_tokens]) || 0,
      cacheWrite: Number(c[idx.cache_write_tokens]) || 0,
      net: Number(c[idx.net_usd]) || 0,
    });
  }
  return rows;
}

// Aggregate usage per model, keeping only model rows (product === 'API' or a model present).
export function usageByModel(rows) {
  const agg = {};
  for (const r of rows) {
    if (!r.model) continue; // skip tool/subscription rows
    const a = agg[r.model] || (agg[r.model] = {
      model: r.model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, spend: 0,
    });
    a.requests += r.requests;
    a.input += r.input;
    a.output += r.output;
    a.cacheRead += r.cacheRead;
    a.cacheWrite += r.cacheWrite;
    a.spend += -r.net; // net_usd is negative for cost; positive = credit
  }
  return Object.values(agg).filter(a => a.spend > 0.0005 || a.input > 0);
}

// Cache hit rate 0..1 for a model's traffic.
export function hitRate(a) {
  return a.input > 0 ? Math.min(1, a.cacheRead / a.input) : 0;
}

// Model the cost of running the same traffic on a candidate catalog model.
// Applies the ORIGINAL model's cache hit rate to the candidate's prices.
export function candidateCost(a, hit, m) {
  const p = m.pricing || {};
  const cr = p.input_cache_read ? Number(p.input_cache_read) * 1e6 : null;
  const pr = p.prompt ? Number(p.prompt) * 1e6 : null;
  const co = p.completion ? Number(p.completion) * 1e6 : null;
  if (cr == null || pr == null || co == null) return null;
  const fresh = Math.max(0, a.input - a.cacheRead);
  return (a.cacheRead * cr + fresh * pr + a.output * co) / 1e6;
}

export function recommendations(usage, catalog, opts = {}) {
  const reasoningOnly = opts.reasoningOnly !== false; // default: prefer reasoning capable
  const out = [];
  const byId = new Map(catalog.map(m => [m.id, m]));
  for (const a of usage) {
    const cur = byId.get(a.model);
    const hit = hitRate(a);
    const currentCost = candidateCost(a, hit, cur) ?? a.spend;
    const candidates = catalog
      .filter(m => m.id !== a.model && !m.id.includes(':free'))
      .map(m => {
        const cost = candidateCost(a, hit, m);
        if (cost == null) return null;
        // reasoning requirement: if reasoningOnly and current reasons, candidate must reason too
        const qualifies = !(reasoningOnly && cur && cur.reasoning && !m.reasoning);
        return { model: m, cost, qualifies, ctx: m.context_length || 0, reasoning: !!m.reasoning };
      })
      .filter(Boolean)
      .filter(c => c.qualifies && c.cost < currentCost)
      .sort((x, y) => x.cost - y.cost);

    if (candidates.length === 0) continue;
    const best = candidates[0];
    out.push({
      current: a.model,
      currentCost,
      spend: a.spend,
      requests: a.requests,
      hitRate: hit,
      currentCacheRead: cur ? (Number(cur.pricing?.input_cache_read) * 1e6 || 0) : null,
      best: {
        model: best.model.id,
        cost: best.cost,
        ctx: best.ctx,
        reasoning: best.reasoning,
        cacheRead: Number(best.model.pricing?.input_cache_read) * 1e6 || 0,
        saving: currentCost - best.cost,
        savingPct: currentCost > 0 ? ((currentCost - best.cost) / currentCost) * 100 : 0,
      },
    });
  }
  return out.sort((x, y) => (y.best.saving) - (x.best.saving));
}
