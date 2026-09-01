// live-data.mjs - live provider data feed for the Model Scoreboard.
// No local cache files, no exported CSVs, no hand-maintained deal files.
// Everything is pulled from the providers directly at refresh time:
//   - model catalog + benchmarks + prices:  Nous Portal API (live)
//   - Command Code model list:              CC Provider API (live)
//   - CC pricing + deals:                   official CC pricing page (live, parsed server-side)
//   - CC usage + credits + plan:            CC Provider API alpha endpoints (live)
//
// The board's deal overlay is DERIVED, not maintained: the official pricing
// page carries per-model list rates, deal objects (discount %, expiry, free)
// and per-model per-plan credit budgets. The GOAT credit multiplier
// (list rate / plan multiplier) reproduces the effective CC rates exactly.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH = path.join(os.homedir(), '.commandcode', 'auth.json');
const CC_API = 'https://api.commandcode.ai';
const PRICING_URL = 'https://commandcode.ai/docs/resources/pricing-limits';
// individual-goat plan: USD 10/mo. Used with the page's planBudgetUsd to
// derive the GOAT multiplier: effective = list rate * (planPrice / budget).
const GOAT_PLAN_PRICE = 10;

let cachedKey = null;
let keyError = null;

async function ccKey() {
  if (cachedKey) return cachedKey;
  if (keyError) throw keyError;
  if (!existsSync(AUTH)) {
    keyError = new Error('No Command Code auth.json - cannot fetch live CC data');
    throw keyError;
  }
  try {
    const auth = JSON.parse(await readFile(AUTH, 'utf8'));
    cachedKey = String(auth.apiKey || '');
    if (!cachedKey) { keyError = new Error('Command Code auth.json has no apiKey'); throw keyError; }
    return cachedKey;
  } catch (e) {
    keyError = e;
    throw e;
  }
}

