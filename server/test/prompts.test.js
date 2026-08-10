import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../prompts.js';
import { buildCoreFieldInstruction, buildSystemPrompt } from '../prompts.js';
import {
  MAX_CHARACTER_PROMPT_SCOPE_CHARS, MAX_LLM_INPUT_CHARS, MAX_VERSION_TEXT_CHARS,
  MAX_SECTION_PROMPT_SUMMARY_CHARS, MAX_WHIP_CHARS,
} from '../limits.js';

test('buildSystemPrompt 跳过空字段', () => {
  const s = p.buildSystemPrompt({ world: '赛博深圳', style: '', constraints: '不写主角死', pacing: '' });
  assert.match(s, /赛博深圳/);
  assert.match(s, /不写主角死/);
  assert.doesNotMatch(s, /文风基调/);
});

test('buildSystemPrompt 固化长篇网文创作准则', () => {
  const s = p.buildSystemPrompt({});
  assert.match(s, /长篇连载/);
  assert.match(s, /不用抽象总结代替关键场景/);
  assert.match(s, /不要密集堆砌比喻/);
  assert.match(s, /每章都要改变故事状态/);
  assert.match(s, /爽点不是只指打赢/);
  assert.match(s, /数量、时间、地点/);
});

test('buildContext 按作用域拼装人物', () => {
  const ctx = p.buildContext({
    book: { outline: { content: '全书大纲X' }, characters: [{ name: '陈默', role: '主角', desc: '警探' }] },
    section: { outline: { content: '本部大纲Y' }, summary: '本部前情Z', characters: [{ name: '林薇', role: '委托人', desc: '神秘' }] },
    prevChapter: { content: 'a'.repeat(500), progress: '去仓库', characters: [{ name: '老鼠', role: '线人', desc: '贩子' }] },
  });
  assert.match(ctx, /陈默/);
  assert.match(ctx, /林薇/);
  assert.match(ctx, /老鼠/);
  assert.match(ctx, /【上一章登场人物】/);
  assert.doesNotMatch(ctx, /本章相关龙套/);
  assert.match(ctx, /去仓库/);
  assert.match(ctx, /本部前情Z/);
});

test('buildContext 忽略旧数据里的非法人物结构', () => {
  const ctx = p.buildContext({
    book: {
      characters: { bad: 'object' },
    },
    section: {
      characters: [
        null,
        'bad',
        { name: '缺身份' },
        { name: '林薇', role: '委托人', desc: '神秘' },
      ],
    },
    prevChapter: {
      characters: [42, { name: '老鼠', role: '线人', desc: '贩子' }],
    },
  });

  assert.match(ctx, /林薇/);
  assert.match(ctx, /老鼠/);
  assert.doesNotMatch(ctx, /undefined/);
  assert.doesNotMatch(ctx, /bad/);
  assert.doesNotMatch(ctx, /缺身份/);
});

test('buildContext 对合法超长聚合摘要只保留最近前情而不阻断后续生成', () => {
  const latest = '第10000章：主角抵达终点';
  const summary = [
    '第1章：最早线索',
    '中期剧情'.repeat(MAX_SECTION_PROMPT_SUMMARY_CHARS),
    latest,
  ].join('\n');

  const ctx = p.buildContext({
    book: { outline: { content: '短大纲' }, characters: [] },
    section: { outline: { content: '短部纲' }, summary, characters: [] },
  });

  assert.match(ctx, /较早的本部摘要已省略/);
  assert.match(ctx, new RegExp(latest));
  assert.doesNotMatch(ctx, /最早线索/);
  assert.ok(ctx.length < MAX_LLM_INPUT_CHARS);
  assert.ok(p.recentSectionSummary(summary).length <= MAX_SECTION_PROMPT_SUMMARY_CHARS);
});

