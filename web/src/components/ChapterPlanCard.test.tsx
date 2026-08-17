import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChapterPlan, IncomingChapterPlanCarryover } from '../types';
import {
  AiPlanCandidate, ChapterPlanCard, chapterPlanDraftIsDirty, chapterPlanInput,
  activateChapterPlanDesignProtocol, activateChapterPlanQualityProtocol,
  chapterPlanQualityTemplate, chapterPlanWithCarryover,
  chapterPlanWithPromiseAction, chapterPlanWithoutForeshadowingTask,
  chapterPlanWithoutKnowledgeTask, generatedChapterPlanIsCurrent,
} from './ChapterPlanCard';

const plan: ChapterPlan = {
  qualityProtocolVersion: 0,
  designProtocolVersion: 0,
  rhythmIntentVersion: 0,
  rhythmIntent: {
    pressurePattern: '', resolutionMethod: '', payoffScale: '', hookMechanism: '', costType: '',
  },
  goal: '追回账册', obstacle: '旧友拦路', choice: '公开旧案真相',
  payoff: '旧友让路', hook: '末页已被撕走',
  tensionArc: '过桥受阻→证据带来希望→旧友质疑反制→真相迫使让路→身份暴露',
  foreshadowing: '回收旧友误会；用撕页纤维推进内鬼线，但不解释幕后人',
  worldExpansion: '桥上的城外徽记证明旧案跨区运作，暂不揭示组织结构',
  decisionChain: '', knowledgeDesign: '',
  notes: '不能烧毁账册',
  scenes: [{
    title: '桥上对峙', desire: '主角要过桥', obstacle: '旧友拔刀',
    action: '公开证据', turn: '旧友让路', cost: '身份暴露',
  }],
  revision: 'R'.repeat(43), isEmpty: false,
  readiness: {
    ready: true,
    checks: [{
      id: 'movement', label: '故事推进', pass: true,
      detail: '目标、阻碍、选择、兑现和后续牵引均已明确。',
    }],
  },
};
const incoming: IncomingChapterPlanCarryover = {
  sourceChapterId: 'chapter_1', sourceChapterTitle: '雨夜失印',
  sourceBodyFingerprint: 'B'.repeat(43), sourcePlanRevision: 'P'.repeat(43),
  summary: '账本已拿回，印章线索仍未兑现。',
  items: [{
    sourceTarget: 'payoff', text: '找到印章另一半',
    reason: '需要用完整印章锁定内鬼。', suggestedField: 'goal',
  }],
};

