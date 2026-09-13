import { describe, expect, it, vi } from 'vitest';
import {
  estimateCostsByCurrency, estimateModelCost, loadLlmPricing,
  normalizeLlmPricingCatalog, saveLlmPricing,
} from './llm-pricing';
import type { LlmUsageModel } from './types';

const usage: LlmUsageModel = {
  key: '["https://api.example/v1","writer"]',
  provider: 'https://api.example/v1', model: 'writer',
  calls: 1, succeeded: 1, failed: 0, cancelled: 0,
  inputChars: 100, outputChars: 200,
  estimatedInputTokens: 80, estimatedOutputTokens: 160,
  providerInputTokens: 70, providerOutputTokens: 150, providerUsageCalls: 1,
  billingInputTokens: 70, billingOutputTokens: 150, durationMs: 100,
};

describe('LLM pricing', () => {
  it('按每百万输入输出 token 计算模型费用', () => {
    expect(estimateModelCost(usage, {
      currency: 'USD', inputPerMillion: 1, outputPerMillion: 2,
    })).toBeCloseTo(0.00037);
    expect(estimateCostsByCurrency([usage], {
      '["https://api.example/v1","writer"]': {
        currency: 'USD', inputPerMillion: 1, outputPerMillion: 2,
      },
    })).toEqual({ totals: { CNY: 0, USD: 0.00037 }, pricedModels: 1, unpricedModels: 0 });
  });

  it('同名模型在不同服务地址下可以使用不同价格', () => {
    const second = {
      ...usage, key: '["https://other.example/v1","writer"]',
      provider: 'https://other.example/v1', billingInputTokens: 100,
      billingOutputTokens: 200,
    };
    const costs = estimateCostsByCurrency([usage, second], {
      '["https://api.example/v1","writer"]': {
        currency: 'USD', inputPerMillion: 1, outputPerMillion: 2,
      },
      '["https://other.example/v1","writer"]': {
        currency: 'CNY', inputPerMillion: 3, outputPerMillion: 4,
      },
    });
    expect(costs.pricedModels).toBe(2);
    expect(costs.totals.USD).toBeCloseTo(0.00037);
    expect(costs.totals.CNY).toBeCloseTo(0.0011);
  });

  it('清理非法价格并安全读写浏览器本地配置', () => {
    expect(normalizeLlmPricingCatalog({
      writer: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 },
      bad: { currency: 'BTC', inputPerMillion: -1, outputPerMillion: 2 },
    })).toEqual({ writer: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 } });
    const storage = { getItem: vi.fn(() => '{bad'), setItem: vi.fn() };
    expect(loadLlmPricing(storage)).toEqual({});
    expect(saveLlmPricing({
      writer: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 },
    }, storage)).toEqual({
      writer: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 },
    });
    expect(storage.setItem).toHaveBeenCalledOnce();
  });
});
