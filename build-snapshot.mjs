#!/usr/bin/env node
// Freeze the live board into docs/index.html for GitHub Pages.
// Live root index.html is left alone. Do not copy it onto docs/ by hand.
//
//   node build-snapshot.mjs              # pull from http://127.0.0.1:8347
//   node build-snapshot.mjs --from-tmp   # use /tmp/live-index.html + JSON
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FROM_TMP = process.argv.includes('--from-tmp');
const BASE = process.env.SCOREBOARD_URL || 'http://127.0.0.1:8347';
const DOCS = path.join(__dirname, 'docs');
const OUT = path.join(DOCS, 'index.html');

const LIVE_FETCH = `    const c=$('#cached').value,f=$('#fresh').value,o=$('#out').value,m=$('#metric').value;
    const r=await fetch('/api/scoreboard?cached='+c+'&fresh='+f+'&out='+o+'&metric='+m);
    if(!r.ok)throw 0;
    const d=await r.json();ROWS=d.rows||[];CHANGED_AT=d.lastChangedAt||d.fetchedAt||null;`;

const SNAP_LOAD = `    const c=$('#cached').value,f=$('#fresh').value,o=$('#out').value,m=$('#metric').value;
    const d=SNAPSHOT_DATA;
    ROWS=(d.rows||[]);CHANGED_AT=d.lastChangedAt||d.fetchedAt||null;
    NOUS_CAT={};(d.nousModels||[]).forEach(x=>{const k=normId(x.id);if(x.pricing)NOUS_CAT[k]=x.pricing;});
    CC_LIST=(d.ccModels||[]);`;

async function loadJson(url, tmpPath) {
  if (FROM_TMP) {
    return JSON.parse(await readFile(tmpPath, 'utf8'));
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  return r.json();
}

const html = FROM_TMP
  ? await readFile('/tmp/live-index.html', 'utf8')
  : await readFile(path.join(__dirname, 'index.html'), 'utf8');

if (!html.includes(LIVE_FETCH)) {
  throw new Error('index.html load() fetch block not found; refuse to guess a rewrite');
}
if (html.includes('const SNAPSHOT_DATA=')) {
  throw new Error('source HTML already has SNAPSHOT_DATA; use live index.html, not a previous snapshot');
}

const sb = await loadJson(BASE + '/api/scoreboard', '/tmp/sb.json');
const models = await loadJson(BASE + '/api/models', '/tmp/models.json');
const prov = await loadJson(BASE + '/api/providers', '/tmp/prov.json');

const rows = sb.rows || [];
if (!rows.length) throw new Error('scoreboard has 0 rows; refuse to write an empty snapshot');

const nousModels = (models.models || [])
  .filter(x => x && x.id && x.pricing)
  .map(x => ({ id: x.id, pricing: x.pricing }));
const ccModels = ((prov.providers && prov.providers[0] && prov.providers[0].models) || [])
  .map(m => m.model || m.id || '')
  .filter(Boolean);

const payload = {
  fetchedAt: sb.fetchedAt || null,
  lastChangedAt: sb.lastChangedAt || sb.fetchedAt || null,
  rows,
  nousModels,
  ccModels,
};

let out = html.replace(LIVE_FETCH, SNAP_LOAD);
if (out === html) throw new Error('load() rewrite did not apply');
if (out.includes("fetch('/api/scoreboard")) {
  throw new Error('output still fetches /api/scoreboard');
}

const marker = 'let ROWS=[],LANG=';
const idx = out.indexOf(marker);
if (idx < 0) throw new Error('let ROWS= marker not found');
out = out.slice(0, idx) + 'const SNAPSHOT_DATA=' + JSON.stringify(payload) + ';\n' + out.slice(idx);

if (!out.includes('const SNAPSHOT_DATA=')) throw new Error('SNAPSHOT_DATA missing after inject');
if (out.includes("fetch('/api/scoreboard")) throw new Error('fetch leaked back after inject');

await mkdir(DOCS, { recursive: true });
await writeFile(path.join(DOCS, '.nojekyll'), '');
await writeFile(OUT, out);

console.log('wrote', path.relative(__dirname, OUT),
  'rows=' + rows.length,
  'nousModels=' + nousModels.length,
  'ccModels=' + ccModels.length,
  'fetchedAt=' + payload.fetchedAt,
  'bytes=' + Buffer.byteLength(out));
