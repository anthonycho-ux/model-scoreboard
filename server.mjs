// Model Scoreboard - local server
// Holds the API key server-side, proxies the live provider catalog, serves an interactive dashboard.
// All data comes from live provider APIs at refresh time - no local cache files:
//   catalog/benchmarks/prices from Nous Portal API, CC pricing+deals+usage from Command Code's
//   official API and pricing page (parsed server-side in live-data.mjs).
// Run:  NOUS_API_KEY="sk-nous-..." node server.mjs  (defaults to localhost:8347)
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { commandCodeUsage } from './cmd-usage.mjs';
import { scoreboard } from './scoreboard.mjs';
import { aaScoreFor } from './aa-data.mjs';
import { pricingBase } from './live-data.mjs';
import { deriveDeals, liveRealMix, ccLiveSnapshot } from './live-data.mjs';

const PORT = Number(process.env.PORT || 8347);
const API = 'https://inference-api.nousresearch.com/v1';
const KEY = process.env.NOUS_API_KEY || process.env.API_KEY || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Aside routing config: the local file that decides which model new Aside
// sessions use. The apply feature writes here, gated by a confirm step.
const ASIDE_SETTINGS = path.join(os.homedir(), '.aside', 'u', '0', 'settings.json');

// Cache the catalog briefly so the dashboard isn't hammering the API on every render.
let cache = { data: null, ts: 0 };
const TTL = Number(process.env.CACHE_TTL || 60_000);

// Persisted change watermark: bump only when providers change model set,
// prices, or deals — not on every poll. Benchmark score-only moves ignored.
const CHANGE_STATE = path.join(__dirname, '.catalog-change.json');

function priceSlice(p = {}) {
  const orig = p.original || {};
  return {
    prompt: p.prompt ?? null,
    completion: p.completion ?? null,
    cacheRead: p.input_cache_read ?? null,
    webSearch: p.web_search ?? null,
    origPrompt: orig.prompt ?? null,
    origCompletion: orig.completion ?? null,
    origCacheRead: orig.input_cache_read ?? null,
    origWebSearch: orig.web_search ?? null,
  };
}

function normModelId(s) {
  return String(s || '').toLowerCase().split('/').pop().replace(/_/g, '-');
}