test('buildContext 对合法超大人物名册保留主要与最近条目并显式省略中段', () => {
  const characters = Array.from({ length: 1_000 }, (_, index) => ({
    name: `人物${index}`,
    role: '角色',
    desc: '状态'.repeat(250),
  }));

  const ctx = p.buildContext({
    book: { characters },
    section: { characters },
    prevChapter: { characters, content: '结尾', progress: '继续' },
  });

  assert.match(ctx, /人物0（角色）/);
  assert.match(ctx, /人物999（角色）/);
  assert.match(ctx, /已省略中间人物/);
  assert.doesNotMatch(ctx, /人物500（角色）/);
  assert.ok(ctx.length < MAX_LLM_INPUT_CHARS);
  assert.ok(
    p.generationCharacterRows(characters).join('\n').length
      <= MAX_CHARACTER_PROMPT_SCOPE_CHARS,
  );
});

test('合法字段达到各自上限时章节重写和审稿的总输入仍保持有界', () => {
  const longVersion = (head, tail) =>
    head + '中'.repeat(MAX_VERSION_TEXT_CHARS - head.length - tail.length) + tail;
  const core = {
    world: longVersion('世界开头', '世界结尾'),
    style: longVersion('文风开头', '文风结尾'),
    constraints: longVersion('禁忌开头', '禁忌结尾'),
    pacing: longVersion('节奏开头', '节奏结尾'),
  };
  const characters = Array.from({ length: 1_000 }, (_, index) => ({
    name: `人物${index}`,
    role: '角色',
    desc: '状态'.repeat(250),
  }));
  const system = p.buildSystemPrompt(core);
  const context = p.buildContext({
    book: {
      outline: { content: longVersion('全书开头', '全书结尾') }, characters,
    },
    section: {
      outline: { content: longVersion('本部开头', '本部结尾') },
      summary: `最早前情\n${'中期'.repeat(MAX_SECTION_PROMPT_SUMMARY_CHARS)}\n最新前情`,
      characters,
    },
    prevChapter: {
      content: longVersion('上一章开头', '上一章结尾'),
      progress: '下一步'.repeat(100),
      characters,
    },
  });
  const currentContent = longVersion('当前章开头', '当前章结尾');
  const rewrite = p.buildChapterInstruction({
    chapterIndex: 2, wordTarget: 50_000, mode: 'rewrite', currentContent,
  });
  const whip = p.buildChapterInstruction({
    chapterIndex: 2, wordTarget: 50_000, mode: 'whip', currentContent,
    whip: '改'.repeat(MAX_WHIP_CHARS),
  });
  const review = p.buildChapterReviewInstruction({
    chapterIndex: 2, content: currentContent, context,
  });

  assert.match(system, /中间内容已省略/);
  assert.match(system, /世界开头/);
  assert.match(system, /世界结尾/);
  assert.match(context, /全书开头/);
  assert.match(context, /全书结尾/);
  assert.match(context, /本部开头/);
  assert.match(context, /本部结尾/);
  assert.match(context, /上一章结尾/);
  assert.doesNotMatch(context, /上一章开头/);
  assert.ok(system.length + rewrite.length + context.length <= MAX_LLM_INPUT_CHARS);
  assert.ok(system.length + whip.length + context.length <= MAX_LLM_INPUT_CHARS);
  assert.ok(system.length + review.length <= MAX_LLM_INPUT_CHARS);
});

test('buildChapterInstruction 抽打时嵌入训话且优先', () => {
  const i = p.buildChapterInstruction({ chapterIndex: 3, wordTarget: 2000, mode: 'whip', whip: '太平淡，加冲突' });
  assert.match(i, /太平淡，加冲突/);
  assert.match(i, /2000/);
  assert.match(i, /黄金第三章职责/);
  assert.match(i, /目标 → 阻碍 → 选择 → 后果\/变化/);
  assert.match(i, /有效兑现/);
});

test('buildChapterInstruction 为后续普通章节持续注入执行清单', () => {
  const instruction = p.buildChapterInstruction({
    chapterIndex: 8, wordTarget: 2500, mode: 'next',
  });
  assert.match(instruction, /本章执行清单/);
  assert.match(instruction, /后续牵引/);
  assert.match(instruction, /不能让主要人物长时间被动旁观/);
  assert.doesNotMatch(instruction, /黄金第[一二三]章职责/);
});

