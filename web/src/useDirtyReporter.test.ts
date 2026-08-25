import { describe, expect, it, vi } from 'vitest';
import {
  clearDirtyReport, reportDirtyTransition, type DirtyReportState,
} from './useDirtyReporter';

describe('dirty reporter', () => {
  it('父组件内联回调身份变化时不反复上报 false/true', () => {
    const state: DirtyReportState = { reported: false };
    const firstRender = vi.fn();
    const secondRender = vi.fn();
    const thirdRender = vi.fn();

    reportDirtyTransition(state, true, firstRender);
    // 模拟父组件因 dirty=true 重渲染并创建新的内联回调；dirty 本身没变。
    reportDirtyTransition(state, true, secondRender);
    reportDirtyTransition(state, true, thirdRender);

    expect(firstRender).toHaveBeenCalledOnce();
    expect(firstRender).toHaveBeenCalledWith(true);
    expect(secondRender).not.toHaveBeenCalled();
    expect(thirdRender).not.toHaveBeenCalled();
    expect(state.reported).toBe(true);

    // 只有组件真正卸载时才向最新父回调清理一次。
    clearDirtyReport(state, thirdRender);
    expect(thirdRender).toHaveBeenCalledOnce();
    expect(thirdRender).toHaveBeenCalledWith(false);
    expect(state.reported).toBe(false);
  });

  it('只在 dirty 布尔值真正变化时上报', () => {
    const state: DirtyReportState = { reported: false };
    const report = vi.fn();
    reportDirtyTransition(state, false, report);
    reportDirtyTransition(state, true, report);
    reportDirtyTransition(state, true, report);
    reportDirtyTransition(state, false, report);
    reportDirtyTransition(state, false, report);
    expect(report.mock.calls).toEqual([[true], [false]]);
  });
});
