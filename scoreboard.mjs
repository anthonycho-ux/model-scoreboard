// scoreboard.mjs - intelligence-per-cost ranking from the live catalog.
// Uses the catalog's artificial_analysis intelligence_index as the intelligence
// score, and the model's real per-call cost at the given token mix. No score is
// invented; models without a benchmark intelligence index are excluded.

const oneM = n => n == null ? null : (Number(n) * 1e6);

export function scoreboard(catalog, opts = {}) {
  const cachedK = opts.cachedK ?? 80;
  const freshK = opts.freshK ?? 4;
  const outK = opts.outK ?? 4;
  const rows = catalog.map(m => {
    const b = m.benchmarks?.artificial_analysis;
    if (!b || b.intelligence_index == null) return null;
    const p = m.pricing || {};
    const cr = oneM(p.input_cache_read);
    const pr = oneM(p.prompt);
    const co = oneM(p.completion);
    if (cr == null || pr == null || co == null) return null;
    const cost = (cachedK * cr + freshK * pr + outK * co) / 1000;
    const free = cost === 0;
    return {
      id: m.id,
      name: m.name,
      intelligence: b.intelligence_index,
      coding: b.coding_index ?? null,
      cost,
      ratio: free ? null : (b.intelligence_index / cost),
      ctx: m.context_length || 0,
      reasoning: !!m.reasoning,
      cacheRead: cr,
      free,
    };
  }).filter(Boolean);
  return rows;
}