test('buildChapterInstruction 普通重写携带当前章原文', () => {
  const instruction = p.buildChapterInstruction({
    chapterIndex: 3,
    wordTarget: 2000,
    mode: 'rewrite',
    currentContent: '旧稿里的关键线索不能丢',
  });
  assert.match(instruction, /【当前章原文】/);
  assert.match(instruction, /旧稿里的关键线索不能丢/);
  assert.match(instruction, /核心情节/);
});

test('DIGEST_INSTRUCTION 要求标题与原有 digest 五字段', () => {
  for (const field of ['chapterTitle', 'sectionTitle', 'summary', 'progress', 'characters']) {
    assert.match(p.DIGEST_INSTRUCTION, new RegExp(field));
  }
  assert.match(p.DIGEST_INSTRUCTION, /10\s*字/);
  assert.match(p.DIGEST_INSTRUCTION, /完整列出/);
  assert.match(p.DIGEST_INSTRUCTION, /全部人物/);
  assert.match(p.DIGEST_INSTRUCTION, /包括已有角色/);
  assert.match(p.DIGEST_INSTRUCTION, /最新身份或状态/);
  assert.doesNotMatch(p.DIGEST_INSTRUCTION, /所有新登场人物/);
  assert.match(p.DIGEST_INSTRUCTION, /memoryCandidates/);
  assert.match(p.DIGEST_INSTRUCTION, /仍需作者确认/);
  assert.match(p.DIGEST_INSTRUCTION, /不要把推测/);
  for (const predicate of ['别名', '身份', '阵营', '性格', '目标', '能力', '限制', '当前状态', '生死状态']) {
    assert.match(p.DIGEST_INSTRUCTION, new RegExp(predicate));
  }
  assert.match(p.DIGEST_INSTRUCTION, /一条候选只写一个属性/);
  for (const predicate of ['获得', '境界', '使用记录', '持有人', '数量', '最后位置', '移动事件', '持续时间', '参与者']) {
    assert.match(p.DIGEST_INSTRUCTION, new RegExp(predicate));
  }
  assert.match(p.DIGEST_INSTRUCTION, /subject=人物甲/);
  assert.match(p.DIGEST_INSTRUCTION, /关系变化的原因写入 evidence/);
  for (const field of [
    'territory', 'foreshadowStatus', 'readerKnowledge', 'plannedPayoff',
    'actualPayoff', 'dueChapter', 'knowledgeOwner', 'knower', 'information',
  ]) {
    assert.match(p.DIGEST_INSTRUCTION, new RegExp(field));
  }
  assert.match(p.DIGEST_INSTRUCTION, /作者、读者或人物/);
});

test('buildBookTitleInstruction 带 premise、大纲和纯标题限制', () => {
  const s = p.buildBookTitleInstruction('赛博侦探', '主角追查意识失踪案');
  assert.match(s, /赛博侦探/);
  assert.match(s, /意识失踪案/);
  assert.match(s, /10\s*字/);
  assert.match(s, /只输出书名/);
});

test('buildSectionsInstruction 明确要求返回包含 sections 的 JSON 对象', () => {
  const instruction = p.buildSectionsInstruction('全书大纲');
  assert.match(instruction, /JSON 对象/);
  assert.match(instruction, /"sections"/);
  for (const field of ['promise', 'goal', 'obstacle', 'progress', 'climax', 'payoff', 'stateChange']) {
    assert.match(instruction, new RegExp(field));
  }
  assert.match(instruction, /相邻分部要有因果和升级/);
  assert.doesNotMatch(instruction, /JSON 数组/);
});

test('buildOutlineInstruction 注入长篇主线、目标尺度和人物选择框架', () => {
  const instruction = p.buildOutlineInstruction('落魄术士追查旧案');
  assert.match(instruction, /承诺（Promise）—推进（Progress）—兑现（Payoff）/);
  assert.match(instruction, /长期欲望、中期目标和当前行动/);
  assert.match(instruction, /关键选择、代价和主要关系变化/);
  assert.match(instruction, /阶段高潮、状态变化、对主线的推进/);
  assert.match(instruction, /尚待回收的主线承诺、人物线和关键伏笔/);
});

