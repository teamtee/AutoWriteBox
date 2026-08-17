import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../types';
import { createLatestRequestGate } from '../asyncAction';
import {
  hasSettingsDraft, SettingsPage, loadSettingsConfig, saveSettingsConfig,
  shouldConfirmSettingsDiscard,
} from './SettingsPage';
import { ToastProvider } from './Toast';

const config = (model: string): Config => ({
  baseUrl: 'https://example.test/v1',
  model,
  apiKey: 'sk-****',
  chapterWordTarget: 2000,
  requestTimeoutMs: 300000,
  modelContextChars: 500000,
  revision: 'R'.repeat(43),
});

describe('SettingsPage initial config loading', () => {
  it('locks every setting and save action until stored config has loaded', () => {
    const html = renderToStaticMarkup(
      <ToastProvider><SettingsPage onClose={() => {}} /></ToastProvider>,
    );

    expect(html).toContain('正在读取已保存的设置');
    expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(6);
    expect(html).toMatch(/<button type="submit" class="hbtn accent-2" disabled="">读取中…<\/button>/);
  });

  it('uses native form validation and masks the API key field', () => {
    const html = renderToStaticMarkup(
      <ToastProvider><SettingsPage onClose={() => {}} /></ToastProvider>,
    );

    expect(html).toContain('<form class="core-form">');
    expect(html).toContain('<h1 class="paper-title">API 设置</h1>');
    expect(html).toMatch(/name="apiKey"[^>]*type="password"[^>]*autoComplete="off"/);
    expect(html).toContain('检查连接 / 发现模型');
    expect(html).toContain('id="discovered-api-models"');
    expect(html).toMatch(/<button type="submit" class="hbtn accent-2"/);
    expect(html).toMatch(/<button type="button" class="hbtn"/);
  });

  it('reports load failure without treating empty defaults as loaded config', async () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await expect(loadSettingsConfig({
      load: async () => { throw new Error('SERVER_DOWN'); },
      onSuccess,
      onFailure,
    })).resolves.toBeNull();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith('SERVER_DOWN');
  });

  it('does not let an older retry overwrite the latest config response', async () => {
    const gate = createLatestRequestGate();
    let releaseOld!: (value: Config) => void;
    const oldResponse = new Promise<Config>((resolve) => { releaseOld = resolve; });
    const visible: Config[] = [];
    const load = (response: Promise<Config>) => {
      const token = gate.begin();
      return loadSettingsConfig({
        load: () => response,
        onSuccess: (value) => visible.push(value),
        onFailure: () => {},
        isCurrent: () => gate.owns(token),
      });
    };

    const oldLoad = load(oldResponse);
    await load(Promise.resolve(config('latest')));
    releaseOld(config('stale'));
    await oldLoad;

    expect(visible).toEqual([config('latest')]);
  });
});

describe('SettingsPage config saving', () => {
  it('retries one ambiguous response and accepts the idempotent confirmation', async () => {
    const interrupted = new TypeError('fetch failed');
    const draft = config('draft');
    const saved = { ...draft, revision: 'S'.repeat(43) };
    const save = vi.fn()
      .mockRejectedValueOnce(interrupted)
      .mockResolvedValueOnce(saved);

    await expect(saveSettingsConfig({
      config: draft,
      save,
      isAmbiguousFailure: (error) => error === interrupted,
    })).resolves.toEqual(saved);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, draft);
    expect(save).toHaveBeenNthCalledWith(2, draft);
  });

  it('does not retry an explicit server rejection', async () => {
    const rejected = new Error('CONFIG_CONFLICT');
    const save = vi.fn().mockRejectedValue(rejected);

    await expect(saveSettingsConfig({
      config: config('draft'),
      save,
      isAmbiguousFailure: () => false,
    })).rejects.toBe(rejected);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('stops after two ambiguous responses so the page can require a reload', async () => {
    const first = new TypeError('first response lost');
    const second = new TypeError('second response lost');
    const save = vi.fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second);

    await expect(saveSettingsConfig({
      config: config('draft'),
      save,
      isAmbiguousFailure: () => true,
    })).rejects.toBe(second);
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('SettingsPage draft protection', () => {
  it('detects editable config changes but ignores a revision-only refresh', () => {
    const loaded = config('saved-model');

    expect(hasSettingsDraft(loaded, null)).toBe(false);
    expect(hasSettingsDraft({ ...loaded, revision: 'S'.repeat(43) }, loaded)).toBe(false);
    expect(hasSettingsDraft({ ...loaded, model: 'draft-model' }, loaded)).toBe(true);
    expect(hasSettingsDraft({ ...loaded, apiKey: 'new-secret' }, loaded)).toBe(true);
  });

  it('requires a second explicit action before discarding a dirty config', () => {
    expect(shouldConfirmSettingsDiscard(true, false)).toBe(true);
    expect(shouldConfirmSettingsDiscard(true, true)).toBe(false);
    expect(shouldConfirmSettingsDiscard(false, false)).toBe(false);
  });
});
