import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ApiProfilePanel, decodeTaskRoute, encodeTaskRoute,
  mergeDiscoveredProfileModels, parseProfileModels,
} from './ApiProfilePanel';
import { ToastProvider } from './Toast';

describe('ApiProfilePanel', () => {
  it('解析逗号与换行模型列表并稳定去重', () => {
    expect(parseProfileModels(' fast\nsmart, fast，reasoning '))
      .toEqual(['fast', 'smart', 'reasoning']);
  });

  it('同步发现结果时保留显式选中的模型并限制方案大小', () => {
    const models = mergeDiscoveredProfileModels(
      'selected-alias', Array.from({ length: 70 }, (_, index) => `model-${index}`),
    );
    expect(models).toHaveLength(50);
    expect(models[0]).toBe('selected-alias');
  });

  it('模型分工选项可无损表示特殊模型名', () => {
    const route = { profileId: `profile_${'a'.repeat(32)}`, model: 'vendor:model/a b' };
    expect(decodeTaskRoute(encodeTaskRoute(route))).toEqual(route);
    expect(decodeTaskRoute('')).toBeNull();
    expect(decodeTaskRoute('{bad')).toBeNull();
  });

  it('首屏说明显式模型选择且不做静默切换', () => {
    const html = renderToStaticMarkup(
      <ToastProvider><ApiProfilePanel config={null} settingsDirty={false}
        disabled={false} onActivated={() => {}} /></ToastProvider>,
    );
    expect(html).toContain('API 快速切换');
    expect(html).toContain('一个服务可登记多个模型');
    expect(html).toContain('不会静默改用其它模型');
    expect(html).toContain('正在读取 API 方案');
  });
});