test('buildSystemPrompt 兼容版本化 core', () => {
  const s = buildSystemPrompt({
    world: { versions: ['赛博都市'], cursor: 0 },
    style: { versions: ['冷硬'], cursor: 0 },
    constraints: { versions: [''], cursor: 0 },
    pacing: { versions: [''], cursor: 0 },
  });
  assert.match(s, /赛博都市/);
  assert.match(s, /冷硬/);
});

test('buildChapterReviewInstruction 包含正文、包装承诺上下文和 JSON 格式约束', () => {
  const ctx = p.buildContext({
    book: {
      title: '万界小店', premise: '主角经营一家连通万界的商店。',
      outline: { content: '全书大纲' }, characters: [],
    },
    section: { outline: { content: '本部大纲' }, summary: '前情', characters: [] },
  });
  const ins = p.buildChapterReviewInstruction({ chapterIndex: 3, content: '第3章正文', context: ctx });
  assert.match(ins, /第3章/);
  assert.match(ins, /第3章正文/);
  assert.match(ins, /全书大纲/);
  assert.match(ins, /万界小店/);
  assert.match(ins, /主角经营一家连通万界的商店/);
  assert.match(ins, /score/);
  assert.match(ins, /verdict/);
  assert.match(ins, /issues/);
  assert.match(ins, /suggestions/);
  assert.match(ins, /webFictionChecks/);
  assert.match(ins, /webFictionSignals/);
  assert.match(ins, /conflictType/);
  assert.match(ins, /payoffType/);
  assert.match(ins, /goldenChapter/);
  assert.match(ins, /effectiveIncrement/);
  assert.match(ins, /endingHook/);
  assert.match(ins, /longArcProgress/);
  assert.match(ins, /styleConsistency/);
  assert.match(ins, /packagingPromise/);
  assert.match(ins, /contentRisk/);
  assert.match(ins, /不得声称已经合规/);
  assert.match(ins, /书名、作品简介\/初始设想和当前正文/);
  assert.match(ins, /合理的战斗、对话、悬疑、感情、日常或高潮场景变化不得机械判 risk/);
  assert.match(ins, /主线承诺、重要人物线或伏笔是否已有长期未推进风险/);
  assert.match(ins, /固定以打斗、穿越、系统或同一种事故开场/);
  assert.match(ins, /节奏平直/);
  assert.match(ins, /密集比喻/);
  assert.match(ins, /不能只有“加强描写”“提升节奏”等空话/);
  assert.match(ins, /是否付出或承担与选择匹配的代价/);
  assert.match(ins, /关键因果必须能从正文和所给上下文追溯/);
  assert.match(ins, /临时补出的便利设定/);
});

test('生成与审稿使用最近章节节奏记录，且不要求机械轮换', () => {
  const recentReviewSignals = [{
    bookChapterIndex: 8,
    sectionChapterIndex: 3,
    signals: {
      chapterFunction: '冲突推进', conflictType: '追逐', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
    },
  }, {
    bookChapterIndex: 9,
    sectionChapterIndex: 4,
    signals: null,
  }];
  const chapter = p.buildChapterInstruction({
    chapterIndex: 5, bookChapterIndex: 10, wordTarget: 2000, mode: 'next',
    recentReviewSignals,
  });
  const review = p.buildChapterReviewInstruction({
    chapterIndex: 5, bookChapterIndex: 10, content: '正文', context: '',
    recentReviewSignals,
  });
  for (const output of [chapter, review]) {
    assert.match(output, /最近章节节奏记录/);
    assert.match(output, /全书第 8 章/);
    assert.match(output, /冲突=追逐/);
    assert.match(output, /爽点\/兑现=脱险/);
    assert.match(output, /全书第 9 章：尚无有效节奏记录/);
    assert.match(output, /不为追求机械轮换而破坏当前剧情因果/);
  }
});

