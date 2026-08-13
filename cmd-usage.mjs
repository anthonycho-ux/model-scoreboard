// cmd-usage.mjs - honest Command Code usage probe.
// Tries to read the logged-in Command Code session (auth.json from the CLI)
// and verify it against the live Provider API. Returns only real data:
//   - 200 -> the key works; models come from the live catalog.
//   - 401 -> key rejected; say so, do not invent numbers.
//   - 403 -> plan has no Provider API access; say so.
// Never fabricates per-request cost for a subscription or a stale session.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH = path.join(os.homedir(), '.commandcode', 'auth.json');
const MODELS_URL = 'https://api.commandcode.ai/provider/v1/models';

export async function commandCodeUsage() {
  if (!existsSync(AUTH)) {
    return {
      id: 'commandcode',
      name: 'Command Code',
      costModel: 'per-request',
      measurable: false,
      note: 'No Command Code login found. Per-request usage exists in Studio but needs a logged-in session. No number invented.',
      totalCost: null,
      models: [],
    };
  }
  let key = '';
  try {
    const auth = JSON.parse(await readFile(AUTH, 'utf8'));
    key = String(auth.apiKey || '');
  } catch {
    return {
      id: 'commandcode',
      name: 'Command Code',
      costModel: 'per-request',
      measurable: false,
      note: 'Command Code auth file is unreadable. No usage pulled. No number invented.',
      totalCost: null,
      models: [],
    };
  }
  if (!key) {
    return {
      id: 'commandcode',
      name: 'Command Code',
      costModel: 'per-request',
      measurable: false,
      note: 'Command Code auth file has no API key. No usage pulled. No number invented.',
      totalCost: null,
      models: [],
    };
  }
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    });
    if (res.status === 200) {
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const models = list.map(m => ({
        model: m.id || m.model || String(m),
        name: m.name || m.id || String(m),
        cost: null, // catalog prices are list prices, not this user's billed usage
        requests: null,
      }));
      return {
        id: 'commandcode',
        name: 'Command Code',
        costModel: 'per-request',
        measurable: true,
        note: 'Logged-in session verified against the live Provider API. Model list is real; billed per-request cost is pulled only where Studio exposes it.',
        totalCost: null,
        models,
      };
    }
    if (res.status === 403) {
      return {
        id: 'commandcode',
        name: 'Command Code',
        costModel: 'per-request',
        measurable: false,
        note: 'Command Code plan does not expose the Provider API usage surface. Only flat plan cost is real; no per-request number invented.',
        totalCost: null,
        models: [],
      };
    }
    return {
      id: 'commandcode',
      name: 'Command Code',
      costModel: 'per-request',
      measurable: false,
      note: 'Command Code API rejected the saved key (' + res.status + '). Re-login with cmd login, then the second real column fills. No number invented.',
      totalCost: null,
      models: [],
    };
  } catch (e) {
    return {
      id: 'commandcode',
      name: 'Command Code',
      costModel: 'per-request',
      measurable: false,
      note: 'Command Code usage probe failed to reach the API (' + e.message + '). No number invented.',
      totalCost: null,
      models: [],
    };
  }
}
