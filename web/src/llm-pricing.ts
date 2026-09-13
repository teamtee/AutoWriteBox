import type { LlmUsageModel } from './types';

export type LlmPriceCurrency = 'CNY' | 'USD';
export interface LlmModelPrice {
  currency: LlmPriceCurrency;
  inputPerMillion: number;
  outputPerMillion: number;
}
export type LlmPricingCatalog = Record<string, LlmModelPrice>;

const STORAGE_KEY = 'novelbox.llm-pricing.v1';
const MAX_PRICE = 1_000_000;

function price(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= MAX_PRICE ? value : null;
}

export function normalizeLlmPricingCatalog(value: unknown): LlmPricingCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: LlmPricingCatalog = {};
  for (const [model, raw] of Object.entries(value)) {
    if (!model || model.length > 2_400 || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const inputPerMillion = price(item.inputPerMillion);
    const outputPerMillion = price(item.outputPerMillion);
    if (!['CNY', 'USD'].includes(String(item.currency))
      || inputPerMillion === null || outputPerMillion === null) continue;
    result[model] = {
      currency: item.currency as LlmPriceCurrency,
      inputPerMillion, outputPerMillion,
    };
  }
  return result;
}

export function loadLlmPricing(storage?: Pick<Storage, 'getItem'>) {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    const raw = target?.getItem(STORAGE_KEY);
    return raw ? normalizeLlmPricingCatalog(JSON.parse(raw)) : {};
  } catch { return {}; }
}

export function saveLlmPricing(
  catalog: LlmPricingCatalog,
  storage?: Pick<Storage, 'setItem'>,
) {
  const normalized = normalizeLlmPricingCatalog(catalog);
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    target?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
  catch { /* 浏览器禁用本地存储时仍允许只看用量 */ }
  return normalized;
}

export function llmPricingKey(usage: Pick<LlmUsageModel, 'key' | 'provider' | 'model'>) {
  return usage.key || JSON.stringify([usage.provider || '', usage.model]);
}

export function priceForUsage(usage: LlmUsageModel, catalog: LlmPricingCatalog) {
  return catalog[llmPricingKey(usage)] ?? catalog[usage.model];
}

export function estimateModelCost(usage: LlmUsageModel, priceConfig?: LlmModelPrice) {
  if (!priceConfig) return null;
  return (usage.billingInputTokens * priceConfig.inputPerMillion
    + usage.billingOutputTokens * priceConfig.outputPerMillion) / 1_000_000;
}

export function estimateCostsByCurrency(
  models: LlmUsageModel[], catalog: LlmPricingCatalog,
) {
  const totals: Record<LlmPriceCurrency, number> = { CNY: 0, USD: 0 };
  let pricedModels = 0;
  for (const usage of models) {
    const priceConfig = priceForUsage(usage, catalog);
    const cost = estimateModelCost(usage, priceConfig);
    if (cost === null) continue;
    totals[priceConfig.currency] += cost;
    pricedModels += 1;
  }
  return { totals, pricedModels, unpricedModels: models.length - pricedModels };
}
