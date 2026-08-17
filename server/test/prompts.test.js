import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../prompts.js';
import { buildCoreFieldInstruction, buildSystemPrompt } from '../prompts.js';
import { validChapterPlanFixture } from './chapter-plan-fixture.js';
import {
  MAX_CHARACTER_PROMPT_SCOPE_CHARS, MAX_LLM_INPUT_CHARS, MAX_VERSION_TEXT_CHARS,
  MAX_SECTION_PROMPT_SUMMARY_CHARS, MAX_WHIP_CHARS,
  MAX_CHAPTER_PLAN_SOURCE_PROMPT_CHARS,
} from '../limits.js';

test('buildSystemPrompt 跳过空字段', () => {
  const s = p.buildSystemPrompt({ world: '赛博深圳', style: '', constraints: '不写主角死', pacing: '' });
  assert.match(s, /赛博深圳/);
  assert.match(s, /不写主角死/);
  assert.doesNotMatch(s, /文风基调/);
});

test('作品核心循环进入写作系统提示词但不要求每章机械重复', () => {
  const system = p.buildSystemPrompt({}, '', {
    readerExperience: '看文明火种在绝境中进化',
    protagonistAction: '推演并选择是否干预',
    progression: '获得能量与干预权限',
    cost: '现实产生对应伤亡',
    escalation: '从聚落扩大到多文明战争',
  });
  assert.match(system, /作品核心循环/);
  assert.match(system, /读者反复期待的体验：看文明火种在绝境中进化/);
  assert.match(system, /行动代价 \/ 新债务：现实产生对应伤亡/);
  assert.match(system, /不是要求每章机械重复全部步骤/);
});

test('buildSystemPrompt 固化长篇网文创作准则', () => {
  const s = p.buildSystemPrompt({});
  assert.match(s, /长篇连载/);
  assert.match(s, /不用抽象总结代替关键场景/);
  assert.match(s, /替读者总结的主题句/);
  assert.match(s, /每章都要改变故事状态/);
  assert.match(s, /爽点不是只指打赢/);
  assert.match(s, /数量、时间、地点/);
  assert.match(s, /至少发生两次有因果的压力变化/);
  assert.match(s, /伏笔作为物件、动作、矛盾或一个错误判断参与当前场景/);
  assert.match(s, /密集抛出的专有名词读者记不住/);
  assert.match(s, /唯一冲突优先级/);
});

test('完整章节调用只保留一份冲突优先级和一份章末连续性硬约束', () => {
  const full = [
    p.buildSystemPrompt({}),
    p.buildContext({
      book: {}, section: {},
      prevChapter: { content: '章末动作尚未完成', characters: [] },
    }),
    p.buildChapterInstruction({ chapterIndex: 2, wordTarget: 3000, mode: 'next' }),
  ].join('\n');
  assert.equal((full.match(/唯一冲突优先级/gu) ?? []).length, 1);
  assert.equal((full.match(/上一章末态是本章的真实起点/gu) ?? []).length, 1);
  assert.equal((full.match(/信息不足时保留未知/gu) ?? []).length, 1);
});

test('世界圣经作为作者后台全貌进入系统提示词，但不得越权泄密', () => {
  const system = p.buildSystemPrompt({
    world: { content: '【一句话世界钩子】火种会改写现实伤亡。\n【秘密分层与认知边界】作者知道终局，主角目前不知道。' },
  });
  assert.match(system, /世界圣经是作者后台全貌/);
  assert.match(system, /不等于读者或角色已经知道/);
  assert.match(system, /从已发生摘要、已确认长期记忆、人物知识边界和本章策划判断“当前已知”/);
  assert.match(system, /已经揭示的规则应直接用于行动/);
  assert.match(system, /尚未揭示的内容只留下符合当前视角的结果、矛盾或痕迹/);
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
  assert.match(ctx, /上下文分层：材料的性质不同/);
  assert.match(ctx, /A\. 已发生事实与当前连续性/);
  assert.match(ctx, /B\. 作品方向与未来计划（不是已发生事实）/);
  assert.match(ctx, /C\. 阅读债务与作者导演信息（不是公开事实）/);
  assert.match(ctx, /后续走向建议（不是事实或已确认计划）.*去仓库/su);
});

