// aa-data.mjs - live Artificial Analysis benchmark feed for Command Code-only models.
// The AA leaderboard page embeds the full model dataset (intelligence/coding/agentic
// indices, 0-100) in its React Server Components payload. We fetch that page, parse
// the payload, and resolve the Command Code catalog ids that the Nous catalog does
// not carry. Same live-fetch pattern as the CC pricing page: in-memory TTL cache,
// no files, no keys. No score is invented; values are read directly from AA records.
//
// Resolved model ids map to AA slugs via the ALIAS map. Selection inside a slug
// group prefers non-estimated records, then highest intelligence index.
// Origin: 2026-08-31, mission to score all CC models (20 of 22 resolvable; the
// remaining are simply absent from AA and stay unscored).

const LEADERBOARD_URL = 'https://artificialanalysis.ai/leaderboards/models';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0';
const TTL = 6 * 60 * 60 * 1000; // AA republishes data at most daily; 6h is plenty

// Command Code catalog id (any separator form) -> AA leaderboard slug.
// Grounded in the live AA embedded dataset, verified 2026-08-31. Lookup is
// canonical: separators are collapsed, so dotted and dashed catalog ids match.
const ALIAS = {
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-fable-5': 'claude-fable-5',
  'claude-opus-5': 'claude-opus-5',
  'claude-haiku-4-5-20251001': 'claude-4-5-haiku-reasoning',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-8': 'claude-opus-4-8',
  'gpt-5-3-codex': 'gpt-5-3-codex',
  'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash-vision',
  'deepseek-v4-flash-fast': 'deepseek-v4-flash',
  'kimi-k3': 'kimi-k3',
  'kimi-k2-7-code-highspeed': 'kimi-k2-7-code',
  'glm-5-2': 'glm-5-2',
  'glm-5-2-fast': 'glm-5-2',
  'glm-5': 'glm-5',
  'minimax-m2-5': 'minimax-m2-5',
  'qwen3-8-flash': 'qwen3-8-flash-next',
  'qwen3-6-max-preview': 'qwen3-6-max',
  'qwen3-6-plus': 'qwen3-6-plus',
  'step-3-5-flash': 'step-3-5-flash',
  'gemini-3-1-flash-lite': 'gemini-3-1-flash-lite-preview',
  'muse-spark-1-1': 'muse-spark-1-1',
  'muse-spark-1-2-contributor': 'muse-spark-1-2',
  'hy3-paid': 'hy3',
  'grok-4-5': 'grok-4-5',
  'grok-4-6': 'grok-4-6',
};
const canon = s => String(s || '').toLowerCase().replace(/[._-]/g, '');
const ALIAS_LOOKUP = new Map(Object.entries(ALIAS).map(([k, v]) => [canon(k), v]));
// Exported for the regression test (test-aa.mjs): the aliased catalog ids.
export const AA_ALIAS_IDS = Object.keys(ALIAS);

let cache = { records: null, bySlug: null, ts: 0 };

function parsePayload(html) {
  let data = '';
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    let s = m[1];
    s = s.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')
      .replace(/\\u0027/g, "'").replace(/\\u0022/g, '"').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    data += s;
  }
  const records = [];
  const recRe = /\{"id":"[0-9a-f]{8}-[0-9a-f-]{20,36}","name":"/g;
  let rm;
  while ((rm = recRe.exec(data))) {
    const seg = data.slice(rm.index, rm.index + 5000);
    const g = f => { const r = seg.match(new RegExp('"' + f + '":("(?:\\\\.|[^"\\\\])*"|true|false|null|-?\\d+(?:\\.\\d+)?)')); return r ? r[1] : undefined; };
    try {
      const name = JSON.parse(g('name'));
      const slug = JSON.parse(g('slug'));
      const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      const intel = g('intelligenceIndex') === 'null' ? null : num(g('intelligenceIndex'));
      const coding = g('codingIndex') === 'null' ? null : num(g('codingIndex'));
      const agentic = g('agenticIndex') === 'null' ? null : num(g('agenticIndex'));
      const est = g('intelligenceIndexIsEstimated') === 'true';
      const rel = g('releaseDate') === 'null' || g('releaseDate') == null ? null : JSON.parse(g('releaseDate'));
      if (intel == null && coding == null && agentic == null) continue; // org/profile rows
      records.push({ name, slug, intelligence: intel, coding, agentic, estimated: est, releaseDate: rel });
    } catch { /* skip malformed segments */ }
  }
  return records;
}

async function snapshot() {
  if (cache.records && Date.now() - cache.ts < TTL) return cache;
  const res = await fetch(LEADERBOARD_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('Artificial Analysis leaderboard -> ' + res.status);
  const html = await res.text();
  const records = parsePayload(html);
  const bySlug = new Map();
  for (const r of records) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }
  cache = { records, bySlug, ts: Date.now() };
  return cache;
}

// Best record for a slug: prefer non-estimated, then highest intelligence.
function bestFor(records) {
  return [...records].sort((a, b) => (a.estimated ? 1 : 0) - (b.estimated ? 1 : 0) || (b.intelligence || 0) - (a.intelligence || 0))[0] || null;
}

// Resolve a Command Code catalog id (normalized form) to its AA indices.
// Returns null when the model has no AA record (missing, or no alias).
export async function aaScoreFor(normId) {
  const s = await snapshot();
  const slug = ALIAS_LOOKUP.get(canon(normId));
  if (!slug) return null;
  const group = s.bySlug.get(slug);
  if (!group || !group.length) return null;
  const rec = bestFor(group);
  if (!rec) return null;
  return {
    intelligence: rec.intelligence,
    coding: rec.coding,
    agentic: rec.agentic,
    estimated: rec.estimated,
    slug: rec.slug,
    name: rec.name,
    releaseDate: rec.releaseDate,
    fetchedAt: new Date(s.ts).toISOString(),
  };
}

export const aaAliasCount = Object.keys(ALIAS).length;