test('黄金三章按全书章序分别注入职责，不在新分部重新计数', () => {
  const first = p.buildChapterInstruction({
    chapterIndex: 1, bookChapterIndex: 1, wordTarget: 2000, mode: 'next',
  });
  const second = p.buildChapterInstruction({
    chapterIndex: 2, bookChapterIndex: 2, wordTarget: 2000, mode: 'next',
  });
  const third = p.buildChapterInstruction({
    chapterIndex: 3, bookChapterIndex: 3, wordTarget: 2000, mode: 'next',
  });
  const nextSection = p.buildChapterInstruction({
    chapterIndex: 1, bookChapterIndex: 20, wordTarget: 2000, mode: 'next',
  });

  assert.match(first, /人物处境、核心欲望或异常事件/);
  assert.match(second, /这本书主要看什么/);
  assert.match(third, /阶段性兑现或明确转折/);
  assert.doesNotMatch(nextSection, /黄金第[一二三]章职责/);

  const laterReview = p.buildChapterReviewInstruction({
    chapterIndex: 1, bookChapterIndex: 20, content: '新分部正文', context: '',
  });
  assert.match(laterReview, /它是全书第 20 章/);
  assert.match(laterReview, /不得把每个分部的前三章重新当作黄金三章/);
  assert.match(laterReview, /goldenChapter 与 premisePromise 两项必须标为 na/);
});

test('buildCoreFieldInstruction 生成该字段指令', () => {
  const book = {
    premise: '一个侦探故事',
    settings: { core: {
      world: { versions: ['旧世界观'], cursor: 0 },
      style: { versions: ['冷硬'], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
  };
  const ins = buildCoreFieldInstruction('world', book);
  assert.match(ins, /世界观/);
  assert.match(ins, /一个侦探故事/);
  assert.match(ins, /冷硬/);          // 带上其它字段作参照
});

test('提示词构建在拼接超大数据前终止', () => {
  const oversized = 'x'.repeat(MAX_LLM_INPUT_CHARS + 1);
  assert.match(p.buildSystemPrompt({ world: oversized }), /中间内容已省略/);
  assert.throws(() => p.buildOutlineInstruction(oversized), /LLM_INPUT_TOO_LARGE/);
  assert.throws(() => p.buildChapterReviewInstruction({
    chapterIndex: 1, content: oversized, context: '',
  }), /LLM_INPUT_TOO_LARGE/);
  assert.match(p.buildContext({
    book: { outline: { content: oversized } },
    section: {},
  }), /中间内容已省略/);
});

test('文风资产提取提示词要求抽象分析、证据等级和严格 JSON', () => {
  const instruction = p.buildWritingAssetExtractionInstruction({
    sourceName: '自有章节', sourceKind: 'self', sourceText: '样本文本',
  });
  assert.match(p.WRITING_ASSET_ANALYST_SYSTEM_PROMPT, /不是续写或仿写/);
  assert.match(p.WRITING_ASSET_ANALYST_SYSTEM_PROMPT, /不得复述原文/);
  assert.match(p.WRITING_ASSET_ANALYST_SYSTEM_PROMPT, /不得要求模仿/);
  assert.match(instruction, /"style"/);
  assert.match(instruction, /"story"/);
  assert.match(instruction, /evidenceLevel/);
  assert.match(instruction, /dialogueRatio/);
  assert.match(instruction, /emotionTemperature/);
  assert.match(instruction, /conflictFrequency/);
  assert.match(instruction, /payoffType/);
  assert.match(instruction, /uncertainties/);
  assert.match(instruction, /样本文本/);
});

test('绑定创作资产作为抽象文风约束进入系统提示词', () => {
  const system = p.buildSystemPrompt(
    { style: { content: '本书原有文风' } },
    '【已绑定创作资产】\n使用克制短句，并避免空泛总结。',
  );
  assert.match(system, /本书原有文风/);
  assert.match(system, /已绑定创作资产/);
  assert.match(system, /使用克制短句/);
});

test('独立标题分工只读取受限摘要并要求严格 JSON', () => {
  const instruction = p.buildChapterTitlesInstruction({
    chapterIndex: 12, summary: '雨夜追凶', progress: '真凶留下新线索',
  });
  assert.match(instruction, /第 12 章/);
  assert.match(instruction, /chapterTitle/);
  assert.match(instruction, /sectionTitle/);
  assert.match(instruction, /不要序号/);
});