test('提示词只读路径把显式 null 交接快照降级为空，不让旧数据阻断生成', () => {
  assert.doesNotThrow(() => p.buildContext({
    book: {}, section: {}, prevChapter: { content: '结尾', handoff: null },
  }));
  assert.doesNotMatch(p.previousChapterHandoffText(null), /./u);
});

test('buildContext 把上一章场景交接快照与后续建议分开，原文优先', () => {
  const ctx = p.buildContext({
    book: { characters: [] }, section: { characters: [] },
    prevChapter: {
      content: '林越的手还按在号棚门上。', progress: '下章去查灯塔', characters: [],
      handoff: {
        viewpoint: '林越', time: '暴雨夜', location: '码头号棚',
        ongoingAction: '正推门', immediatePressure: '追兵靠近', characterState: '左臂受伤',
        resourceState: '账册在手', knowledgeBoundary: '尚不知门后是谁', unresolvedCausality: '推门动作未完',
      },
    },
  });
  assert.match(ctx, /上一章场景交接快照/);
  assert.match(ctx, /正在进行的动作：正推门/);
  assert.match(ctx, /与上一章原文或已确认事实冲突，以原文和已确认事实为准/);
  assert.match(ctx, /后续走向建议（不是事实或已确认计划）/);
});

test('buildContext 优先装入本章策划直接点名的久远长期事实', () => {
  const facts = Array.from({ length: 140 }, (_, index) => ({
    id: `memory_${index.toString(16).padStart(32, '0')}`,
    kind: 'item', subject: `普通遗物${index}`, predicate: '限制',
    object: `只能由第${index}位守门人使用${'旧'.repeat(70)}`,
    importance: 5, status: 'active', source: { chapterIndex: index + 1 },
    updatedAt: new Date(Date.UTC(2026, 0, (index % 28) + 1)).toISOString(),
  }));
  facts.push({
    id: `memory_${'f'.repeat(32)}`, kind: 'item', subject: '沉星钥匙',
    predicate: '真实限制', object: '只能开启一次北境星门', importance: 1,
    status: 'active', source: { chapterIndex: 3 }, updatedAt: '2001-01-01T00:00:00.000Z',
  });

  const ctx = p.buildContext({
    book: { memory: { facts }, characters: [] }, section: { characters: [] },
    chapterPlan: { goal: '夺回沉星钥匙并赶赴北境' },
  });

  assert.match(ctx, /沉星钥匙｜真实限制｜只能开启一次北境星门/);
  assert.match(ctx, /其它已确认记忆因上下文预算省略/);
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

test('抽打指令携带用户要求，静态执行清单由 system 统一注入', () => {
  const system = p.buildSystemPrompt({});
  const instruction = p.buildChapterInstruction({
    chapterIndex: 3, wordTarget: 4000, mode: 'whip', whip: '太平淡，加冲突',
  });
  assert.match(instruction, /太平淡，加冲突/);
  assert.match(instruction, /目标体量约 4000 字/);
  assert.match(instruction, /黄金第三章职责/);
  assert.match(system, /人物想要什么、被什么挡住、做了什么选择、付出了什么/);
  assert.match(system, /这一章有收获/);
  assert.match(system, /硬约束：连续性与知识边界/);
  assert.match(system, /由他自己的能力、关系或选择改变/);
  assert.doesNotMatch(instruction, /硬约束：连续性与知识边界/);
});

test('后续普通章节的静态执行清单只存在于 system，user 保留动态材料', () => {
  const system = p.buildSystemPrompt({});
  const instruction = p.buildChapterInstruction({
    chapterIndex: 8, wordTarget: 2500, mode: 'next',
  });
  assert.match(system, /硬约束：连续性与知识边界/);
  assert.match(system, /判断依据：读者为什么会继续读/);
  assert.match(system, /不是需要逐条满足的清单/);
  assert.match(system, /这一章有收获.*下一章有期待/);
  assert.match(system, /读者会失去对主角的认同/);
  assert.match(system, /全章保持同一强度会让读者疲劳/);
  assert.match(system, /伏笔作为物件、动作、矛盾或一个错误判断参与当前场景/);
  assert.match(system, /密集抛出的专有名词读者记不住/);
  assert.match(system, /替读者总结的主题句/);
  assert.doesNotMatch(instruction, /硬约束：连续性与知识边界/);
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

test('章节生成与审稿都读取作者策划卡，但要求落实为正文而非复述', () => {
  const chapterPlan = {
    goal: '拿到账册', obstacle: '巡逻提前返回', choice: '主角暴露卧底身份',
    payoff: '救下旧敌', hook: '账册夹层出现父亲名字', notes: '不要烧毁账册',
    tensionArc: '潜入顺利→巡逻提前返回→旧敌拦路→坦白换来合作→身份暴露留下余波',
    foreshadowing: '回收旧敌误会，用夹层笔迹推进父亲失踪线但不解释来历',
    worldExpansion: '账册印章证明命令来自城外监察区，不揭示上层组织',
    scenes: [{
      title: '库房相遇', trigger: '上一章查到失窃账册被送进库房',
      desire: '主角想先拿到账册', obstacle: '旧敌堵住出口',
      action: '主角坦白卧底身份', turn: '旧敌转而挡住巡逻', cost: '身份彻底暴露',
    }],
  };
  const generated = p.buildChapterInstruction({
    chapterIndex: 8, wordTarget: 2000, mode: 'rewrite', currentContent: '旧正文',
    chapterPlan,
  });
  const generatedWithSystem = `${p.buildSystemPrompt({})}\n${generated}`;
  assert.match(generated, /本章策划卡（作者意图）/);
  assert.match(generated, /本章目标：拿到账册/);
  assert.match(generated, /关键选择：主角暴露卧底身份/);
  assert.match(generated, /张力曲线：潜入顺利/);
  assert.match(generated, /分层埋点：回收旧敌误会/);
  assert.match(generated, /世界边界扩张：账册印章/);
  assert.match(generated, /场景链（作者规划的发生顺序）/);
  assert.match(generated, /承接触发=上一章查到失窃账册/);
  assert.match(generatedWithSystem, /删掉前一场，后一场是否仍能原样发生/);
  assert.match(generated, /行动=主角坦白卧底身份/);
  assert.match(generated, /每场结束都要改变局势/);
  assert.match(generated, /不能逐条复述策划卡/);
  assert.match(generated, /策划卡同时定义本章的叙事范围/);
  assert.match(generated, /章末钩子之后的重大选择、身份变化、入口执行、谜底或下一章行动不得在本章提前完成/);
  assert.match(generated, /只写到选择成立并产生压力/);

  const reviewed = p.buildChapterReviewInstruction({
    chapterIndex: 8, content: '新正文', context: '全书上下文', chapterPlan,
  });
  assert.match(reviewed, /账册夹层出现父亲名字/);
  assert.match(reviewed, /未落到场景中的意图应判为风险/);
  assert.match(reviewed, /逐场核对欲望、阻碍、行动、转折和代价/);
  assert.match(reviewed, /tensionDynamics/);
  assert.match(reviewed, /foreshadowingExecution/);
  assert.match(reviewed, /worldExpansion/);
  assert.match(reviewed, /proseHumanity/);
  assert.match(reviewed, /策划—成稿差异回顾/);
  assert.match(reviewed, /goal=本章目标/);
  assert.match(reviewed, /scene-1=场景 1/);
  assert.match(reviewed, /planComparison/);
  assert.match(reviewed, /不得把策划当成已发生事实/);
});

test('章节策划、正文和审稿把宏大世界落实为既有规则、证据、选择与代价', () => {
  const sectionContract = [
    '【世界层级】当前生活圈', '【世界阶段承诺】看见城内规则的代价',
    '【可验证世界证据】通行牌当场失效', '【人物行动】主角查验通行牌',
    '【世界选择与代价】主角保住证人却失去身份', '【阶段认知增量】确认制度网络参与追杀',
    '【本部保留未知】不揭示跨区上层组织', '【下一层门槛】拿到跨区组织名单',
    '【门槛结果】本部不解锁下一层', '【门槛证据进度】目前只有城内流转记录',
  ].join('\n');
  const sharedContext = p.buildContext({
    book: { characters: [], memory: {}, settings: {} },
    section: { outline: { content: sectionContract }, characters: [] },
  });
  const plan = p.buildChapterPlanDraftInstruction({
    chapterIndex: 21, bookChapterIndex: 21, context: sharedContext,
    seedPlan: {},
  });
  const chapter = `${p.buildSystemPrompt({})}\n${sharedContext}\n${p.buildChapterInstruction({
    chapterIndex: 21, bookChapterIndex: 21, wordTarget: 3000, mode: 'next',
    chapterPlan: { worldExpansion: '既有制度留下物证，迫使主角改变路线并付出代价' },
  })}`;
  const review = p.buildChapterReviewInstruction({
    chapterIndex: 21, bookChapterIndex: 21, content: '正文', context: sharedContext,
    chapterPlan: { worldExpansion: '既有制度留下物证，迫使主角改变路线并付出代价' },
  });
  assert.match(plan, /世界圣经与既有大纲为上限/);
  assert.match(plan, /读者与当前视角人物在本章开始时已经知道什么/);
  assert.match(plan, /边界增量\/机制深化/);
  assert.match(plan, /选择与代价/);
  assert.match(plan, /门槛未由已发生正文完成时/);
  assert.match(chapter, /密集抛出的专有名词读者记不住/);
  assert.match(chapter, /本部当前世界执行合同/);
  assert.match(review, /调用上下文中已有世界规则、势力利益或历史后果/);
  assert.match(review, /临时发明世界圣经外的万能层级/);
  assert.match(review, /提前泄露本部保留未知/);
});

test('新版质量合同进入正文与审稿，但明确禁止把策划标签写进小说', () => {
  const chapterPlan = {
    qualityProtocolVersion: 2,
    tensionArc: '压力来源：封站；变化链：闸机关闭→主角破门→警报响起；选择高点：主角继续潜入；兑现与余波：进入站台但暴露',
    foreshadowing: '旧线/阅读债务：推进内鬼线；具体载体：车票；当下作用：验证身份；行动影响：主角改道；保留未知：内鬼身份',
    worldExpansion: '展开前认知：主角与读者只知道本城封锁；既有依据：封锁制度；可验证证据：城外印章；边界增量/机制深化：主角与读者确认跨区；选择与代价：越区受追捕；保留未知：上层组织',
  };
  const generated = p.buildChapterInstruction({
    chapterIndex: 8, wordTarget: 2000, mode: 'next', chapterPlan,
  });
  const reviewed = p.buildChapterReviewInstruction({
    chapterIndex: 8, content: '正文', context: '全书上下文', chapterPlan,
  });
  for (const instruction of [generated, reviewed]) {
    assert.match(instruction, /策划卡各字段想解决的问题|新版章节质量合同/);
    assert.match(instruction, /不是需要在正文里出现的标签|不得把标签写进正文/);
    assert.match(instruction, /让证据迫使人物选择并承担后果|证据必须迫使人物选择并付出代价/);
    assert.match(instruction, /决策因果/);
    assert.match(instruction, /保留至少两个当时同样合理的解释|至少保留两个当时合理的替代解释/);
  }
  assert.match(reviewed, /展开前认知|既有依据→证据→边界增量→选择代价→保留未知/);
  assert.match(generated, /编辑后台锚点/);
  assert.match(generated, /都不能出现在正文、对话或叙述中/);
  // 只保留会污染正文的后台锚点作为硬约束，其余改为说明原因。
  assert.match(generated, /怎么落地由你根据本章判断/);
  assert.match(generated, /读者记住的是有用的东西，不是被点名的东西/);
  assert.match(reviewed, /后台债务 ID 不得出现在小说正文/);
});

test('AI 先生成结构化叙事骨架，关系余波可选择无认知任务', () => {
  const instruction = p.buildNarrativeDesignDraftInstruction({
    chapterIndex: 8,
    context: '上一章已确认弟弟卖掉祖屋，本章只处理姐弟照护关系，不新增秘密。',
    seedPlan: { goal: '决定是否共同照顾母亲' },
    previousPlan: validChapterPlanFixture(),
    previousChapter: {
      content: '前文行动已经完成。\n\n章末保安说车牌后三位是三七几，这个数字已经被主角听见。',
      handoff: { knowledgeBoundary: '主角已经知道车牌后三位是三七几' },
    },
  });
  assert.match(instruction, /前章连续性账本/);
  assert.match(instruction, /凭证仍能开门但已被中央追踪/);
  assert.match(instruction, /不得换个载体再次发现同一结论/);
  assert.match(instruction, /前章正文结尾事实/);
  assert.match(instruction, /车牌后三位是三七几/);
  assert.match(instruction, /不得把它们原样包装成新线索/);
  assert.match(instruction, /对手已经使用 opponentCounteraction/);
  assert.match(instruction, /只解决两个问题/);
  assert.match(instruction, /harmedStakeholder/);
  assert.match(instruction, /counteraction/);
  assert.match(instruction, /responseChoice/);
  assert.match(instruction, /反制发生后，主角必须再次采取/);
  assert.match(instruction, /stateBefore/);
  assert.match(instruction, /stateAfter/);
  assert.match(instruction, /knowledge\.mode 只有 task 或 none/);
  assert.match(instruction, /不得为了填表新增遗嘱、信件、神秘物品/);
  assert.match(instruction, /不得引入上下文未建立的亲属、律师、医生、领导、调解人/);
  assert.match(instruction, /核心关系双方亲自完成并承担/);
  assert.match(instruction, /alternatives/);
  assert.match(instruction, /crossValidation/);
});

test('AI 章节策划只生成严格候选并优先保留作者当前草稿', () => {
  const instruction = p.buildChapterPlanDraftInstruction({
    chapterIndex: 2,
    bookChapterIndex: 2,
    context: '主角上一章决定连夜去车站',
    seedPlan: {
      goal: '找到证人', obstacle: '', choice: '', payoff: '', hook: '',
      notes: '不能烧毁账册', scenes: [],
    },
    currentContent: `开场${'中'.repeat(MAX_CHAPTER_PLAN_SOURCE_PROMPT_CHARS)}章末`,
    incomingPlanCarryover: {
      items: [{
        text: '找回上章遗失的钥匙', reason: '关系未解的密室', suggestedField: 'goal',
      }],
    },
  });
  assert.match(instruction, /只为第 2 章制作写前策划候选/);
  assert.match(instruction, /不要写正文，不要声称已经保存/);
  assert.match(instruction, /找到证人/);
  assert.match(instruction, /不能烧毁账册/);
  assert.match(instruction, /作者草稿中的明确限制和意图优先/);
  assert.match(instruction, /门槛、危险、期限或救援承诺/);
  assert.match(instruction, /职业与能力必须至少一次用于改变局面/);
  assert.match(instruction, /不能连续包办路线、工具和答案/);
  assert.match(instruction, /先安排人物据此行动并承受后果/);
  assert.match(instruction, /场景按发生顺序组成连续因果/);
  assert.match(instruction, /通常规划 2–6 场/);
  assert.match(instruction, /goal、obstacle、choice、payoff、hook、tensionArc/);
  assert.match(instruction, /designProtocolVersion 必须为 1/);
  assert.match(instruction, /利益受损者/);
  assert.match(instruction, /交叉验证/);
  assert.match(instruction, /无认知任务理由/);
  assert.match(instruction, /中间内容已省略/);
  assert.match(instruction, /上一完成章的未决策划项/);
  assert.match(instruction, /不是正文事实或必须执行的指令/);
  assert.match(instruction, /开场/);
  assert.match(instruction, /章末/);
});

test('DIGEST_INSTRUCTION 要求标题、摘要、人物、记忆与章末交接字段', () => {
  for (const field of [
    'chapterTitle', 'sectionTitle', 'summary', 'progress', 'characters', 'handoff',
  ]) {
    assert.match(p.DIGEST_INSTRUCTION, new RegExp(field));
  }
  for (const field of [
    'viewpoint', 'time', 'location', 'ongoingAction', 'immediatePressure',
    'characterState', 'resourceState', 'knowledgeBoundary', 'unresolvedCausality',
  ]) {
    assert.match(p.DIGEST_INSTRUCTION, new RegExp(field));
  }
  assert.match(p.DIGEST_INSTRUCTION, /只能依据本章正文结尾/);
  assert.match(p.DIGEST_INSTRUCTION, /不得从 progress、策划或预测补写/);
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
  const instruction = p.buildSectionsInstruction({ outline: '全书大纲' });
  assert.match(instruction, /JSON 对象/);
  assert.match(instruction, /"sections"/);
  for (const field of ['promise', 'goal', 'obstacle', 'progress', 'climax', 'payoff', 'stateChange']) {
    assert.match(instruction, new RegExp(field));
  }
  assert.match(instruction, /相邻分部要有因果和升级/);
  assert.match(instruction, /worldProgression/);
  assert.match(instruction, /gateOutcome/);
  assert.match(instruction, /当前生活圈/);
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
  assert.match(s, /文风执行边界/);
  assert.match(s, /不是要求每一段逐项展示的打卡清单/);
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
  assert.match(ins, /sceneExecution/);
  assert.match(ins, /effectiveIncrement/);
  assert.match(ins, /endingHook/);
  assert.match(ins, /tensionDynamics/);
  assert.match(ins, /foreshadowingExecution/);
  assert.match(ins, /worldExpansion/);
  assert.match(ins, /proseHumanity/);
  assert.match(ins, /longArcProgress/);
  assert.match(ins, /styleConsistency/);
  assert.match(ins, /“文风基调”或“已绑定创作资产”/);
  assert.match(ins, /局部资产只能细化可变维度/);
  assert.match(ins, /两者都没有时必须标 na/);
  assert.match(ins, /packagingPromise/);
  assert.match(ins, /contentRisk/);
  assert.match(ins, /不得声称已经合规/);
  assert.match(ins, /书名、作品简介\/初始设想和当前正文/);
  assert.match(ins, /合理的战斗、对话、悬疑、感情、日常或高潮场景变化不得机械判 risk/);
  assert.match(ins, /主线承诺、重要人物线或伏笔是否已有长期未推进、逾期未兑现或无因果销账风险/);
  assert.match(ins, /作品核心循环、承诺—推进—兑现账本、全书\/本部大纲/);
  assert.match(ins, /固定以打斗、穿越、系统或同一种事故开场/);
  assert.match(ins, /节奏平直/);
  assert.match(ins, /密集比喻/);
  assert.match(ins, /负兑现/);
  assert.match(ins, /配角是否长期只负责带路、递工具和讲设定/);
  assert.match(ins, /不能只有“加强描写”“提升节奏”等空话/);
  assert.match(ins, /是否付出或承担与选择匹配的代价/);
  assert.match(ins, /关键因果必须能从正文和所给上下文追溯/);
  assert.match(ins, /临时补出的便利设定/);
  assert.match(ins, /禁止只写“有 AI 味”/);
  assert.match(ins, /proseHumanity、expressionBalance、repetitionRisk 或 styleConsistency 为 risk/);
  assert.match(ins, /虚构引文/);
  assert.match(ins, /引文至少6个字且在当前章中必须唯一/);
  assert.match(ins, /扩大前后文/);
  assert.match(ins, /明喻堆叠/);
  assert.match(ins, /成片连续短段金句腔/);
  assert.match(ins, /最长连续短段串/);
  assert.match(ins, /自然对话短段/);
  assert.match(ins, /单个贴切比喻/);
  assert.match(ins, /破折号集中替代正常句法/);
  assert.match(ins, /每千字密度、段落集中度与最长连续短段串/);
  assert.match(ins, /payoffEvidence/);
  assert.match(ins, /goldenEvidence/);
  assert.match(ins, /fulfillmentQuote/);
  assert.match(ins, /不能因为章序属于前三章/);
  assert.match(ins, /premiseEvidence/);
  assert.match(ins, /deliveryQuote/);
  assert.match(ins, /由作者解释“这就是本书卖点”/);
  assert.match(ins, /goalEvidence/);
  assert.match(ins, /attemptQuote/);
  assert.match(ins, /人物只说口号却全章没有尝试/);
  assert.match(ins, /obstacleEvidence/);
  assert.match(ins, /escalatedQuote/);
  assert.match(ins, /连续加入无关事故/);
  assert.match(ins, /sceneEvidence/);
  assert.match(ins, /reactionQuote/);
  assert.match(ins, /只播报最终结果/);
  assert.match(ins, /incrementEvidence/);
  assert.match(ins, /stateQuote/);
  assert.match(ins, /忙碌一章又回到原位/);
  assert.match(ins, /choiceEvidence/);
  assert.match(ins, /pressureQuote/);
  assert.match(ins, /他人替主角决定/);
  assert.match(ins, /costEvidence/);
  assert.match(ins, /consequenceQuote/);
  assert.match(ins, /hookEvidence/);
  assert.match(ins, /setupQuote/);
  assert.match(ins, /tensionEvidence/);
  assert.match(ins, /aftermathQuote/);
  assert.match(ins, /只增加紧张形容词/);
  assert.match(ins, /longArcEvidence/);
  assert.match(ins, /progressQuote/);
  assert.match(ins, /角色口头说“以后再查”/);
  assert.match(ins, /此前毫无关联的来电、敲门、爆炸/);
  assert.match(ins, /一切资源、关系与行动空间照旧/);
  assert.match(ins, /actionQuote/);
  assert.match(ins, /结果原句必须出现在行动原句之后/);
  assert.match(ins, /敌人自行放弃/);
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
    assert.match(output, /系统分析是风险提示，不是轮换命令/);
  }
});

test('最近章节受控指纹触发可解释的跨章重复风险', () => {
  const fingerprint = {
    pressurePattern: 'false-relief', resolutionMethod: 'sacrifice',
    payoffScale: 'chapter', hookMechanism: 'new-threat', costType: 'relationship',
  };
  const recentReviewSignals = [7, 8, 9].map((bookChapterIndex) => ({
    bookChapterIndex, sectionChapterIndex: bookChapterIndex,
    signals: {
      chapterFunction: '转折', conflictType: '追捕', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动', rhythmFingerprint: fingerprint,
    },
  }));
  const output = p.buildChapterInstruction({
    chapterIndex: 10, bookChapterIndex: 10, wordTarget: 2000, mode: 'next',
    recentReviewSignals,
  });
  assert.match(output, /受控节奏指纹/);
  assert.match(output, /系统确定性重复分析/);
  assert.match(output, /连续使用破局方式“主动牺牲”/);
  assert.match(output, /不能只换名词/);
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
    title: '雾城名单',
    premise: '一个侦探故事',
    outline: { versions: ['侦探从街区失踪案追到城市权力结构'], cursor: 0 },
    settings: { core: {
      world: { versions: ['旧世界观'], cursor: 0 },
      style: { versions: ['冷硬'], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    }, storyEngine: {
      readerExperience: '看证据反转权力叙事', protagonistAction: '调查失踪者',
      progression: '取得新证据', cost: '暴露盟友', escalation: '从街区升级到整座城市',
    } },
  };
  const ins = buildCoreFieldInstruction('world', book);
  assert.match(ins, /世界圣经/);
  assert.match(ins, /一个侦探故事/);
  assert.match(ins, /冷硬/);          // 带上其它字段作参照
  assert.match(ins, /侦探从街区失踪案追到城市权力结构/);
  assert.match(ins, /看证据反转权力叙事/);
  assert.match(ins, /当前世界观草稿.*旧世界观/s);
  assert.match(ins, /至少 1800 字符/);
  assert.match(ins, /【一句话世界钩子】/);
  assert.match(ins, /【分阶段揭示路线】/);
  assert.match(ins, /【持续看点与标志性场面】/);
  assert.match(ins, /【秘密分层与认知边界】/);
  for (const label of ['〔日常生计〕', '〔规则博弈〕', '〔关系交换〕', '〔势力冲突〕', '〔探索发现〕', '〔阶段兑现〕']) {
    assert.match(ins, new RegExp(label.replace(/[〔〕]/gu, '\\$&')));
  }
  assert.match(ins, /看点：具体内容；行动：具体内容；阻碍：具体内容；代价：具体内容；变奏边界：具体内容/);
  for (const label of ['〔作者底层真相〕', '〔当前读者已知〕', '〔当前主角已知〕', '〔关键势力认知差〕', '〔下一阶段可验证〕', '〔保留未知〕']) {
    assert.match(ins, new RegExp(label.replace(/[〔〕]/gu, '\\$&')));
  }
  assert.match(ins, /【禁止便利设定与保留未知】/);
  assert.match(ins, /至少三个只能由本书规则催生的标志性场面原型/);
  assert.match(ins, /去掉全部专名后若仍能直接套进同题材作品/);
  assert.match(ins, /前期、中期、长线三个不同的剧情发动机/);
  assert.doesNotMatch(ins, /200 字内/);

  const style = buildCoreFieldInstruction('style', book);
  assert.match(style, /文风圣经/);
  assert.match(style, /至少 1000 字符/);
  assert.match(style, /【叙事视角与距离】/);
  assert.match(style, /【稳定锚点、可变范围与禁止表达】/);
  assert.match(style, /删掉“细腻、克制、沉浸、电影感”等形容词后是否仍可执行/);
  assert.match(style, /战斗与安静对话两种场景/);
  assert.match(style, /避免模型只会回避而不会写/);
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
  assert.match(system, /局部抽象参考/);
  assert.match(system, /不能覆盖文风圣经的稳定锚点/);
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

test('buildChapterInstruction 注入体量与质感的写前背景而非禁令', () => {
  const instruction = p.buildChapterInstruction({
    chapterIndex: 9, wordTarget: 4_000, mode: 'next',
  });
  assert.match(instruction, /体量与质感的写前背景/);
  assert.match(instruction, /单章目标体量约 4000 字/);
  assert.match(instruction, /按千字获得订阅收入/);
  assert.match(instruction, /供你自查的信号，不是需要打勾的指标/);
  assert.match(instruction, /人类作者的章节密度是不均匀的/);
  assert.match(instruction, /本章哪一场值得放慢，由你根据剧情判断/);
});

test('buildChapterInstruction 两处目标字数保持一致', () => {
  const instruction = p.buildChapterInstruction({
    chapterIndex: 9, wordTarget: 1_500, mode: 'next',
  });
  assert.match(instruction, /单章目标体量约 3000 字/);
  assert.match(instruction, /目标体量约 3000 字/);
  assert.doesNotMatch(instruction, /1500/);
});

test('buildChapterInstruction 把最近章节的退化统计交给模型且不含正文原文', () => {
  const shrinking = [
    { bookChapterIndex: 6, prose: { chars: 3_000, paragraphs: 150, avgParagraphChars: 20, dialogueRatio: 40, sensoryHits: 30, sensoryDensity: 10, longestNarrationChars: 400 } },
    { bookChapterIndex: 7, prose: { chars: 2_200, paragraphs: 130, avgParagraphChars: 17, dialogueRatio: 45, sensoryHits: 12, sensoryDensity: 5.5, longestNarrationChars: 260 } },
    { bookChapterIndex: 8, prose: { chars: 1_400, paragraphs: 80, avgParagraphChars: 18, dialogueRatio: 44, sensoryHits: 4, sensoryDensity: 2.9, longestNarrationChars: 150 } },
  ];
  const instruction = p.buildChapterInstruction({
    chapterIndex: 9, wordTarget: 4_000, mode: 'next', recentReviewSignals: shrinking,
  });
  assert.match(instruction, /你最近几章的实际表现/);
  assert.match(instruction, /全书第 8 章：1400 字符/);
  assert.match(instruction, /字数连续下滑/);
  assert.match(instruction, /你看不到自己跨章的变化趋势，而读者能直接感受到/);
  assert.match(instruction, /可以偏离它们/);

  const stable = p.buildChapterInstruction({
    chapterIndex: 9, wordTarget: 4_000, mode: 'next',
  });
  assert.doesNotMatch(stable, /你最近几章的实际表现/);
});
