const MAX_RECENT_CALLS = 200;
const TASK_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

let startedAt = new Date().toISOString();
let recent = [];
let totals = emptyTotals();
let byModel = new Map();

function emptyTotals() {
  return {
    calls: 0, succeeded: 0, failed: 0, cancelled: 0,
    inputChars: 0, outputChars: 0,
    estimatedInputTokens: 0, estimatedOutputTokens: 0,
    providerInputTokens: 0, providerOutputTokens: 0, providerUsageCalls: 0,
    billingInputTokens: 0, billingOutputTokens: 0,
    durationMs: 0,
  };
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cleanCode(value) {
  const code = String(value ?? '').split(':', 1)[0].trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : '';
}

export function recordLlmUsage({
  task = 'unknown', provider = '', model = '', status = 'failed', errorCode = '',
  inputChars = 0, outputChars = 0,
  estimatedInputTokens = 0, estimatedOutputTokens = 0,
  providerInputTokens = null, providerOutputTokens = null,
  durationMs = 0,
} = {}) {
  const normalizedStatus = ['success', 'failed', 'cancelled'].includes(status)
    ? status : 'failed';
  const entry = {
    at: new Date().toISOString(),
    task: TASK_PATTERN.test(task) ? task : 'unknown',
    provider: typeof provider === 'string' ? provider.slice(0, 2_048) : '',
    model: typeof model === 'string' ? model.slice(0, 256) : '',
    status: normalizedStatus,
    errorCode: normalizedStatus === 'success' ? '' : cleanCode(errorCode),
    inputChars: safeInteger(inputChars),
    outputChars: safeInteger(outputChars),
    estimatedInputTokens: safeInteger(estimatedInputTokens),
    estimatedOutputTokens: safeInteger(estimatedOutputTokens),
    providerInputTokens: Number.isSafeInteger(providerInputTokens) && providerInputTokens >= 0
      ? providerInputTokens : null,
    providerOutputTokens: Number.isSafeInteger(providerOutputTokens) && providerOutputTokens >= 0
      ? providerOutputTokens : null,
    durationMs: safeInteger(durationMs),
  };
  entry.billingInputTokens = entry.providerInputTokens ?? entry.estimatedInputTokens;
  entry.billingOutputTokens = entry.providerOutputTokens ?? entry.estimatedOutputTokens;
  const modelName = entry.model || '（未命名模型）';
  const modelKey = JSON.stringify([entry.provider, modelName]);
  const modelTotals = byModel.get(modelKey) ?? {
    key: modelKey, provider: entry.provider, model: modelName, ...emptyTotals(),
  };
  totals.calls += 1;
  totals[normalizedStatus === 'success' ? 'succeeded'
    : normalizedStatus === 'cancelled' ? 'cancelled' : 'failed'] += 1;
  totals.inputChars += entry.inputChars;
  totals.outputChars += entry.outputChars;
  totals.estimatedInputTokens += entry.estimatedInputTokens;
  totals.estimatedOutputTokens += entry.estimatedOutputTokens;
  if (entry.providerInputTokens !== null || entry.providerOutputTokens !== null) {
    totals.providerUsageCalls += 1;
    totals.providerInputTokens += entry.providerInputTokens ?? 0;
    totals.providerOutputTokens += entry.providerOutputTokens ?? 0;
  }
  totals.billingInputTokens += entry.billingInputTokens;
  totals.billingOutputTokens += entry.billingOutputTokens;
  totals.durationMs += entry.durationMs;

  modelTotals.calls += 1;
  modelTotals[normalizedStatus === 'success' ? 'succeeded'
    : normalizedStatus === 'cancelled' ? 'cancelled' : 'failed'] += 1;
  for (const field of [
    'inputChars', 'outputChars', 'estimatedInputTokens', 'estimatedOutputTokens',
    'billingInputTokens', 'billingOutputTokens', 'durationMs',
  ]) modelTotals[field] += entry[field];
  if (entry.providerInputTokens !== null || entry.providerOutputTokens !== null) {
    modelTotals.providerUsageCalls += 1;
    modelTotals.providerInputTokens += entry.providerInputTokens ?? 0;
    modelTotals.providerOutputTokens += entry.providerOutputTokens ?? 0;
  }
  byModel.set(modelKey, modelTotals);
  recent.push(entry);
  if (recent.length > MAX_RECENT_CALLS) recent = recent.slice(-MAX_RECENT_CALLS);
  return entry;
}

export function llmUsageSnapshot() {
  return {
    startedAt,
    totals: { ...totals },
    models: [...byModel.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => right.billingInputTokens + right.billingOutputTokens
        - left.billingInputTokens - left.billingOutputTokens
        || left.provider.localeCompare(right.provider)
        || left.model.localeCompare(right.model)),
    recent: recent.map((entry) => ({ ...entry })),
    note: 'estimated*Tokens 是本地近似；provider*Tokens 仅在兼容服务主动返回 usage 时记录，二者都不等于实际费用。',
  };
}

export function resetLlmUsageForTests() {
  startedAt = new Date().toISOString();
  recent = [];
  totals = emptyTotals();
  byModel = new Map();
}