describe('ChapterPlanCard', () => {
  it('展示章级意图、场景链及修订状态', () => {
    const html = renderToStaticMarkup(
      <ChapterPlanCard plan={plan} onSave={vi.fn()} onGenerateDraft={vi.fn()} />,
    );
    expect(html).toContain('章节策划卡');
    expect(html).toContain('本章目标');
    expect(html).toContain('主要阻碍');
    expect(html).toContain('关键选择');
    expect(html).toContain('兑现 / 爽点');
    expect(html).toContain('章末钩子');
    expect(html).toContain('张力曲线');
    expect(html).toContain('分层埋点');
    expect(html).toContain('世界边界扩张');
    expect(html).toContain('补充说明');
    expect(html).toContain('写前节奏意图');
    expect(html).toContain('压力轨迹');
    expect(html).toContain('破局方式');
    expect(html).toContain('升级为节奏意图 v1');
    expect(html).toContain('场景链');
    expect(html).toContain('桥上对峙');
    expect(html).toContain('人物欲望');
    expect(html).toContain('局势转折');
    expect(html).toContain('代价 / 后果');
    expect(html).toContain('已保存');
    expect(html).toContain('追回账册');
    expect(html).toContain('过桥受阻');
    expect(html).toContain('撕页纤维');
    expect(html).toContain('城外徽记');
    expect(html).toContain('AI 生成策划候选');
    expect(html).toContain('填入完整写作合同模板');
    expect(html).toContain('决策因果链');
    expect(html).toContain('认知与证据边界');
    expect(html).toContain('本章无认知任务');
    expect(html).toContain('只生成可比较的候选');
    expect(html).toContain('AI 候选需先采用、再保存才会生效');
    expect(html).toContain('写前判断已齐备');
    expect(html).toContain('这些意图会作为明确要求发送');
  });

  it('只把相对服务器策划有实际变化的内容标为草稿', () => {
    expect(chapterPlanDraftIsDirty(chapterPlanInput(plan), plan)).toBe(false);
    expect(chapterPlanDraftIsDirty({ ...chapterPlanInput(plan), hook: '新的钩子' }, plan))
      .toBe(true);
    expect(chapterPlanDraftIsDirty({ ...chapterPlanInput(plan), goal: ' 追回账册 ' }, plan))
      .toBe(false);
    expect(chapterPlanDraftIsDirty({
      ...chapterPlanInput(plan), rhythmIntentVersion: 1,
      rhythmIntent: { ...plan.rhythmIntent, pressurePattern: 'wave-rise' },
    }, plan)).toBe(true);
    const sceneChanged = chapterPlanInput(plan);
    sceneChanged.scenes[0].turn = '旧友突然倒戈';
    expect(chapterPlanDraftIsDirty(sceneChanged, plan)).toBe(true);
  });

  it('编辑旧版质量字段不打断输入，模板按钮再补齐三个结构', () => {
    const upgraded = activateChapterPlanQualityProtocol(
      chapterPlanInput(plan), 'tensionArc', '封站倒计时持续压缩通路',
    );
    expect(upgraded.qualityProtocolVersion).toBe(3);
    expect(upgraded.tensionArc).toBe('封站倒计时持续压缩通路');
    expect(upgraded.foreshadowing).toBe(plan.foreshadowing);
    expect(upgraded.worldExpansion).toBe(plan.worldExpansion);
    const blankLegacy = { ...chapterPlanInput(plan), tensionArc: '', foreshadowing: '', worldExpansion: '' };
    const seeded = chapterPlanQualityTemplate({
      ...blankLegacy, foreshadowing: '推进失踪证人旧线',
    });
    expect(seeded.tensionArc).toContain('压力来源：');
    expect(seeded.foreshadowing).toContain('旧线/阅读债务：推进失踪证人旧线');
    expect(seeded.worldExpansion).toContain('既有依据：');
    expect(seeded.worldExpansion).toContain('展开前认知：');

    const newChapter = { ...blankLegacy, qualityProtocolVersion: 3 as const };
    const newSeeded = chapterPlanQualityTemplate(newChapter);
    expect(newSeeded.foreshadowing).toContain('旧线/阅读债务：');
    expect(newSeeded.worldExpansion).toContain('既有依据：');
    expect(newSeeded.worldExpansion).toContain('展开前认知：');
    expect(newSeeded.designProtocolVersion).toBe(1);
    expect(newSeeded.decisionChain).toContain('利益受损者：');
    expect(newSeeded.knowledgeDesign).toContain('替代解释：｜');
  });

  it('v1 模板升级时保留旧世界合同，并把认知基线留给作者补充', () => {
    const legacyWorld = '既有依据：旧城戒严；可验证证据：跨城印章；边界增量/机制深化：确认封锁跨城；选择与代价：越界后身份暴露；保留未知：幕后主使';
    const legacy = {
      ...chapterPlanInput(plan),
      qualityProtocolVersion: 1 as const,
      worldExpansion: legacyWorld,
    };
    const upgraded = chapterPlanQualityTemplate(legacy);
    expect(upgraded.qualityProtocolVersion).toBe(3);
    expect(upgraded.worldExpansion).toBe(`展开前认知：；${legacyWorld}`);
  });

  it('无到期任务时可明确选择不埋点，已有具体策划不会被按钮静默覆盖', () => {
    const blank = { ...chapterPlanInput(plan), foreshadowing: '' };
    const noTask = chapterPlanWithoutForeshadowingTask(blank);
    expect(noTask?.qualityProtocolVersion).toBe(3);
    expect(noTask?.foreshadowing).toBe('无埋点理由：；本章聚焦：；既有未知处理：');
    expect(chapterPlanWithoutForeshadowingTask(noTask!)).toEqual(noTask);
    expect(chapterPlanQualityTemplate(noTask!).foreshadowing).toBe(noTask?.foreshadowing);
    expect(chapterPlanWithoutForeshadowingTask(chapterPlanInput(plan))).toBeNull();
    const html = renderToStaticMarkup(
      <ChapterPlanCard plan={plan} onSave={vi.fn()} />,
    );
    expect(html).toContain('本章无埋点任务');
  });

  it('编辑叙事设计字段会升级协议，无认知任务不会覆盖具体判断', () => {
    const upgraded = activateChapterPlanDesignProtocol(
      chapterPlanInput(plan), 'decisionChain', '当前误判/未决：旧友会让路',
    );
    expect(upgraded.designProtocolVersion).toBe(1);
    expect(upgraded.decisionChain).toContain('旧友会让路');
    const noTask = chapterPlanWithoutKnowledgeTask({
      ...chapterPlanInput(plan), knowledgeDesign: '',
    });
    expect(noTask?.knowledgeDesign)
      .toBe('无认知任务理由：；本章聚焦：；既有判断处理：');
    expect(chapterPlanWithoutKnowledgeTask({
      ...chapterPlanInput(plan), knowledgeDesign: '当前问题：谁拿走账本',
    })).toBeNull();
  });

  it('上章未决项只能手动加入未保存草稿', () => {
    const html = renderToStaticMarkup(
      <ChapterPlanCard plan={plan} incomingPlanCarryover={incoming} onSave={vi.fn()} />,
    );
    expect(html).toContain('上章未决策划项');
    expect(html).toContain('来自「雨夜失印」');
    expect(html).toContain('不是已发生事实');
    expect(html).toContain('加入本章草稿');
    const adopted = chapterPlanWithCarryover(chapterPlanInput(plan), incoming.items[0]);
    expect(adopted?.goal).toContain('[承接上章] 找到印章另一半');
    expect(chapterPlanDraftIsDirty(adopted!, plan)).toBe(true);
    expect(chapterPlanWithCarryover(adopted!, incoming.items[0])).toBe(adopted);
    expect(chapterPlanWithCarryover({
      ...chapterPlanInput(plan), goal: '长'.repeat(500),
    }, incoming.items[0])).toBeNull();
  });

  it('阅读债务可一键加入策划锚点，且状态决定允许的动作', () => {
    const option = {
      id: `promise_${'a'.repeat(32)}`, status: 'open' as const,
      promise: '车票背面的真名属于谁', importance: 5,
      expectedStartChapter: 8, expectedEndChapter: 10, urgent: true, overdue: false,
    };
    const advanced = chapterPlanWithPromiseAction(
      chapterPlanInput(plan), option, '推进债务',
    );
    expect(advanced?.foreshadowing).toContain(`[推进债务:${option.id}]`);
    expect(advanced?.qualityProtocolVersion).toBe(3);
    const structured = chapterPlanWithPromiseAction({
      ...chapterPlanInput(plan),
      foreshadowing: '旧线/阅读债务：推进车票线；具体载体：旧车票；当下作用：核验身份；行动影响：主角改道；保留未知：内鬼身份',
    }, option, '兑现债务');
    expect(structured?.foreshadowing).toContain(`旧线/阅读债务：[兑现债务:${option.id}] 推进车票线`);
    const delayed = chapterPlanWithPromiseAction(
      chapterPlanInput(plan), option, '延期债务',
    );
    expect(delayed?.notes).toContain('延期原因：；下一检查点：');
    expect(chapterPlanWithPromiseAction(
      chapterPlanInput(plan), option, '建立承诺',
    )).toBeNull();
    const noTask = chapterPlanWithoutForeshadowingTask({
      ...chapterPlanInput(plan), foreshadowing: '',
    })!;
    const taskAgain = chapterPlanWithPromiseAction(noTask, option, '推进债务');
    expect(taskAgain?.foreshadowing).toContain(`旧线/阅读债务：[推进债务:${option.id}]`);
    expect(taskAgain?.foreshadowing).not.toContain('无埋点理由');
    const html = renderToStaticMarkup(<ChapterPlanCard
      plan={plan} promiseActions={[option]} onSave={vi.fn()} />);
    expect(html).toContain('当前阅读债务');
    expect(html).toContain('车票背面的真名属于谁');
    expect(html).toContain('推进债务');
    expect(html).toContain('正文 API 不得把 ID 写进小说');
  });

  it('其它章节操作期间禁用全部输入与保存', () => {
    const html = renderToStaticMarkup(
      <ChapterPlanCard plan={plan} disabled onSave={vi.fn()} onGenerateDraft={vi.fn()} />,
    );
    expect(html).toMatch(/aria-label="场景 1 人物欲望" disabled=""/);
    expect(html).toMatch(/aria-label="删除场景 1" disabled=""/);
    expect(html).toMatch(/>保存策划卡<\/button>/);
    expect(html).toMatch(/disabled=""[^>]*>✨ AI 生成策划候选<\/button>/);
  });

  it('只允许采用基于当前已保存策划修订生成的候选', () => {
    const result = { plan: chapterPlanInput(plan), basePlanRevision: plan.revision };
    expect(generatedChapterPlanIsCurrent(result, plan)).toBe(true);
    expect(generatedChapterPlanIsCurrent(
      { ...result, basePlanRevision: 'N'.repeat(43) }, plan,
    )).toBe(false);
  });

  it('AI 候选明确要求先采用再手动保存，且不暗示已经生成正文', () => {
    const html = renderToStaticMarkup(<AiPlanCandidate
      result={{ plan: chapterPlanInput(plan), basePlanRevision: plan.revision }}
      replacingDirtyDraft
      onAdopt={vi.fn()}
      onDiscard={vi.fn()} />);
    expect(html).toContain('AI 策划候选');
    expect(html).toContain('仍需手动保存');
    expect(html).toContain('采用为编辑草稿');
    expect(html).toContain('替换当前未保存表单');
    expect(html).toContain('桥上对峙');
    expect(html).not.toContain('已生成正文');
  });
});
