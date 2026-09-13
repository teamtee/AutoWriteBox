import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LlmPricingEditor, LlmUsageSummary } from './LlmUsagePanel';

describe('LlmUsageSummary', () => {
  it('只展示调用元数据和字符近似，不冒充供应商费用', () => {
    const html = renderToStaticMarkup(<LlmUsageSummary snapshot={{
      startedAt: '2026-08-26T00:00:00.000Z',
      totals: {
        calls: 2, succeeded: 1, failed: 1, cancelled: 0,
        inputChars: 1200, outputChars: 3000,
        estimatedInputTokens: 800, estimatedOutputTokens: 2500,
        providerInputTokens: 700, providerOutputTokens: 2400, providerUsageCalls: 1,
        billingInputTokens: 700, billingOutputTokens: 2400, durationMs: 470,
      },
      models: [{
        key: '["https://api.example/v1","writer"]',
        provider: 'https://api.example/v1', model: 'writer',
        calls: 1, succeeded: 1, failed: 0, cancelled: 0,
        inputChars: 1200, outputChars: 3000,
        estimatedInputTokens: 800, estimatedOutputTokens: 2500,
        providerInputTokens: 700, providerOutputTokens: 2400, providerUsageCalls: 1,
        billingInputTokens: 700, billingOutputTokens: 2400, durationMs: 450,
      }],
      recent: [{
        at: '2026-08-26T00:00:01.000Z', task: 'chapter-generate',
        provider: 'https://api.example/v1', model: 'writer',
        status: 'success', errorCode: '', inputChars: 1200, outputChars: 3000,
        estimatedInputTokens: 800, estimatedOutputTokens: 2500,
        providerInputTokens: 700, providerOutputTokens: 2400,
        billingInputTokens: 700, billingOutputTokens: 2400, durationMs: 450,
      }],
      note: '字符数是本地可审计近似值，不等于供应商 token 或实际费用。',
    }} />);
    expect(html).toContain('2</strong> 次调用');
    expect(html).toContain('1,200</strong> 输入字符');
    expect(html).toContain('3,300</strong> 本地估算 token');
    expect(html).toContain('3,100</strong> 供应商 token');
    expect(html).toContain('chapter-generate');
    expect(html).toContain('不等于供应商 token 或实际费用');
    expect(html).toContain('不包含提示词原文或 API Key');
    expect(html).not.toContain('sk-secret');
  });

  it('按模型价格显示会话费用，并明确未配置模型', () => {
    const model = {
      key: '["https://api.example/v1","writer"]',
      provider: 'https://api.example/v1', model: 'writer',
      calls: 1, succeeded: 1, failed: 0, cancelled: 0,
      inputChars: 100, outputChars: 200,
      estimatedInputTokens: 80, estimatedOutputTokens: 160,
      providerInputTokens: 70, providerOutputTokens: 150, providerUsageCalls: 1,
      billingInputTokens: 70, billingOutputTokens: 150, durationMs: 100,
    };
    const html = renderToStaticMarkup(<LlmPricingEditor models={[model]}
      catalog={{ '["https://api.example/v1","writer"]': {
        currency: 'USD', inputPerMillion: 1, outputPerMillion: 2,
      } }} onChange={() => {}} />);
    expect(html).toContain('输入 / 百万 token');
    expect(html).toContain('https://api.example/v1');
    expect(html).toContain('本次约 USD 0.000370');
    expect(html).toContain('已配置 1/1 个模型');
  });
});
