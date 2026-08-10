import { describe, expect, it } from 'vitest';
import {
  resolveSectionPlanTabTarget, resolveSectionPlanTitles, sectionPlanOutline,
  shouldCloseSectionPlanOnEscape,
  shouldDisableSectionAdoption, shouldDisableSectionPlanClose,
} from './SectionPlanPanel';

describe('resolveSectionPlanTitles', () => {
  it('优先使用后端已解析的 JSON 标题', () => {
    const raw = JSON.stringify({ sections: [{ title: '春雷' }, { title: '夜渡' }] });
    expect(resolveSectionPlanTitles(raw, ['春雷', '夜渡'])).toEqual(['春雷', '夜渡']);
  });

  it('未传 parsedTitles 时兼容旧文本格式', () => {
    expect(resolveSectionPlanTitles('第一部 · 起源')).toEqual(['起源']);
  });
});

describe('sectionPlanOutline', () => {
  it('把承诺、推进、兑现与阶段结构写成可供章节生成使用的本部大纲', () => {
    const outline = sectionPlanOutline({
      title: '暗潮', summary: '主角进入地下城', promise: '揭示城市暗面',
      goal: '找到失踪证人', obstacle: '守夜人追杀', progress: '锁定幕后组织',
      climax: '钟楼对决', payoff: '救回证人并获得名单',
      stateChange: '主角身份暴露，盟友关系确立',
    });
    expect(outline).toContain('【阶段承诺 Promise】揭示城市暗面');
    expect(outline).toContain('【主线推进 Progress】锁定幕后组织');
    expect(outline).toContain('【阶段兑现 Payoff】救回证人并获得名单');
    expect(outline).toContain('【结束状态变化】主角身份暴露，盟友关系确立');
  });
});

describe('shouldDisableSectionAdoption', () => {
  it('disables adoption while section planning is streaming', () => {
    expect(shouldDisableSectionAdoption({
      streaming: true,
      adopting: false,
      parseError: false,
      titleCount: 3,
    })).toBe(true);
  });

  it('disables adoption while adoption is already running', () => {
    expect(shouldDisableSectionAdoption({
      streaming: false,
      adopting: true,
      parseError: false,
      titleCount: 3,
    })).toBe(true);
  });

  it('disables adoption when no section titles were parsed', () => {
    expect(shouldDisableSectionAdoption({
      streaming: false,
      adopting: false,
      parseError: false,
      titleCount: 0,
    })).toBe(true);
  });

  it('disables adoption when parseError is true', () => {
    expect(shouldDisableSectionAdoption({
      streaming: false,
      adopting: false,
      parseError: true,
      titleCount: 3,
    })).toBe(true);
  });

  it('allows adoption only when titles exist, no parse error, and no async work is running', () => {
    expect(shouldDisableSectionAdoption({
      streaming: false,
      adopting: false,
      parseError: false,
      titleCount: 3,
    })).toBe(false);
  });
});

describe('shouldDisableSectionPlanClose', () => {
  it('disables closing while adoption is already running', () => {
    expect(shouldDisableSectionPlanClose({ adopting: true })).toBe(true);
  });

  it('allows closing when adoption is idle', () => {
    expect(shouldDisableSectionPlanClose({ adopting: false })).toBe(false);
  });
});

describe('shouldCloseSectionPlanOnEscape', () => {
  it('allows Escape to close an idle plan but not an in-progress adoption', () => {
    expect(shouldCloseSectionPlanOnEscape({ key: 'Escape', adopting: false })).toBe(true);
    expect(shouldCloseSectionPlanOnEscape({ key: 'Escape', adopting: true })).toBe(false);
    expect(shouldCloseSectionPlanOnEscape({ key: 'Enter', adopting: false })).toBe(false);
  });
});

describe('resolveSectionPlanTabTarget', () => {
  it('wraps focus at both ends of the modal', () => {
    expect(resolveSectionPlanTabTarget({
      shiftKey: false, activeIndex: 2, focusableCount: 3,
    })).toBe(0);
    expect(resolveSectionPlanTabTarget({
      shiftKey: true, activeIndex: 0, focusableCount: 3,
    })).toBe(2);
  });

  it('moves initial panel focus into the modal and keeps an empty modal focused', () => {
    expect(resolveSectionPlanTabTarget({
      shiftKey: false, activeIndex: -1, focusableCount: 2,
    })).toBe(0);
    expect(resolveSectionPlanTabTarget({
      shiftKey: true, activeIndex: -1, focusableCount: 2,
    })).toBe(1);
    expect(resolveSectionPlanTabTarget({
      shiftKey: false, activeIndex: -1, focusableCount: 0,
    })).toBe(-1);
  });

  it('leaves focus movement inside the modal to the browser', () => {
    expect(resolveSectionPlanTabTarget({
      shiftKey: false, activeIndex: 0, focusableCount: 3,
    })).toBeNull();
    expect(resolveSectionPlanTabTarget({
      shiftKey: true, activeIndex: 2, focusableCount: 3,
    })).toBeNull();
  });
});
