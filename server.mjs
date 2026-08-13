// Nous Portal dashboard - local server
// Holds the API key server-side, proxies the live catalog, serves an interactive dashboard.
// Run:  NOUS_API_KEY="sk-nous-..." node server.mjs  (defaults to localhost:8347)
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseUsageCSV, usageByModel, recommendations } from './usage.mjs';
import { allProviders } from './providers.mjs';
import { commandCodeUsage } from './cmd-usage.mjs';
import { scoreboard } from './scoreboard.mjs';

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

let usageRowsCache = { data: null, ts: 0 };
const USAGE_TTL = 120_000;
async function getUsageRows() {
  if (usageRowsCache.data && Date.now() - usageRowsCache.ts < USAGE_TTL) return usageRowsCache.data;
  const text = await readFile(path.join(__dirname, 'usage.csv'), 'utf8');
  const rows = parseUsageCSV(text);
  usageRowsCache = { data: rows, ts: Date.now() };
  return rows;
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
      const rows = await getUsageRows();
      const usage = usageByModel(rows);
      const cmdUsage = await commandCodeUsage();
      const provs = allProviders(usage, {
        grok: { flatFeeMonthly: 9.9 },
        commandCode: cmdUsage,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers: provs }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/scoreboard') {
    try {
      const catalog = await getCatalog();
      const cachedK = Number(url.searchParams.get('cached')) || 80;
      const freshK = Number(url.searchParams.get('fresh')) || 4;
      const outK = Number(url.searchParams.get('out')) || 4;
      const metric = url.searchParams.get('metric') || 'intelligence';
      const rows = scoreboard(catalog, { cachedK, freshK, outK, metric });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: rows.length, rows }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/usage') {
    try {
      const rows = await getUsageRows();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(usageByModel(rows)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/recommend') {
    try {
      const [catalog, rows] = await Promise.all([getCatalog(), getUsageRows()]);
      const usage = usageByModel(rows);
      const reasoningOnly = url.searchParams.get('reasoning') !== 'off';
      const recs = recommendations(usage, catalog, { reasoningOnly });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ usage, recs }));
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
