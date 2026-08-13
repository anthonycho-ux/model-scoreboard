// Nous Portal dashboard - local server
// Holds the API key server-side, proxies the live catalog, serves an interactive dashboard.
// Run:  NOUS_API_KEY="sk-nous-..." node server.mjs  (defaults to localhost:8347)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseUsageCSV, usageByModel, recommendations } from './usage.mjs';

const PORT = Number(process.env.PORT || 8347);
const API = 'https://inference-api.nousresearch.com/v1';
const KEY = process.env.NOUS_API_KEY || process.env.API_KEY || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