function buildChangeFingerprint(catalog, commandCodeIds = []) {
  const cc = new Set((commandCodeIds || []).map(normModelId));
  const rows = (catalog || []).map(m => {
    const id = String(m.id || '');
    return { id, pricing: priceSlice(m.pricing || {}), cc: cc.has(normModelId(id)) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function trackCatalogChange(catalog, commandCodeIds) {
  const fingerprint = buildChangeFingerprint(catalog, commandCodeIds);
  const fetchedAt = catalogFetchedAt();
  let prev = null;
  if (existsSync(CHANGE_STATE)) {
    try { prev = JSON.parse(await readFile(CHANGE_STATE, 'utf8')); } catch { prev = null; }
  }
  if (prev && prev.fingerprint === fingerprint && prev.lastChangedAt) {
    return { lastChangedAt: prev.lastChangedAt, fingerprint, changed: false, fetchedAt };
  }
  const lastChangedAt = fetchedAt || new Date().toISOString();
  const next = { fingerprint, lastChangedAt, updatedAt: new Date().toISOString() };
  const tmp = CHANGE_STATE + '.tmp-' + Date.now();
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, CHANGE_STATE);
  return { lastChangedAt, fingerprint, changed: !prev || prev.fingerprint !== fingerprint, fetchedAt };
}

async function getCatalog() {
  if (cache.data && Date.now() - cache.ts < TTL) return cache.data;
  const res = await fetch(API + '/models', {
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('catalog fetch failed: ' + res.status);
  const json = await res.json();
  cache = { data: json.data || [], ts: Date.now() };
  return cache.data;
}

function catalogFetchedAt() {
  return cache.ts ? new Date(cache.ts).toISOString() : null;
}

// ---- Yes-gate apply: one pending apply at a time, must be confirmed ----
let pendingApply = null; // { token, model, cost, score, metric, ts }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readAsideSettings() {
  if (!existsSync(ASIDE_SETTINGS)) return null;
  try {
    return JSON.parse(await readFile(ASIDE_SETTINGS, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAsideSettings(settings) {
  // Atomic write: tmp + rename so a crash never leaves a half-written file.
  const tmp = ASIDE_SETTINGS + '.tmp-' + Date.now();
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, ASIDE_SETTINGS);
}

async function backupAsideSettings() {
  const backupDir = path.join(os.homedir(), '.aside', 'backups', 'nous-apply');
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, 'settings-' + stamp + '.json');
  if (existsSync(ASIDE_SETTINGS)) {
    await writeFile(dest, await readFile(ASIDE_SETTINGS, 'utf8'), { mode: 0o600 });
  }
  return dest;
}

// How the applied model shows up in the response. Never writes cost numbers
// that did not come from the live catalog pricing.
function describeModel(m, metric, rows) {
  const row = (rows || []).find(r => r.id === m.id);
  return {
    id: m.id,
    name: m.name,
    reasoning: !!m.reasoning,
    ctx: m.context_length || 0,
    metric: metric || 'intelligence',
    cost: row ? row.cost : null,
    ratio: row ? row.ratio : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/api/models') {
    try {
      const data = await getCatalog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: data.length, fetchedAt: new Date().toISOString(), models: data }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/providers') {
    try {
      const [cmdUsage, live] = await Promise.all([commandCodeUsage(), ccLiveSnapshot()]);
      const providers = [
        {
          id: 'commandcode',
          name: 'Command Code',
          costModel: cmdUsage.measurable ? 'per-request' : 'subscription',
          measurable: cmdUsage.measurable,
          note: cmdUsage.note || 'Live from the Command Code Provider API.',
          totalCost: null,
          credits: live.credits || null,
          plan: live.sub ? { planId: live.sub.planId, status: live.sub.status, cancelAtPeriodEnd: !!live.sub.cancelAtPeriodEnd } : null,
          usageSummary: live.summary ? {
            count: live.summary.totalCount,
            cost: live.summary.totalCost,
            tokensIn: live.summary.totalTokensIn,
            tokensOut: live.summary.totalTokensOut,
            successRate: live.summary.successRate,
          } : null,
          models: cmdUsage.models || [],
        },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers, fetchedAt: live.fetchedAt }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/scoreboard') {
    try {
      const [catalog, cmd] = await Promise.all([getCatalog(), commandCodeUsage()]);
      const cachedK = Number(url.searchParams.get('cached')) || 80;
      const freshK = Number(url.searchParams.get('fresh')) || 4;
      const outK = Number(url.searchParams.get('out')) || 4;
      const metric = url.searchParams.get('metric') || 'intelligence';
      const commandCodeIds = (cmd.models || []).map(m => m.model);
      const [realMix, deals, baseRates] = await Promise.all([liveRealMix(), deriveDeals(), pricingBase()]);
      const rows = scoreboard(catalog, { cachedK, freshK, outK, metric, commandCodeIds, realMix, deals });
      // CC-only models: present in the Command Code provider API but absent from
      // the Nous catalog (no benchmark, so scoreboard() cannot row them). Merge
      // them as unscored rows when the live CC deal/pricing gives effective rates.
      const normM = s => String(s || '').toLowerCase().split('/').pop().replace(/_/g, '-');
      const canonM = s => normM(s).replace(/[._-]/g, '');
      // Row every CC model not already in the board: Nous-presence alone does not
      // score a model (its catalog entry may lack the AA benchmark triple), so
      // the exclusion must be rows-based, not catalog-presence-based.
      const ccOnlyIds = (cmd.models || []).map(m => m.model || m.id || '').filter(id => !rows.some(r => normM(r.id) === normM(id)));
      const dealFor = id => (deals || []).find(d => (d.ids || []).some(x => normM(x) === normM(id))) || null;
      for (const cid of ccOnlyIds) {
        if (rows.some(r => normM(r.id) === normM(cid))) continue;
        const dl = dealFor(cid);
        const br = baseRates.get(canonM(cid)) || baseRates.get(normM(cid));
        const effCr = dl && dl.cacheRead != null ? Number(dl.cacheRead) : (br ? Number(br.cacheRead) : null);
        const effPr = dl && dl.prompt != null ? Number(dl.prompt) : (br ? Number(br.input) : null);
        const effCo = dl && dl.completion != null ? Number(dl.completion) : (br ? Number(br.output) : null);
        if (effCr == null || effPr == null || effCo == null) continue; // no live CC pricing yet
        const cost = (cachedK * effCr + freshK * effPr + outK * effCo) / 1000;
        const weekCost = realMix ? realMix.reqPerWeek * (
          (effCr / 1e6) * realMix.cachePerReq + (effPr / 1e6) * realMix.freshPerReq + (effCo / 1e6) * realMix.outPerReq
        ) : null;
        const ccName = ((cmd.models || []).find(m => (m.model || m.id) === cid) || {}).name || cid;
        // CC-only benchmark: resolve Artificial Analysis indices live (aa-data.mjs).
        // No score is invented; models absent from AA stay unscored.
        const aa = await aaScoreFor(normM(cid));
        const aaScore = aa == null ? null : (metric === 'composite'
          ? (aa.intelligence != null && aa.coding != null && aa.agentic != null ? (aa.intelligence + aa.coding + aa.agentic) / 3 : null)
          : (metric === 'coding' ? aa.coding : metric === 'agentic' ? aa.agentic : aa.intelligence));
        rows.push({
          id: cid, name: ccName, metric,
          intelligence: aa ? aa.intelligence : null,
          coding: aa ? aa.coding : null,
          agentic: aa ? aa.agentic : null,
          score: aaScore, cost, weekCost,
          ratio: aaScore != null && cost > 0 ? aaScore / cost : null,
          ctx: 0, reasoning: false,
          cacheRead: effCr, free: cost === 0,
          deal: dl ? { label: dl.label, expiry: dl.expiry || null, note: dl.note || null } : null,
          provider: 'commandcode', sources: ['commandcode'], weekReq: realMix ? realMix.reqPerWeek : null,
          ccOnly: true,
          bench: aa ? { source: 'Artificial Analysis (live leaderboard)', slug: aa.slug, name: aa.name, estimated: aa.estimated, releaseDate: aa.releaseDate, fetchedAt: aa.fetchedAt } : null,
        });
      }
      const ccScored = rows.filter(r => (r.sources || []).includes('commandcode') && r.score != null).length;
      const change = await trackCatalogChange(catalog, commandCodeIds);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        count: rows.length,
        lastChangedAt: change.lastChangedAt,
        fetchedAt: change.fetchedAt,
        changed: change.changed,
        commandCode: { live: commandCodeIds.length, scored: ccScored, measurable: !!cmd.measurable },
        realMix,
        deals: deals.length,
        dataSource: 'live providers (Nous catalog API + Command Code API/pricing page + Artificial Analysis leaderboard for CC-only models); no local cache',
        rows,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/usage') {
    try {
      const live = await ccLiveSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        source: 'live Command Code usage summary (no local export)',
        summary: live.summary,
        credits: live.credits,
        plan: live.sub ? { planId: live.sub.planId, cancelAtPeriodEnd: !!live.sub.cancelAtPeriodEnd, currentPeriodEnd: live.sub.currentPeriodEnd } : null,
        fetchedAt: live.fetchedAt,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/recommend') {
    try {
      const live = await ccLiveSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        usage: live.summary || null,
        note: 'Per-model usage is not exposed by the live provider API; use /api/scoreboard rows for the live-ranked table.',
        fetchedAt: live.fetchedAt,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- Yes-gate apply ----
  // GET /api/apply/status: what is the current Aside routing model?
  if (url.pathname === '/api/apply/status') {
    try {
      const settings = await readAsideSettings();
      const dm = settings?.defaultModel || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: !!dm,
        defaultModel: dm,
        pending: pendingApply ? {
          model: pendingApply.model.id,
          name: pendingApply.model.name,
          token: pendingApply.token,
          ts: pendingApply.ts,
        } : null,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/apply { model, metric }: stage a model to become the routing model.
  // This is the first half of the yes-gate: nothing is written yet, a token is
  // returned, and the change only lands on /api/apply/confirm with that token.
  if (url.pathname === '/api/apply' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const modelId = String(body.model || '').trim();
      if (!modelId) throw new Error('model id required');
      const catalog = await getCatalog();
      const m = catalog.find(x => x.id === modelId);
      if (!m) throw new Error('model not in live catalog: ' + modelId);
      const metric = String(body.metric || 'intelligence');
      const cachedK = Number(body.cached) || 80;
      const freshK = Number(body.fresh) || 4;
      const outK = Number(body.out) || 4;
      const rows = scoreboard(catalog, { cachedK, freshK, outK, metric });
      const row = rows.find(r => r.id === modelId);
      if (!row) throw new Error('model has no scored benchmark for ' + metric + ': ' + modelId);
      const token = 'ap-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      pendingApply = { token, model: m, cost: row.cost, ratio: row.ratio, score: row.score, metric, cachedK, freshK, outK, ts: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        token,
        model: describeModel(m, metric, rows),
        cost: row.cost,
        ratio: row.ratio,
        score: row.score,
        metric,
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/apply/confirm { token }: apply the staged model to Aside routing.
  // Writes only after the user approved; backs up the previous settings first.
  if (url.pathname === '/api/apply/confirm' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const token = String(body.token || '');
      if (!pendingApply || pendingApply.token !== token) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no pending apply for that token; stage a model first' }));
        return;
      }
      const staged = pendingApply;
      const settings = (await readAsideSettings()) || {};
      const backup = await backupAsideSettings();
      const prev = settings.defaultModel || null;
      settings.defaultModel = {
        provider: 'nous-portal',
        modelId: staged.model.id,
        thinkingLevel: settings.defaultModel?.thinkingLevel || 'medium',
        fastMode: settings.defaultModel?.fastMode || false,
      };
      await writeAsideSettings(settings);
      pendingApply = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        backup,
        previous: prev,
        applied: settings.defaultModel,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('index.html missing: ' + e.message);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Nous Portal dashboard: http://127.0.0.1:${PORT}`);
  console.log(`Key set: ${KEY ? 'yes' : 'NO - set NOUS_API_KEY'}`);
});
