import { useEffect, useState } from 'react';
import * as api from '../api';
import {
  estimateCostsByCurrency, estimateModelCost, llmPricingKey,
  loadLlmPricing, priceForUsage, saveLlmPricing,
} from '../llm-pricing';
import type {
  LlmModelPrice, LlmPriceCurrency, LlmPricingCatalog,
} from '../llm-pricing';
import type { LlmUsageModel, LlmUsageSnapshot } from '../types';

const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);

export function LlmUsageSummary({ snapshot }: { snapshot: LlmUsageSnapshot }) {
  const { totals } = snapshot;
  return <div className="llm-usage-summary">
    <div className="llm-usage-totals">
      <span><strong>{number(totals.calls)}</strong> 次调用</span>
      <span><strong>{number(totals.inputChars)}</strong> 输入字符</span>
      <span><strong>{number(totals.outputChars)}</strong> 输出字符</span>
      <span><strong>{number(totals.estimatedInputTokens + totals.estimatedOutputTokens)}</strong> 本地估算 token</span>
      <span><strong>{totals.providerUsageCalls
        ? number(totals.providerInputTokens + totals.providerOutputTokens) : '—'}</strong> 供应商 token</span>
      <span><strong>{number(totals.failed + totals.cancelled)}</strong> 次未完成</span>
    </div>
    <p>{snapshot.note} 统计从本次服务启动开始，不包含提示词原文或 API Key。</p>
    {!!snapshot.recent.length && <details>
      <summary>最近 {Math.min(10, snapshot.recent.length)} 次调用</summary>
      <ol>{snapshot.recent.slice(-10).reverse().map((entry, index) => <li
        key={`${entry.at}:${entry.task}:${index}`}>
        <strong>{entry.task}</strong> · {entry.model || '未命名模型'} · {entry.status}
        <small>输入 {number(entry.inputChars)} / 输出 {number(entry.outputChars)} 字符 · 估算 {number(entry.estimatedInputTokens + entry.estimatedOutputTokens)} token
          {entry.providerInputTokens !== null || entry.providerOutputTokens !== null
            ? ` · 供应商 ${number((entry.providerInputTokens ?? 0) + (entry.providerOutputTokens ?? 0))} token` : ''}
          {' · '}{number(entry.durationMs)} ms{entry.errorCode ? ` · ${entry.errorCode}` : ''}</small>
      </li>)}</ol>
    </details>}
  </div>;
}

export function LlmPricingEditor({
  models, catalog, onChange,
}: {
  models: LlmUsageModel[];
  catalog: LlmPricingCatalog;
  onChange: (catalog: LlmPricingCatalog) => void;
}) {
  if (!models.length) return <p className="llm-pricing-empty">产生模型调用后，可在这里登记每百万 token 单价。</p>;
  const costs = estimateCostsByCurrency(models, catalog);
  const update = (usage: LlmUsageModel, patch: Partial<LlmModelPrice>) => {
    const key = llmPricingKey(usage);
    const current = priceForUsage(usage, catalog) ?? {
      currency: 'USD' as LlmPriceCurrency, inputPerMillion: 0, outputPerMillion: 0,
    };
    onChange({ ...catalog, [key]: { ...current, ...patch } });
  };
  return <section className="llm-pricing" aria-label="模型价格与费用估算">
    <header><div><h3>模型价格与费用估算</h3>
      <p>价格只保存在当前浏览器。每次调用优先使用供应商 usage token，缺失时使用本地估算 token。</p>
    </div></header>
    <div className="llm-pricing-list">{models.map((usage) => {
      const price = priceForUsage(usage, catalog) ?? {
        currency: 'USD' as LlmPriceCurrency, inputPerMillion: 0, outputPerMillion: 0,
      };
      const cost = estimateModelCost(usage, priceForUsage(usage, catalog));
      return <article key={llmPricingKey(usage)}>
        <div className="llm-pricing-model"><strong>{usage.model}</strong>
          <small>{usage.provider || '未记录服务地址'}</small></div>
        <label>币种<select value={price.currency}
          onChange={(event) => update(usage, {
            currency: event.target.value as LlmPriceCurrency,
          })}><option value="USD">USD</option><option value="CNY">CNY</option></select></label>
        <label>输入 / 百万 token<input type="number" min="0" max="1000000" step="0.0001"
          value={price.inputPerMillion}
          onChange={(event) => update(usage, {
            inputPerMillion: Math.max(0, Number(event.target.value) || 0),
          })} /></label>
        <label>输出 / 百万 token<input type="number" min="0" max="1000000" step="0.0001"
          value={price.outputPerMillion}
          onChange={(event) => update(usage, {
            outputPerMillion: Math.max(0, Number(event.target.value) || 0),
          })} /></label>
        <span>{cost === null ? '尚未配置价格' : `本次约 ${price.currency} ${cost.toFixed(6)}`}</span>
      </article>;
    })}</div>
    <p className="llm-pricing-total">已配置 {costs.pricedModels}/{models.length} 个模型；
      CNY {costs.totals.CNY.toFixed(6)} · USD {costs.totals.USD.toFixed(6)}。
      {costs.unpricedModels ? ` 仍有 ${costs.unpricedModels} 个模型未计价。` : ''}</p>
  </section>;
}

export function LlmUsagePanel() {
  const [snapshot, setSnapshot] = useState<LlmUsageSnapshot>();
  const [pricing, setPricing] = useState<LlmPricingCatalog>(() => loadLlmPricing());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try { setSnapshot(await api.getLlmUsage(signal)); }
    catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  return <section className="llm-usage-panel sketch-alt" aria-label="本次服务模型用量">
    <header><div><h2>本次服务模型用量</h2>
      <p>本地会估算 token；兼容服务若主动返回 usage，则另列供应商 token。人民币或美元费用仍需配置对应模型价格后才能计算。</p>
    </div><button className="hbtn" type="button" disabled={loading}
      onClick={() => { void load(); }}>{loading ? '读取中…' : '刷新'}</button></header>
    {error && <p className="settings-load-error" role="alert">{error}</p>}
    {snapshot && <><LlmUsageSummary snapshot={snapshot} />
      <LlmPricingEditor models={snapshot.models} catalog={pricing}
        onChange={(next) => setPricing(saveLlmPricing(next))} /></>}
  </section>;
}
