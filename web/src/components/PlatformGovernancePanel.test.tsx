import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SerializationSettings } from '../types';
import { PlatformGovernancePanel } from './PlatformGovernancePanel';

const settings: SerializationSettings = {
  dailyWordGoal: 2000,
  revision: 'R'.repeat(43),
  syncPolicy: {
    mode: 'manual-only', automaticSyncAvailable: false,
    allowedIntegration: 'official-authorized-api-only',
    prohibitedMethods: ['login-automation', 'captcha-bypass'],
  },
  platformConfirmations: [{
    id: `platform_${'a'.repeat(32)}`,
    platform: '起点读书',
    rulesUrl: 'https://example.test/rules',
    aiPolicyUrl: 'https://example.test/ai-policy',
    contractReference: '已核对当前合同第 8 条。',
    officialApiStatus: 'authorized',
    apiDocsUrl: 'https://example.test/api-docs',
    confirmations: { rules: true, aiPolicy: true, contract: true, noBypass: true },
    checkedAt: '2026-08-10T00:00:00.000Z',
    reviewStatus: 'current',
    reviewAfter: '2026-09-09T00:00:00.000Z',
    syncGate: {
      automaticSyncAvailable: false,
      eligibleForFutureIntegration: true,
      reason: 'OFFICIAL_API_REVIEW_REQUIRED_BEFORE_IMPLEMENTATION',
    },
  }],
};

describe('PlatformGovernancePanel', () => {
  it('shows traceable official references while keeping synchronization manual-only', () => {
    const html = renderToStaticMarkup(<PlatformGovernancePanel
      settings={settings} onSave={vi.fn()} onDelete={vi.fn()} />);

    expect(html).toContain('平台规则与合同核对');
    expect(html).toContain('同步策略：仅手动');
    expect(html).toContain('当前没有登录、验证码处理或自动上传功能');
    expect(html).toContain('起点读书');
    expect(html).toContain('href="https://example.test/rules"');
    expect(html).toContain('href="https://example.test/ai-policy"');
    expect(html).toContain('href="https://example.test/api-docs"');
    expect(html).toContain('当前仍不自动同步');
    expect(html).not.toContain('type="password"');
  });

  it('requires four explicit author confirmations and does not claim compliance', () => {
    const html = renderToStaticMarkup(<PlatformGovernancePanel
      settings={{ ...settings, platformConfirmations: [] }}
      onSave={vi.fn()} onDelete={vi.fn()} />);

    expect(html).toContain('我已打开并核对官方作者规则');
    expect(html).toContain('我已打开并核对官方 AI 内容政策');
    expect(html).toContain('我已核对自己当前适用的合同条款');
    expect(html).toContain('我不会绕过登录、验证码或平台限制');
    expect(html).toMatch(/<button class="primary" disabled="">保存人工核对记录<\/button>/);
    expect(html).not.toContain('已合规');
  });
});