async function ccGet(route) {
  const key = await ccKey();
  const res = await fetch(CC_API + route, {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('CC API ' + route + ' -> ' + res.status);
  const json = await res.json();
  if (json && json.success === false) throw new Error('CC API ' + route + ' error: ' + (json.error?.message || res.status));
  return json;
}

// ---- whoami / credits / subscription / usage summary ----

export async function ccWhoami() {
  return (await ccGet('/alpha/whoami')) || {};
}

export async function ccCredits() {
  const j = await ccGet('/alpha/billing/credits');
  return j?.credits || null;
}

export async function ccSubscriptions() {
  const j = await ccGet('/alpha/billing/subscriptions');
  return j?.data || null;
}

// Aggregate usage for the current billing period. Live requests, tokens,
// cost from the provider's own accounting, no local export involved.
export async function ccUsageSummary() {
  const j = await ccGet('/alpha/usage/summary');
  return j || null;
}

// ---- official CC pricing page -> rows + models (parsed server-side) ----

let pricingCache = { data: null, ts: 0 };
const PRICING_TTL = 120_000; // re-fetch the official page at most every 2 min

function findRscJson(str, key) {
  const i = str.indexOf('{"' + key + '":[');
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < str.length; j++) {
    const c = str[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return str.slice(i, j + 1); }
  }
  return null;
}

async function fetchPricingPage() {
  if (pricingCache.data && Date.now() - pricingCache.ts < PRICING_TTL) return pricingCache.data;
  const res = await fetch(PRICING_URL, { headers: { 'User-Agent': 'model-scoreboard/1.0 (Aside)' } });
  if (!res.ok) throw new Error('CC pricing page -> ' + res.status);
  const html = await res.text();
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  let models = null;
  let rows = null;
  while ((m = re.exec(html))) {
    let payload;
    try { payload = JSON.parse('"' + m[1] + '"'); } catch { continue; }
    const modelsBlock = findRscJson(payload, 'models');
    const rowsBlock = findRscJson(payload, 'rows');
    if (modelsBlock && !models) {
      try {
        const parsed = JSON.parse(modelsBlock);
        if (parsed.models && parsed.models.length > 40) models = parsed.models;
      } catch {}
    }
    if (rowsBlock && !rows) {
      try {
        const parsed = JSON.parse(rowsBlock);
        if (parsed.rows && parsed.rows.length > 40 && parsed.rows[0]?.tiers) rows = parsed.rows;
      } catch {}
    }
    if (models && rows) break;
  }
  if (!rows) throw new Error('Could not parse official CC pricing page (rows not found)');
  pricingCache = { data: { models: models || [], rows }, ts: Date.now() };
  return pricingCache.data;
}

// ---- base list rates: every priced model on the official page, no overlay ----
// The prize for CC-only rows without a deal: effective rate = official list rate.
let baseCache = { map: null, ts: 0 };
export async function pricingBase() {
  if (baseCache.map && Date.now() - baseCache.ts < PRICING_TTL) return baseCache.map;
  const pricing = await fetchPricingPage();
  const norm = s => String(s || '').toLowerCase().split('/').pop().replace(/_/g, '-');
  const canon = s => String(s || '').toLowerCase().replace(/[._-]/g, '');
  // Explicit CC-catalog-id -> pricing-page-id pairs that separator collapsing
  // cannot reconcile (date stamps, preview suffixes).
  const PRICE_ALIAS = {
    'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
    'qwen3-6-max-preview': 'qwen-3-6-max',
  };
  const map = new Map();
  for (const row of pricing.rows) {
    const rates = row.tiers?.[0]?.rates || {};
    if (rates.input == null || rates.output == null || rates.cacheRead == null) continue;
    // Key by both the raw normalized id and the canonical separator-free form,
    // because the pricing page and the CC catalog disagree on separators
    // (qwen-3.8-flash vs qwen3.8-flash, grok-4.6 vs grok-4-6).
    map.set(norm(row.id), { input: rates.input, output: rates.output, cacheRead: rates.cacheRead });
    map.set(canon(row.id), { input: rates.input, output: rates.output, cacheRead: rates.cacheRead });
  }
  for (const [ccAlias, priceId] of Object.entries(PRICE_ALIAS)) {
    const rates = map.get(canon(priceId)) || map.get(priceId);
    if (rates) map.set(canon(ccAlias), rates);
  }
  baseCache = { map, ts: Date.now() };
  return baseCache.map;
}

// ---- deal derivation ----
// Effective CC rate per 1M USD = page list rate * (planPrice / planBudgetUsd[plan]).
// Free deals -> 0. Explicit deal objects (discount %, expiry) are carried
// through for labels and expiry dates. Expired deals are dropped.
export async function deriveDeals() {
  const [pricing, sub] = await Promise.all([fetchPricingPage(), ccSubscriptions()]);
  const planId = sub?.planId || 'individual-goat';
  const planKey = planId.includes('goat') ? 'goat' : planId.includes('pro') ? 'pro' : 'go';
  const now = Date.now();
  const norm = s => String(s || '').toLowerCase().split('/').pop().replace(/_/g, '-');
  const deals = [];
  for (const row of pricing.rows) {
    const base = row.tiers?.[0]?.rates || {};
    if (base.input == null || base.output == null || base.cacheRead == null) continue;
    const model = pricing.models.find(mm => mm.id === row.id);
    const budget = model?.planBudgetUsd?.[planKey];
    const multiplier = budget ? GOAT_PLAN_PRICE / budget : 1;
    const deal = row.deal || null;
    // expiry handling: page expiry (ISO or date) or endsWhen (textual)
    let expiry = null;
    if (deal?.expires) expiry = deal.expires;
    else if (deal?.endsWhen && !/capacity|forever/i.test(deal.endsWhen)) expiry = deal.endsWhen;
    if (expiry) {
      const t = Date.parse(expiry);
      if (!Number.isNaN(t) && t < now) continue; // expired, drop
    }
    const free = !!deal?.free || base.input === 0;
    const input = free ? 0 : Math.round(base.input * multiplier * 1e4) / 1e4;
    const output = free ? 0 : Math.round(base.output * multiplier * 1e4) / 1e4;
    const cacheRead = free ? 0 : Math.round(base.cacheRead * multiplier * 1e4) / 1e4;
    let label;
    if (free) label = 'FREE';
    else if (deal?.discountPercent) label = '-' + deal.discountPercent + '%';
    else if (multiplier !== 1) label = Math.round(1 / multiplier) + 'x CC';
    else continue; // no deal, no multiplier: nothing to overlay
    deals.push({
      ids: [row.id, norm(row.id)],
      label,
      prompt: input,
      completion: output,
      cacheRead,
      expiry: expiry || null,
      note: [deal?.revertNote, deal?.endsWhen ? 'ends ' + deal.endsWhen : null].filter(Boolean).join(' · ') || null,
    });
  }
  return deals;
}

// ---- live real-mix profile ----
// Requests/week come live from the provider's billing-period usage summary.
// The per-request token shape uses the board's documented default mix
// (the same 80/4/4 cost assumptions shown in the UI footer), because the
// provider's aggregate API does not expose a per-model cache/fresh split.
export async function liveRealMix() {
  const [summary, sub] = await Promise.all([ccUsageSummary().catch(() => null), ccSubscriptions().catch(() => null)]);
  if (!summary || !summary.totalCount) return null;
  const periodDays = 31;
  const reqPerWeek = Math.round(summary.totalCount * 7 / periodDays);
  return {
    reqPerWeek,
    cachePerReq: 80_000,
    freshPerReq: 4_000,
    outPerReq: 4_000,
    liveVolume: true,
    source: 'live CC usage summary (billing period)',
  };
}

// ---- one-shot everything for /api/providers and /api/usage ----
export async function ccLiveSnapshot() {
  const [whoami, credits, sub, summary] = await Promise.all([
    ccWhoami().catch(() => null),
    ccCredits().catch(() => null),
    ccSubscriptions().catch(() => null),
    ccUsageSummary().catch(() => null),
  ]);
  return { whoami, credits, sub, summary, fetchedAt: new Date().toISOString() };
}
