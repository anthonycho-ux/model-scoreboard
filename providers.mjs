// providers.mjs - provider adapters for the fleet simulation.
// Every adapter must return ACTUAL billed data where the provider exposes it,
// and an honest "flat fee / not measurable per model" marker where it does not.
// Never invent a per-token number for a subscription provider.

// Nous Portal: real per-model usage from the exported CSV (exact tokens + dollars).
export function nousProvider(usageByModel) {
  const models = usageByModel.map(u => ({
    model: u.model,
    cost: u.spend,
    requests: u.requests,
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    hitRate: u.input > 0 ? u.cacheRead / u.input : 0,
  }));
  const total = models.reduce((s, m) => s + m.cost, 0);
  return {
    id: 'nous-portal',
    name: 'Nous Portal',
    costModel: 'per-model',
    measurable: true,
    note: 'Actual billed usage from the exported CSV.',
    totalCost: total,
    models,
  };
}

// Command Code: real per-request cost exists in Studio /usage but requires login.
// Adapter ready; data is only available once a logged-in session is supplied.
export function commandCodeProvider(opts = {}) {
  return {
    id: 'commandcode',
    name: 'Command Code',
    costModel: 'per-request',
    measurable: opts.loggedIn === true,
    note: opts.loggedIn
      ? 'Actual per-request cost from Studio usage.'
      : 'Per-request cost exists in Studio /usage but needs a logged-in session to pull. No number invented.',
    totalCost: opts.loggedIn ? (opts.totalCost ?? null) : null,
    models: opts.models ?? [],
  };
}

// Grok: flat subscription. No per-model metering exposed. Only the flat fee is real.
export function grokProvider(opts = {}) {
  return {
    id: 'grok',
    name: 'Grok (xAI)',
    costModel: 'flat-subscription',
    measurable: false,
    flatFeeMonthly: opts.flatFeeMonthly ?? 9.9,
    note: 'SuperGrok flat subscription. Weekly usage cap, no per-model cost exposed. Only the flat fee is real.',
    totalCost: opts.flatFeeMonthly ?? 9.9,
    models: [],
  };
}

// Claude: flat subscription (Claude Max). No per-model metering exposed.
export function claudeProvider(opts = {}) {
  return {
    id: 'claude',
    name: 'Claude (Anthropic)',
    costModel: 'flat-subscription',
    measurable: false,
    flatFeeMonthly: opts.flatFeeMonthly ?? null,
    note: 'Claude Max flat subscription. Per-model cost is hidden inside a flat fee and not exposed. Not measurable per model.',
    totalCost: null,
    models: [],
  };
}

// Kimi: flat subscription; per-model API cost sits behind a paid wall.
export function kimiProvider(opts = {}) {
  return {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    costModel: 'flat-subscription',
    measurable: false,
    flatFeeMonthly: opts.flatFeeMonthly ?? null,
    note: 'Subscription-backed. Real per-model API cost appears only behind a paid wall. Not measurable per model from this surface.',
    totalCost: null,
    models: [],
  };
}

export function allProviders(usageByModel, opts = {}) {
  return [
    nousProvider(usageByModel),
    commandCodeProvider(opts.commandCode),
    grokProvider(opts.grok),
    claudeProvider(opts.claude),
    kimiProvider(opts.kimi),
  ];
}
