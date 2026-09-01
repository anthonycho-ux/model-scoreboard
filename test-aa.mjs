import { aaScoreFor, AA_ALIAS_IDS } from './aa-data.mjs';

const TOL = 0.6;
const ABSENT = ['qwen3-7-flash', 'hy4-preview', 'fugu-ultra', 'laguna-s-2-1-free'];
const SPOT = [
  { id: 'grok-4-6', intelligence: 60.92, coding: 76.79, agentic: 58.68 },
  { id: 'claude-opus-5', intelligence: 63.05, coding: 77.98, agentic: 59.17 },
  { id: 'kimi-k3', intelligence: 59.70, coding: 76.24, agentic: 54.26 },
  { id: 'glm-5-2', intelligence: 52.64, coding: 68.76, agentic: 45.67 },
  { id: 'hy3-paid', intelligence: 42.2, coding: 58.8, agentic: 31.4 },
];

let total = 0;
let passed = 0;

function check(ok, msg) {
  total++;
  if (ok) {
    passed++;
    return;
  }
  console.log(msg);
}

function inRange(n) {
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

function within(got, want) {
  return Number.isFinite(got) && Math.abs(got - want) <= TOL;
}

async function main() {
  for (const id of AA_ALIAS_IDS) {
    const rec = await aaScoreFor(id);
    check(rec != null, `${id}: expected non-null, got ${rec}`);
    const intel = rec && rec.intelligence;
    check(inRange(intel), `${id}: intelligence ${intel} not in 0..100`);
  }

  for (const id of ABSENT) {
    const rec = await aaScoreFor(id);
    check(rec == null, `${id}: expected null, got ${JSON.stringify(rec)}`);
  }

  for (const row of SPOT) {
    const rec = await aaScoreFor(row.id);
    if (rec == null) {
      for (const key of ['intelligence', 'coding', 'agentic']) {
        check(false, `${row.id} ${key}: expected ${row[key]} ±${TOL}, got null`);
      }
      continue;
    }
    for (const key of ['intelligence', 'coding', 'agentic']) {
      check(
        within(rec[key], row[key]),
        `${row.id} ${key}: got ${rec[key]}, expected ${row[key]} ±${TOL}`,
      );
    }
  }

  const failed = total - passed;
  console.log(JSON.stringify({ total, passed, failed }));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.log(String(err && err.stack ? err.stack : err));
  const failed = Math.max(1, total - passed);
  console.log(JSON.stringify({ total, passed, failed }));
  process.exit(1);
});
