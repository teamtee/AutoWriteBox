import {
  MAX_CHAPTER_PLAN_SOURCE_PROMPT_CHARS, MIN_CHAPTER_BODY_CHARS,
} from './limits.js';
import { boundedJoin } from './prompt-join.js';
import { budgetTrimNotice } from './context-budget.js';
import {
  generationBookOutlineText, generationChapterContent,
  generationCharacterRows, generationCoreFieldText,
  generationPriorSectionSummary, generationTextWindow,
  generationChapterMemoryRows,
  generationCharacterCraftRelevantText, generationMemoryTaskRelevantText,
  generationMemoryRelevantText, generationMemoryRows, generationSectionOutlineText,
  previousChapterEndingText, previousChapterHandoffText, recentSectionSummary,
} from './generation-context.js';
import { normalizeChapterPlan } from './chapter-plan-schema.js';
import { chapterPlanReviewTargets } from './chapter-plan-review-schema.js';
import { normalizeStoryEngine } from './story-engine-schema.js';
import { generationPromiseLedgerRows } from './promise-ledger-schema.js';
import { generationCharacterCraftRows } from './character-craft-schema.js';
import {
  WORLD_APPEAL_SCENE_FIELDS, WORLD_APPEAL_SCENE_LABELS,
  WORLD_BIBLE_EXECUTION_GUIDANCE, WORLD_BIBLE_SECTION_LABELS,
  WORLD_KNOWLEDGE_BOUNDARY_LABELS, WORLD_REVEAL_STAGE_FIELDS,
  WORLD_REVEAL_STAGE_LABELS,
} from './world-bible.js';
import {
  STYLE_BIBLE_EXECUTION_GUIDANCE, STYLE_BIBLE_SECTION_LABELS,
} from './style-bible.js';
import {
  CHAPTER_PLAN_NO_FORESHADOWING_FORMAT, CHAPTER_PLAN_NO_KNOWLEDGE_TASK_FORMAT,
  CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE, CHAPTER_PLAN_QUALITY_FORMATS,
  chapterPlanContinuityLedger,
} from './chapter-plan-quality.js';
import { sectionWorldContractPrompt } from './section-world-contract.js';
import { reviewableSectionWorldGate } from './chapter-review-world-schema.js';
import { worldProgressPrompt } from './world-progress-schema.js';
import {
  analyzeRecentChapterRhythm, formatChapterRhythmFingerprint,
} from './chapter-rhythm.js';
import {
  analyzeChapterProseTrend, formatChapterProseContext, formatChapterProseTrend,
} from './chapter-prose-metrics.js';

export {
  generationBookOutlineText, generationCharacterRows, generationCoreFieldText,
  generationPriorSectionSummary,
  generationMemoryRelevantText, generationMemoryRows, generationSectionOutlineText,
  previousChapterEndingText, recentSectionSummary,
  previousChapterHandoffText,
} from './generation-context.js';

function line(label, value) {
  return value ? boundedJoin([`【${label}】`, value, '\n']) : '';
}

export const STAGE_SUMMARY_SYSTEM_PROMPT = [
  '你是长篇网文的连续性编辑。',
  '你的任务是把一段连续分部摘要压缩成可供后续创作使用的阶段摘要。',
  '只能归纳来源中已发生的事实，不得补写、猜测或改写设定。',
].join('');

export function buildStageSummaryInstruction({ title, rows }) {
  const source = rows.map((row) => [
    `【第${row.index}部${row.title ? ` · ${row.title}` : ''}】\n`,
    row.summary || '（本部尚无可用摘要）',
  ].join('')).join('\n\n');
  return boundedJoin([
    `请为阶段「${title}」生成一份长程剧情摘要。\n`,
    '优先保留：主线目标及转折、人物关系变化、能力/物品/势力状态、时间地点、已埋未收伏笔、阶段结尾局面。\n',
    '按因果和时间顺序写，使后续模型不读原文也能接续；删去文风评价和无关细节。\n',
    '只输出摘要正文，不要 JSON、标题、代码块或解释。建议 600–1200 中文字。\n\n',
    '来源分部摘要：\n', source,
  ]);
}

// 读取可版本化字段的当前文本；兼容 {versions,cursor} / {content} / 字符串 / 空
function vtext(f) {
  if (!f) return '';
  if (Array.isArray(f.versions)) return f.versions[f.cursor] ?? '';
  if (typeof f.content === 'string') return f.content;
  return typeof f === 'string' ? f : '';
}

export const CONTEXT_PRIORITY_RULE = [
  '【唯一冲突优先级】禁忌硬约束 → 已发生事实 → 本章明确策划 → 长线大纲 → 表达偏好。',
  '信息不足时保留未知，禁止临时补万能设定。\n',
].join('');

export const WEB_FICTION_WRITING_PRINCIPLES = [
  '【长期网文创作准则】\n',
  '以下是创作正文时必须遵守的通用底线；本书的世界观、文风、禁忌和篇幅节奏是具体规范。\n',
  '1. 写具体的人、行动、对话与后果，不用抽象总结代替关键场景，不用百科说明代替剧情。\n',
  '2. 人物必须依据自身欲望、处境和已知信息行动；对话要有身份差异、潜台词和即时目的。\n',

  '3. 每章都要改变故事状态，至少推进剧情、关系、线索、能力、认知或情绪中的一项；',
  '安静章节也必须有选择、信息差或关系变化，不能只是过场。\n',
  '4. 爽点不是只指打赢：发现真相、展现能力、扳回一局、获得资源、情绪释放、关系兑现都可以。',
  '兑现必须由前文铺垫和人物选择产生，不能凭空送给主角。\n',
  '5. 章节应有压力与缓冲、蓄力与兑现，避免从头到尾同一强度；重要转折要写成场景，',
  '不要用一段概述匆忙烧掉本可持续展开的剧情。张力来自目标难度、信息差、关系变化与选择代价的变化，',
  '不是靠连续事故或所有人持续喊叫；一章内通常至少发生两次有因果的压力变化。\n',
  '6. 结尾留下由真实矛盾、未完成行动或新信息产生的牵引力，不用生硬断句制造假悬念。\n',
  '7. 输出前静默核对姓名、身份、数量、时间、地点、能力边界和人物知识边界，避免前后矛盾。\n',
  '8. 前文明确建立的门槛、危险和承诺不能在下一场无原因消失；必须由人物能力、选择、资源或代价解决，',
  '否则“轻松通过”是对读者预期的负兑现。\n',
  '9. 人物的职业、能力和重要关系要通过现场行动起作用，不能只写在设定里；',
  '连续揭密之间先让已有信息迫使人物行动并产生后果，避免向导带路、提问和讲解取代主角推进。',
].join('');

// 连续性与知识边界属于正确性：写错会让后续几十章的因果和悬念作废，
// 因此仍以硬约束表述。其余关于“怎么写才好看”的内容一律作为判断依据提供，
// 不做成逐条打勾的清单——模型为避免违规而写出的安全文本，
// 恰好就是读者说的“AI 味”。
export const CHAPTER_CONTINUITY_CONSTRAINTS = [
  '【硬约束：连续性与知识边界】\n',
  '只有下面三条属于“写错就是错”，不是风格取舍：\n',
  '1. 上一章末态是本章的真实起点。视角、时间地点、正在进行的动作、伤势、关系、物品和人物已知，',
  '不能在没有交代的情况下回到更早的状态。需要跳时、转场或换视角时，',
  '在正文里写出可感知的过渡与因果就可以，形式不限。\n',
  '2. 上下文中的“本部当前世界执行合同”说明读者此刻允许知道多少。',
  '世界圣经里的长线真相属于作者后台；人物没有获知过程时，它不能出现在正文、对话或旁白里。',
  '提前泄密会让后面几十章的悬念一次性作废，这是不可逆的损失。\n',
  '3. 作者秘密只驱动潜台词和人物选择。角色和旁白都不能替读者说破；',
  '读者自己推断出来才有效。\n',
].join('');

export const CHAPTER_CRAFT_CONTEXT = [
  '【判断依据：读者为什么会继续读】\n',
  '下面是编辑经验和它们背后的原因，不是需要逐条满足的清单。',
  '它们之间可能相互冲突，也可能不适用于本章；你按本章实际需要取舍，只要理由来自故事本身。\n',
  '- 读者流失集中在开头几百字。让人物的目标、异常或冲突尽早出现，通常比先介绍背景有效；',
  '但如果本章的力量恰恰来自一段克制的铺陈，那就铺陈。\n',
  '- 让读者投入的是“人物想要什么、被什么挡住、做了什么选择、付出了什么”，而不是事件数量。',
  '一章里发生很多事却全部概述带过，读者的实际感受是什么都没发生。\n',
  '- 连载读者需要“这一章有收获”加上“下一章有期待”。两者都应当长在本章剧情上，',
  '临时接一个不相干的悬念反而会让人觉得被敷衍。\n',
  '- 全章保持同一强度会让读者疲劳，但机械执行“受阻→希望→反转”固定五段式同样是模板。',
  '真正起作用的是后一步由前一步造成，而不是按顺序摆放。\n',
  '- 判断场景是否真的连起来，有个简单办法：删掉前一场，后一场是否仍能原样发生？',
  '如果能，它们只是被放在一起，读者会直接感受为“水”。\n',
  '- 解释性文字读者会跳过，场景和人物反应不会。同样一个信息，放在人物的动作、误判或争执里，',
  '比旁白交代一遍更容易被记住。\n',
  '- 关键路线、答案和工具连续由向导角色交给主角时，读者会失去对主角的认同。',
  '主角可以失败、可以被动，但局面最终由他自己的能力、关系或选择改变时，代入感才成立。\n',
  '- 旁白标注“这很重要”会消解发现的乐趣。伏笔作为物件、动作、矛盾或一个错误判断参与当前场景时，',
  '读者回头才会有“原来如此”的快感。\n',
  '- 密集抛出的专有名词读者记不住。一层能被人物触碰、验证并为之付出代价的世界信息，',
  '比十个新名词更能让人相信这个世界很大。\n',
  '- 替读者总结的主题句、长短相似的同构短段、密集排比和反复出现的同一比喻，',
  '是读者辨认机器文本最直接的几个特征。人物会说的话、场景真正需要的停顿，以及不推进情节的闲笔，反而不是。\n',
].join('');

export const CHAPTER_EXECUTION_CHECKLIST =
  `${CHAPTER_CONTINUITY_CONSTRAINTS}\n${CHAPTER_CRAFT_CONTEXT}`;

export const CONTEXT_LAYER_GUIDANCE = [
  '【上下文分层：材料的性质不同，可信度也不同】\n',
  '1. 已发生事实：前情摘要、已确认长期记忆、已发布状态和前章正文。',
  '读者已经看过它们，为了当前爽点静默改写会被直接发现。\n',
  '2. 作者计划：全书/本部大纲、承诺账本里的“计划中”条目和章节策划。',
  '它们描述意图，不是已经发生的事；需要通过场景落地才成立。\n',
  '3. 秘密与知识边界：只驱动潜台词和人物选择；没有获知过程时不进入正文。\n',
  '4. 表达偏好：文风卡和写作技巧只关乎如何呈现，不决定事实、人物动机和因果。\n',
  '这里只说明材料性质；发生冲突时按系统提示词开头的唯一优先级处理。\n',
].join('');

export const WRITING_ASSET_ANALYST_SYSTEM_PROMPT = [
  '你是一位负责建立长篇网文创作资产库的编辑分析师。你的任务不是续写或仿写，',
  '而是把用户有权提供的文本抽象成可复用的文风参数与故事结构技法。\n',
  '只依据样本中可观察的证据判断；样本不足时降低 evidenceLevel，并把不确定项写入 uncertainties。',
  '不得猜测作者、书名或样本之外的完整剧情。\n',
  '不得复述原文，不得输出超过 20 个连续字符的原句，不得保留专有角色名、地名、组织名或独特设定名。',
  'style.prompt 中不得要求模仿某位作者或某部作品，只能描述抽象、可执行的写作特征。\n',
  '输出必须是一个严格 JSON 对象，不要 Markdown、代码围栏或额外解释。',
].join('');

const CHAPTER_REVIEW_CRITERIA = [
  '【重点审稿标准】\n',
  '优先检查：本章是否有明确增量、人物是否作出选择、铺垫是否得到有效兑现、冲突或信息是否形成后续牵引；',
  '是否存在节奏平直、关键事件概述化、主角长期旁观、配角工具化等问题。\n',
  '同时检查可识别的模板化表达：密集比喻、重复排比、同构短句、空泛哲理总结、百科式说明、',
  '人物同声同气，以及用修辞掩盖缺少行动和因果。必须指出具体位置或表现，不要只写“有 AI 味”。\n',
  '核对姓名、数量、时间线、地点、能力边界和人物知识边界。安静章节不因缺少打斗而直接扣分，',
  '但仍须产生关系、信息、决定或情绪状态的真实变化。可以保留信息差，但关键因果必须能从正文和所给上下文追溯，',
  '不能依赖本章临时补出的便利设定解围。\n',
  '还要检查“负兑现”：前文明确建立的安保、危险、期限或任务是否在本章无原因消失；',
  '上一章末的视角、时间地点、进行中动作、人物/物品末态和知识边界是否被本章开场静默重置；',
  '主角被强调的职业与能力是否真正用于解决阻碍；新秘密是否在旧信息产生行动后果前连续堆叠，',
  '以及配角是否长期只负责带路、递工具和讲设定。\n',
  '若策划要求执行分层埋点，检查正文是否存在可指出的线索载体、当下功能、人物反应和信息边界；',
  '只在旁白中预告意义、只增加神秘名词、或埋点没有影响任何行动，都算未落地。',
  '若策划明确本章无埋点任务，则检查正文是否把篇幅用于指定聚焦，且没有硬造神秘名词、假装推进旧线或提前揭示声明保持不动的未知。\n',
    '若策划包含世界边界扩张，先核对正文开场时读者与当前视角人物的既有认知，再检查它是否调用上下文中已有世界规则、势力利益或历史后果，',
    '世界是否通过人物可触碰或可验证的证据只推进一层，是否迫使人物改变选择或承担代价，并且仍保留清楚未知；',
    '把作者后台真相当成角色知识、重复讲解已经揭示的规则、或者正文没有建立认知基线，都不能算有效世界展开；',
  '百科说明、突兀全知镜头、反派自报设定、连续讲解，以及正文临时发明世界圣经外的万能层级，都不得视为有效展开。\n',
  '若上下文有“本部当前世界执行合同”，还必须核对正文有无超出当前层级、提前泄露本部保留未知，',
  '或在门槛未完成时伪装进入下一层；任一情况都必须判为世界展开风险。\n',
  '若策划包含张力曲线，逐段核对压力变化是否由人物行动与因果触发；只有突发事故、音量升级或章末突然揭密，',
  '中段没有希望—受阻—选择—后果的变化，不算有效跌宕。\n',
  '“没有 AI 味”要落实为证据：检查过多的十二字内独立短段、同构句式、密集“不是……而是……”、',
  '替读者总结主题、人物说话同声、抽象感叹与比喻堆叠；不能只下“像 AI”结论。\n',
].join('');

function goldenThreeGuidance(bookChapterIndex) {
  const shared = '前三章共同任务：逐步建立题材承诺、主角驱动力、主要矛盾、差异化卖点和继续阅读理由。';
  if (bookChapterIndex === 1) {
    return `【黄金第一章职责】尽快呈现人物处境、核心欲望或异常事件并建立阅读钩子；减少无目的背景说明。${shared}`;
  }
  if (bookChapterIndex === 2) {
    return `【黄金第二章职责】让冲突升级，展示题材核心机制、人物选择或关键世界规则，使读者明白“这本书主要看什么”。${shared}`;
  }
  if (bookChapterIndex === 3) {
    return `【黄金第三章职责】给出一次阶段性兑现或明确转折，并建立后续持续阅读预期。${shared}`;
  }
  return '【黄金三章判定】当前并非全书前三章，goldenChapter 与 premisePromise 两项必须标为 na；不得把每个分部的前三章重新当作黄金三章。';
}

function recentReviewSignalContext(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.map((row) => {
    const signals = row?.signals;
    if (!signals) return `- 全书第 ${row?.bookChapterIndex} 章：尚无有效节奏记录`;
    const fingerprint = formatChapterRhythmFingerprint(signals.rhythmFingerprint);
    return [
      `- 全书第 ${row.bookChapterIndex} 章：章节功能=${signals.chapterFunction}`,
      `；冲突=${signals.conflictType}；情绪=${signals.emotionTone}`,
      `；爽点/兑现=${signals.payoffType}；主要表达=${signals.dominantMode}`,
      fingerprint ? `；受控节奏指纹：${fingerprint}` : '；旧审稿未记录受控节奏指纹',
    ].join('');
  });
  const analysis = analyzeRecentChapterRhythm(rows);
  const risks = analysis.risks.length ? boundedJoin([
    '【系统确定性重复分析】\n',
    boundedJoin(analysis.risks.map((risk) => `- [${risk.severity}] ${risk.message}`), '\n'),
    '\n',
  ]) : '';
  return boundedJoin([
    '【最近章节节奏记录（由当时审稿提取）】\n',
    boundedJoin(lines, '\n'), '\n',
    risks,
    '只在记录提供证据时避免连续重复的桥段、冲突、情绪、兑现、表达和完整节奏签名；',
    '系统分析是风险提示，不是轮换命令。若因人物因果必须保留同类手法，要让压力后果、兑现规模或代价发生可见升级。\n',
  ]);
}

function chapterPlanGapContext(readiness) {
  const gaps = (readiness?.checks ?? []).filter((check) => !check.pass && !check.advisory);
  if (!gaps.length) return '';
  return [
    '【作者在策划卡上留白的部分】\n',
    '下面这些判断作者没有给出，或只写了占位内容。它们不是被禁止的方向，',
    '而是现在由你决定——请在正文里做出具体、可被读者看见的选择，不要绕开它们，也不要写成含糊的过场。\n',
    gaps.map((check) => `- ${check.label}：${check.detail}`).join('\n'), '\n',
    '其余已填写的栏目仍然是作者的明确意图，优先照办。\n',
  ].join('');
}

function recentProseTrendContext(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return formatChapterProseTrend(analyzeChapterProseTrend(rows));
}

function storyEngineContext(value) {
  const engine = normalizeStoryEngine(value);
  const rows = [
    ['读者反复期待的体验', engine.readerExperience],
    ['主角反复采取的行动', engine.protagonistAction],
    ['每轮可见收益 / 进展', engine.progression],
    ['行动代价 / 新债务', engine.cost],
    ['循环升级方式', engine.escalation],
  ].filter(([, text]) => text).map(([label, text]) => `- ${label}：${text}`);
  if (!rows.length) return '';
  return boundedJoin([
    '【作品核心循环】\n', boundedJoin(rows, '\n'), '\n',
    '它定义本书可持续的阅读期待，不是要求每章机械重复全部步骤。当前章节可以蓄力、变奏或承受余波，',
    '但关键行动、收益、代价与升级必须长期保持因果并逐步变化。\n',
  ]);
}

export function buildSystemPrompt(
  core = {}, writingAssetContext = '', storyEngine = {}, budget = null,
) {
  const at = (id) => budget?.[id];
  const assetBudget = at('writingAsset');
  const assetText = assetBudget === 0 ? ''
    : assetBudget !== undefined
      ? generationTextWindow(writingAssetContext, assetBudget)
      : writingAssetContext;
  const style = generationCoreFieldText(vtext(core.style), at('style'));
  return boundedJoin([
    '你是一位擅长长篇连载的专业网文作者。严格遵守以下设定与创作准则：\n',
    CONTEXT_PRIORITY_RULE,
    WEB_FICTION_WRITING_PRINCIPLES, '\n',
    storyEngineContext(storyEngine),
    line('世界观（作者后台全貌，不等于读者或角色已知）',
      generationCoreFieldText(vtext(core.world), at('world'))),
    vtext(core.world) ? WORLD_BIBLE_EXECUTION_GUIDANCE : '',
    line('文风基调', style),
    assetText ? `${assetText}\n` : '',
    style || assetText ? STYLE_BIBLE_EXECUTION_GUIDANCE : '',
    // 硬约束仍是最高优先级；超出模型预算时保留开头和结尾并明确标记。
    line('禁忌约束', generationCoreFieldText(vtext(core.constraints), at('constraints'))),
    line('篇幅节奏', generationCoreFieldText(vtext(core.pacing), at('pacing'))),
    // 这两块对所有章节恒定，放 system 可复用前缀缓存，也不再占用
    // user 尾部紧邻任务句的位置。阶段 5 会继续去除与 principles 的复述。
    CHAPTER_EXECUTION_CHECKLIST, '\n',
  ]).trim();
}

export function buildContext({
  book = {}, section = {}, prevChapter = null, bookChapterIndex = 1,
  chapterPlan = null, currentContent = '', budget = null, budgetTrimmed = null,
}) {
  const at = (id) => budget?.[id];
  const chars = (arr, id) => {
    if (at(id) === 0) return '';
    return boundedJoin(generationCharacterRows(arr, at(id)), '\n');
  };
  const sectionWorld = sectionWorldContractPrompt(section.outline?.content);
  const confirmedWorldProgress = worldProgressPrompt(
    book?.settings?.worldProgressState,
    vtext(book?.settings?.core?.world),
  );
  const previousContent = generationChapterContent(prevChapter);
  const previousEnding = previousContent
    ? previousChapterEndingText(previousContent, at('prevEnding')) : '';
  const previousHandoff = previousChapterHandoffText(prevChapter?.handoff);
  const taskRelevantText = generationMemoryTaskRelevantText({
    chapterPlan, currentContent,
  });
  const parts = [
    `${CONTEXT_LAYER_GUIDANCE}\n`,
    '【A. 已发生事实与当前连续性】\n',
    line('此前分部剧情', generationPriorSectionSummary(
      book, section.id, at('priorSections'), { taskRelevantText },
    )),
    line('本部前情', recentSectionSummary(section.summary, at('sectionSummary'))),
  ];
  const mainC = chars(book.characters, 'bookCharacters');
  const secC = chars(section.characters, 'sectionCharacters');
  if (mainC) parts.push(boundedJoin(['【主要人物】\n', mainC, '\n']));
  if (secC) parts.push(boundedJoin(['【本部人物】\n', secC, '\n']));
  const memoryRows = at('memory') === 0 ? [] : generationChapterMemoryRows(book.memory, {
    book, section, prevChapter, chapterPlan, currentContent, maxChars: at('memory'),
  });
  if (memoryRows.length) {
    parts.push(boundedJoin(['【已确认长期记忆】\n', boundedJoin(memoryRows, '\n'), '\n']));
  }
  if (prevChapter) {
    const lineC = chars(prevChapter.characters, 'prevCharacters');
    if (lineC) parts.push(boundedJoin(['【上一章登场人物】\n', lineC, '\n']));
  }
  parts.push(
    '【B. 作品方向与未来计划（不是已发生事实）】\n',
    line('书名', typeof book.title === 'string' ? book.title : ''),
    line('作品简介 / 初始设想', generationCoreFieldText(
      typeof book.premise === 'string' ? book.premise : '', at('premise'),
    )),
    line('全书大纲', generationBookOutlineText(vtext(book.outline), at('bookOutline'))),
    confirmedWorldProgress ? `${confirmedWorldProgress}\n` : '',
    line('本部大纲', generationSectionOutlineText(
      section.outline?.content, at('sectionOutline'),
    )),
    sectionWorld ? `${sectionWorld}\n` : '',
  );
  const promiseRows = at('promiseLedger') === 0 ? [] : generationPromiseLedgerRows(
    book?.settings?.promiseLedger, { bookChapterIndex, maxChars: at('promiseLedger') },
  );
  const characterCraftRows = at('characterCraft') === 0 ? []
    : generationCharacterCraftRows(
      book?.settings?.characterCraft,
      {
        maxChars: at('characterCraft'),
        relevantText: generationCharacterCraftRelevantText({
          book, section, prevChapter, chapterPlan, currentContent,
        }),
      },
    );
  const nextProgress = typeof prevChapter?.progress === 'string' ? prevChapter.progress : '';
  if (promiseRows.length || characterCraftRows.length || nextProgress) {
    parts.push('【C. 阅读债务与作者导演信息（不是公开事实）】\n');
  }
  if (nextProgress) {
    parts.push(line('上一章摘要 API 给出的后续走向建议（不是事实或已确认计划）', nextProgress));
  }
  if (promiseRows.length) {
    parts.push(boundedJoin([
      '【承诺—推进—兑现账本（作者记录）】\n', boundedJoin(promiseRows, '\n'), '\n',
      '“计划中”尚未证明读者已经看到；“已建立待兑现”才是当前阅读债务。',
      '临期或逾期承诺应优先推进或兑现，但必须服从人物因果，不能用旁白宣布完成。\n',
    ]));
  }
  if (characterCraftRows.length) {
    parts.push(boundedJoin([
      '【人物驱动力与声音（作者导演卡）】\n', boundedJoin(characterCraftRows, '\n'), '\n',
      '“作者掌握的秘密”和“私下张力”不等于读者或任何人物已经知道；只用于驱动潜台词与选择，',
      '必须等正文因果允许时才揭示。对话要体现即时目的和压力反应，不能机械复读卡片措辞。\n',
    ]));
  }
  // 上一章末态是本章的直接起点，放在作者计划和导演信息之后、
  // 本章策划卡之前，避免被最多 20 万字符的当前稿劈开。
  if (previousEnding) {
    parts.push(boundedJoin(['【上一章结尾】', previousEnding, '\n']));
  }
  if (previousHandoff) {
    parts.push(boundedJoin([
      '【上一章场景交接快照（摘要 API 从正文提取）】\n', previousHandoff, '\n',
      '快照只用于定位章末边界，不是新剧情。若与上一章原文或已确认事实冲突，以原文和已确认事实为准；不得根据快照补写未发生的过程。\n',
    ]));
  }
  const trimNotice = budgetTrimNotice(budgetTrimmed);
  if (trimNotice) parts.push(trimNotice);
  return boundedJoin(parts).trim();
}

function chapterPlanContext(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const labels = {
    goal: '本章目标', obstacle: '主要阻碍', choice: '关键选择',
    payoff: '兑现 / 爽点', hook: '章末钩子',
    tensionArc: '张力曲线', foreshadowing: '分层埋点',
    worldExpansion: '世界边界扩张', decisionChain: '决策因果链',
    knowledgeDesign: '认知与证据边界', notes: '补充说明',
  };
  const rows = Object.entries(labels)
    .filter(([field]) => typeof plan[field] === 'string' && plan[field].trim())
    .map(([field, label]) => `${label}：${plan[field].trim()}`);
  const sceneRows = Array.isArray(plan.scenes) ? plan.scenes.flatMap((scene, index) => {
    if (!scene || typeof scene !== 'object') return [];
    const parts = [
      ['承接触发', scene.trigger],
      ['欲望', scene.desire], ['阻碍', scene.obstacle], ['行动', scene.action],
      ['转折', scene.turn], ['代价/后果', scene.cost],
    ].filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([label, value]) => `${label}=${value.trim()}`);
    if (!parts.length && !(typeof scene.title === 'string' && scene.title.trim())) return [];
    const title = typeof scene.title === 'string' && scene.title.trim()
      ? ` · ${scene.title.trim()}` : '';
    return [`场景${index + 1}${title}：${parts.join('；') || '仅指定场景名称'}`];
  }) : [];
  const rhythmIntent = formatChapterRhythmFingerprint(plan.rhythmIntent);
  if (!rows.length && !sceneRows.length && !rhythmIntent) return '';
  return boundedJoin([
    '【本章策划卡（作者意图）】\n', boundedJoin(rows, '\n'), '\n',
    rhythmIntent ? `写前节奏意图：${rhythmIntent}\n` : '',
    sceneRows.length ? boundedJoin([
      '【场景链（作者规划的发生顺序）】\n', boundedJoin(sceneRows, '\n'), '\n',
    ]) : '',
    plan.qualityProtocolVersion >= 1 ? CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE : '',
    '执行这些意图，但要把它们转化为自然场景、人物行动与因果变化，不能逐条复述策划卡。',
    '策划卡同时定义本章的叙事范围：它不是最低待办清单，也不是完成后继续自由扩写的起点。',
    '章末钩子之后的重大选择、身份变化、入口执行、谜底或下一章行动不得在本章提前完成；',
    '若 hook 本身是一项尚待决定的选择，只写到选择成立并产生压力，不替人物越过章末作答。',
    '场景链应形成连续因果：第一场承接上一章未完行动或本章直接诱因，后续每场必须消费上一场的转折或代价；',
    '每场结束都要改变局势，具体改写人物可用资源、关系、认知、风险或下一步目标。可以按自然叙事微调边界，但不能用概述跳过关键行动、转折或代价。\n',
  ]);
}

function chapterPlanComparisonInstruction(plan) {
  const targets = chapterPlanReviewTargets(plan);
  if (!targets.length) {
    return '本章没有已保存策划项；planComparison 必须返回 overall=na、items=[]、carryovers=[]，并在 summary 说明无可对照策划。\n';
  }
  const rows = targets.map(({ target, label }) => `${target}=${label}`).join('、');
  return boundedJoin([
    '【策划—成稿差异回顾】\n',
    '必须把正文实际发生的内容与每个已保存策划项逐项对照。目标标识：', rows, '。\n',
    'items 必须对上述标识各返回一次；fulfilled=已落地，adapted=因人物因果合理改写，',
    'missed=未落地，unclear=正文证据不足。evidence 只写正文证据，不得把策划当成已发生事实。\n',
    '对 scene-N，evidence 还必须指明承接触发、欲望、阻碍、行动、转折、代价中哪些真正出现，',
    '哪些缺失或只被概述，便于后续只定向修复该场。\n',
    'carryovers 只放本章仍未解决、确实值得下章处理的项；已完成或已被更好方案取代的不得带入。',
    'rhythmIntent 的差异只诊断本章，不得带入下章；其它带入项只是供作者选择的策划素材，不是下章已定事实。\n',
  ]);
}

function incomingPlanCarryoverContext(carryover) {
  if (!carryover?.items?.length) return '';
  return boundedJoin([
    '【上一完成章的未决策划项（待作者决策）】\n',
    boundedJoin(carryover.items.map((item) =>
      `- ${item.text}（原因：${item.reason}；建议放入 ${item.suggestedField}）`), '\n'), '\n',
    '这些不是正文事实或必须执行的指令。根据当前主线与作者草稿判断是否承接；',
    '若承接，必须转化为本章新的目标、阻碍或场景因果，不得宣称已经发生。\n\n',
  ]);
}

export function buildChapterInstruction({
  chapterIndex, bookChapterIndex = chapterIndex, wordTarget, mode, whip, currentContent,
  recentReviewSignals = [], chapterPlan, planReadiness, budget = null,
}) {
  // 旧配置可能传入低于下限的目标；两处字数必须一致，否则提示词自相矛盾。
  const target = Number.isInteger(wordTarget) && wordTarget > MIN_CHAPTER_BODY_CHARS
    ? wordTarget : MIN_CHAPTER_BODY_CHARS;
  const task = mode === 'rewrite'
    ? `请重写第 ${chapterIndex} 章正文，保持大纲方向与核心情节，重点修复平淡、概述化和模板化表达；目标体量约 ${target} 字，直接输出正文，不要标题和解说。`
    : mode === 'whip'
      ? `用户对当前内容不满，最高优先级要求：『${whip}』。请据此重写第 ${chapterIndex} 章正文，目标体量约 ${target} 字，直接输出正文，不要标题和解说。`
      : `请写第 ${chapterIndex} 章正文，目标体量约 ${target} 字，直接输出正文，不要标题和解说。`;
  // 重写/抽打携带的当前稿也参与分层预算；超预算时保留首尾并显式标记。
  const currentWindow = budget?.currentContent === 0 ? ''
    : budget?.currentContent !== undefined
      ? generationTextWindow(currentContent, budget.currentContent)
      : currentContent;
  const current = currentWindow
    ? boundedJoin(['\n【当前章原文】\n', currentWindow, '\n']) : '';
  const opening = bookChapterIndex <= 3
    ? `${goldenThreeGuidance(bookChapterIndex)}\n`
    : '';
  return boundedJoin([
    '\n', opening,
    // 本章特有的作者意图先于当前稿，避免 20 万字符原文把策划卡和
    // 上一章连续性锚点劈开；当前稿之后只放短的动态诊断与唯一任务句。
    chapterPlanContext(chapterPlan), chapterPlanGapContext(planReadiness),
    current,
    recentReviewSignalContext(recentReviewSignals),
    recentProseTrendContext(recentReviewSignals),
    formatChapterProseContext(target),
    '\n', task,
  ]);
}

function previousPlanContinuityContext(previousPlan, previousChapter) {
  const ledger = chapterPlanContinuityLedger(previousPlan);
  const previousContent = generationChapterContent(previousChapter);
  const ending = previousContent ? previousChapterEndingText(previousContent) : '';
  const handoff = previousChapterHandoffText(previousChapter?.handoff);
  if (!ledger && !ending && !handoff) return '';
  return boundedJoin([
    '【前章连续性账本（已发生事实，不得当成新发现重复兑现）】\n',
    ledger ? JSON.stringify(ledger) : '（前章没有可用的新协议策划账本）', '\n',
    ending ? boundedJoin(['【前章正文结尾事实】\n', ending, '\n']) : '',
    handoff ? boundedJoin(['【前章章末交接事实】\n', handoff, '\n']) : '',
    '- endState 是本章真实起点；不得无代价恢复 startState 中已经失去的权限、资源、关系或隐蔽性。\n',
    '- conclusionAlreadyKnown 已经是人物与读者可用的结论；不得换个载体再次发现同一结论。',
    'evidenceAlreadyUsed 只能作为前提、被对手销毁或被重新解释，不能原样再做一次新证据。\n',
    '- unresolvedDebt 必须被本章行动消费；对手已经使用 opponentCounteraction，后续反制必须根据前章结果调整，不能只重复调岗、威胁或封锁。\n',
    '- 前章正文结尾和交接事实中的具体数字、体貌、物件、证词与地点也已经被读者看到；不得把它们原样包装成新线索。',
    '后章可以通过真正独立来源验证、推翻或重新解释，但必须产生比重复获取更窄或更深的新结论。\n',
    '- payoffAlreadyDelivered、hookAlreadyUsed 和 foreshadowingCarrierAlreadyUsed 不得原样重复；若再次出现，必须发生变义、失效、被反制或产生更高代价。\n\n',
  ]);
}

export function buildNarrativeDesignDraftInstruction({
  chapterIndex, bookChapterIndex = chapterIndex, context = '', seedPlan,
  currentContent = '', incomingPlanCarryover, previousPlan, previousChapter,
}) {
  const seed = normalizeChapterPlan(seedPlan);
  const continuityContext = previousPlanContinuityContext(previousPlan, previousChapter);
  const currentWindow = generationTextWindow(
    currentContent, MAX_CHAPTER_PLAN_SOURCE_PROMPT_CHARS,
  );
  return boundedJoin([
    `先为第 ${chapterIndex} 章制作“叙事骨架”；它是全书第 ${bookChapterIndex} 章。不要写正文，也不要生成完整章节策划。\n`,
    goldenThreeGuidance(bookChapterIndex), '\n',
    '【全书/本部上下文】\n', context || '（暂无额外上下文）', '\n\n',
    currentWindow ? boundedJoin([
      '【当前章已有正文（只用于判断本章功能）】\n', currentWindow, '\n\n',
    ]) : '',
    incomingPlanCarryoverContext(incomingPlanCarryover),
    continuityContext,
    '【作者已有意图】\n', JSON.stringify({
      goal: seed.goal, obstacle: seed.obstacle, choice: seed.choice,
      payoff: seed.payoff, hook: seed.hook, notes: seed.notes,
    }), '\n\n',
    '只解决两个问题：一，人物的主动行动如何让具体利益相关者受损并引发针对性反制；二，本章是否真的需要新增、验证或改写判断。\n',
    'chapterFunction 从 investigation、confrontation、action、relationship、aftermath、setup、payoff、transition 中选择一项。\n',
    'decision.action 是人物使用既有职业、关系、资源或能力采取的首次不可撤回行动，不能写“继续调查”“设法解决”。',
    'responseChoice 是利益相关者反制发生后，主角必须再次采取的具体行动或取舍，不能只写感到紧张、被注意或以后再处理。',
    'harmedStakeholder 必须是会实际失去利益、控制、安全、关系或名誉的人/组织；counteraction 必须由其针对 action 作出，',
    '不能用突然事故、陌生人闯入或天气变化冒充反制。stateBefore/stateAfter 必须是具体不同的资源、关系、认知、权限或风险状态。',
    '每个 decision 子字段只写一个紧凑句，不复述背景：action/counteraction/responseChoice 不超过75字，其余不超过50字。\n',
    '当 chapterFunction 是 relationship 或以核心关系对峙为主的 confrontation 时，反制后的 responseChoice 必须仍由核心关系双方亲自完成并承担，',
    '不得引入上下文未建立的亲属、律师、医生、领导、调解人或偶然来客替他们裁决、监督或促成和解。\n',
    'knowledge.mode 只有 task 或 none。关系余波、行动兑现或已明确不新增问题的章节优先使用 none，',
    '不得为了填表新增遗嘱、信件、神秘物品、匿名消息、隐藏身份或更大秘密。',
    '使用 task 时，allowedConclusion 必须窄于最终答案；alternatives 至少两个且当时都能解释可见依据；',
    'crossValidation 至少两个相互独立来源，不能把同一文件的两个字段、同一人的两句话或异能与其复述算作两个来源。',
    'task 模式每个知识子字段不超过75字；短句应直接说明证据或边界，不复述剧情。\n',
    '只返回严格 JSON，不要 Markdown、代码围栏或解释：\n',
    '{"designProtocolVersion":1,',
    '"chapterFunction":"investigation|confrontation|action|relationship|aftermath|setup|payoff|transition",',
    '"decision":{"currentBelief":"人物章初误判或未决","action":"不可撤回行动",',
    '"harmedStakeholder":"谁因行动失去什么","counteraction":"对方针对行动的反制",',
    '"responseChoice":"反制后主角再次行动或取舍",',
    '"stateBefore":"章初具体状态","stateAfter":"章末具体状态","nextDebt":"必须继续处理的后果"},',
    '"knowledge":{"mode":"task|none",',
    '"question":"task时填写","visibleEvidence":"task时填写","allowedConclusion":"task时填写",',
    '"alternatives":["task时解释A","task时解释B"],',
    '"crossValidation":["task时独立来源A","task时独立来源B"],',
    '"protectedUnknown":"task时填写",',
    '"noTaskReason":"none时填写","focus":"none时填写","existingJudgment":"none时填写"}}',
  ]);
}

export function buildChapterPlanDraftInstruction({
  chapterIndex, bookChapterIndex = chapterIndex, context = '', seedPlan,
  currentContent = '', recentReviewSignals = [], incomingPlanCarryover,
  fixedNarrativeDesign, previousPlan, previousChapter,
}) {
  const seed = normalizeChapterPlan(seedPlan);
  const continuityContext = previousPlanContinuityContext(previousPlan, previousChapter);
  const currentWindow = generationTextWindow(
    currentContent, MAX_CHAPTER_PLAN_SOURCE_PROMPT_CHARS,
  );
  return boundedJoin([
    `请只为第 ${chapterIndex} 章制作写前策划候选；它是全书第 ${bookChapterIndex} 章。不要写正文，不要声称已经保存。\n`,
    goldenThreeGuidance(bookChapterIndex), '\n',
    recentReviewSignalContext(recentReviewSignals),
    '【全书/本部上下文】\n', context || '（暂无额外上下文）', '\n\n',
    currentWindow ? boundedJoin([
      '【当前章已有正文（只用于诊断和重写策划）】\n', currentWindow, '\n\n',
    ]) : '',
    incomingPlanCarryoverContext(incomingPlanCarryover),
    continuityContext,
    '【作者当前策划草稿】\n', JSON.stringify(seed), '\n\n',
    fixedNarrativeDesign ? boundedJoin([
      '【已验证叙事骨架（固定，不得重新发明线索、反制或章节功能）】\n',
      JSON.stringify(fixedNarrativeDesign), '\n',
      '完整策划必须围绕这份骨架安排场景；初次行动、利益受损者反制、反制后主角再次选择必须形成连续三拍，',
      '原则上分别落进可见场景，不能把后两拍缩成一句“他被注意了”或留到下一章。',
      'decisionChain 与 knowledgeDesign 将由服务器按骨架写入；你不要为填其它字段新增第二套证据、神秘物品、随机事故或更大的秘密。\n\n',
    ]) : '',
    '作者草稿中的明确限制和意图优先于你的补充；不要擅自改掉人物目标、禁忌或既定结果。空缺处才由你补全。\n',
    '策划必须服务作品核心循环、全书主线、本部目标和上一章留下的行动，不得凭空增加能解决问题的能力、物品、人物或规则。\n',
    '上一章若明确建立门槛、危险、期限或救援承诺，本章不能让它无原因消失；必须让主角凭已经成立的能力、关系或资源跨过，并留下可见代价。\n',
    '主角被设定的职业与能力必须至少一次用于改变局面。向导或知情配角可以制造压力、隐瞒和交换，但不能连续包办路线、工具和答案。\n',
    '一次揭密后先安排人物据此行动并承受后果，再抛出更大的秘密；不要把多轮讲解当成剧情升级。\n',
    '先根据最近章节的受控节奏指纹选择本章五维节奏意图：压力轨迹、破局方式、兑现规模、章末钩子机制和关键代价。',
    '它必须符合人物因果；若延续系统标出的重复风险，要让后果、规模或代价发生可见升级，不能只替换事件名词。\n',
    '张力曲线要写清压力如何随人物行动至少两次变化：哪里出现希望、小胜或暂缓，哪里被新代价、误判或对手反制打破，',
    '关键选择后怎样兑现并留下余波。不要让全章只一路升高，也不要机械套固定节拍。\n',
    '分层埋点要写清：本章回收或推进哪条旧线；从植入、加压、公平误导、变义、线索碰撞、回收中只选择一个叙事节拍；',
    '读者在本章前的判断如何被正文证据改写为本章后的新判断；具体物件、动作、错误判断或人物秘密如何先服务当前场景；',
    '线索怎样改变人物行动、风险或代价；它不关联世界线、深化当前世界层，还是支撑当前分部下一层门槛；哪些答案本章明确不揭示。',
    '“再次出现”“更神秘了”“某人若有所思”都不算有效节拍；公平误导不能隐瞒当前视角人物已经看见或想到的关键事实。',
    '若上下文有承诺账本，必须在“旧线/阅读债务”中原样复制一个后台锚点：',
    '已建立债务用[推进债务:promise_…]或[兑现债务:promise_…]，计划中承诺首次落地用[建立承诺:promise_…]；',
    '进入兑现窗口或逾期但本章因人物因果不能处理时，在 notes 用[延期债务:promise_…]并写明具体原因与下一检查点。',
    '不得杜撰 ID、把计划中承诺冒充读者已知，或让一章无因果地同时处理多笔债务。以上锚点只留在策划，不得进入正文。',
    '账本若给出上一有效节拍的“读者认知”，本章认知变化的起点必须承接它；不得中途改写读者此前已经知道什么。',
    '近三拍若重复同一种手法，本章除非因果上不可替代，否则改用另一种有效节拍，避免连续靠同类物证或同类误导吊胃口。',
    '没有相关账本项或没有新增伏笔时，本章若确实不应处理既有债务，也不要硬造谜团；foreshadowing 改用以下无任务合同，并具体填写：',
    CHAPTER_PLAN_NO_FORESHADOWING_FORMAT, '。若有已进入窗口或逾期的债务，只有在 notes 使用合法延期锚点并写清原因与检查点，',
    '才可选择无任务合同。\n',
    '世界边界扩张要以世界圣经与既有大纲为上限。先从已发生摘要、已确认记忆和人物知识边界判断读者与当前视角人物',
    '在本章开始时已经知道什么、仍把什么当未知，再写清本章调用哪条已经存在的规则、',
    '制度、势力利益或历史后果；通过哪个可触碰、可核验的物证/地点/行动结果推开哪一层边界；',
    '有效载体可以是物证、地域、制度、历史痕迹或力量差，但必须先在既有设定中有依据；',
    '证据如何迫使谁改变什么选择并付出什么代价；本章结束时读者与人物分别新增哪一层认知；本章明确不揭示什么。',
    '世界圣经是作者后台全貌，不能把底层真相或分阶段揭示路线直接算成角色已知。',
    '如果【全书/本部上下文】包含“本部当前世界执行合同”，worldExpansion 必须服从其当前层级、允许认知增量和保留未知；',
    '门槛未由已发生正文完成时，不得策划下一层的地域、势力或历史真相。',
    '不能只写“出现更大势力/更强敌人/远方地图”，也不能临时发明世界圣经和大纲都没有的万能层级。',
    '没有扩张任务的过渡章要明确本章深化哪条既有机制及其日常或社会后果，禁止用名词堆砌假装宏大。\n',
    '先填写决策因果链：人物本章开始时错误相信什么或必须解决什么；为验证判断或争取目标采取什么不可撤回行动；',
    '谁会因此失去利益、控制或安全；对方怎样针对这次具体行动反制；章初到章末哪项资源、关系、认知、权限或风险被改写；',
    '本章选择留下什么必须继续处理的后果。禁止把“突然出现陌生威胁”冒充行动后果。\n',
    '再填写认知与证据边界。有判断、揭示或推理任务时，必须公平展示可见依据，写明依据最多允许推出哪一层，',
    '至少保留两个当时合理的替代解释，并安排两个相互独立的来源交叉验证；异能、直觉、匿名消息、反派自白或自动出现的文件不能单独完成关键证明。',
    '本章不新增或改写判断时，knowledgeDesign 使用以下无认知任务合同并具体填写：',
    CHAPTER_PLAN_NO_KNOWLEDGE_TASK_FORMAT, '。不得为填字段硬造谜团。\n',
    '章级结构要形成“可感知目标 → 具体阻碍升级 → 人物主动选择 → 有因果的兑现/代价 → 真实后续牵引”。爽点可以是信息、能力、关系、资源或情绪兑现，不等于必须打赢。\n',
    '场景按发生顺序组成连续因果：第一场写清它承接上一章哪项未完行动、即时后果或本章直接诱因；',
    '后续每场写清它消费上一场的哪个转折或代价。每场都要有当下人物欲望、现场阻碍、具体行动、局势转折和代价/后果；',
    '若删掉前一场，后一场仍会原样发生，说明两场是并列事件，必须重做承接。不能只靠换地点、时间跳切、陌生人闯入或重复争执制造推进。\n',
    'turn 必须写成可核对的状态变化：明确场景开始时人物以为什么/拥有什么/能做什么，结束后哪项资源、关系、认知、风险或目标被改写；',
    '不能只写“气氛更紧张”“冲突升级”“主角震惊”。张力波动应来自这些状态变化，不得给每场机械安排一次反转。\n',
    '通常规划 2–6 场；简单章节可以 1 场，复杂章节最多 12 场。不要为了凑数量拆碎同一动作，也不要用概述跳过本章最值得写的选择、转折或兑现。\n',
    'tensionArc 是压力变化设计，foreshadowing 与 worldExpansion 是信息设计；这些字段名和解释词都不能直接写进正文。',
    'notes 只记录必须保留、必须避免或仍需作者确认的事项，不把小纲扩写成正文。\n',
    '返回严格 JSON 对象，不要 Markdown、代码围栏、标题或解释，格式：\n',
    '{"qualityProtocolVersion":3,"designProtocolVersion":1,"rhythmIntentVersion":1,' ,
    '"rhythmIntent":{"pressurePattern":"steady-rise|wave-rise|false-relief|reversal-led|choice-led|aftermath",',
    '"resolutionMethod":"none|force|skill|wit|negotiation|sacrifice|cooperation|endurance|discovery|failure|mixed",',
    '"payoffScale":"none|micro|chapter|stage|major",',
    '"hookMechanism":"none|new-threat|new-information|unfinished-action|forced-choice|relationship-shift|world-opening|deadline|aftermath-question",',
    '"costType":"none|physical|resource|identity|relationship|moral|time|position|knowledge|mixed"},',
    '"goal":"本章目标","obstacle":"主要阻碍及升级","choice":"关键主动选择及代价",',
    '"payoff":"本章具体兑现","hook":"由本章结果产生的后续牵引",',
    '"tensionArc":', JSON.stringify(CHAPTER_PLAN_QUALITY_FORMATS.tensionArc), ',',
    '"foreshadowing":', JSON.stringify(CHAPTER_PLAN_QUALITY_FORMATS.foreshadowing), ',',
    '"worldExpansion":', JSON.stringify(CHAPTER_PLAN_QUALITY_FORMATS.worldExpansion), ',',
    '"decisionChain":', JSON.stringify(CHAPTER_PLAN_QUALITY_FORMATS.decisionChain), ',',
    '"knowledgeDesign":', JSON.stringify(CHAPTER_PLAN_QUALITY_FORMATS.knowledgeDesign), ',',
    '"notes":"补充限制或待确认项",',
    '"scenes":[{"title":"场景短名","trigger":"第1场承接上一章/直接诱因；后续场承接上一场哪项结果或代价","desire":"人物此刻想得到什么","obstacle":"现场阻碍",',
    '"action":"人物采取的具体行动","turn":"场景结束时局势如何变化","cost":"选择造成的代价或后果"}]}\n',
    'qualityProtocolVersion 必须为 3，designProtocolVersion 必须为 1，rhythmIntentVersion 必须为 1，rhythmIntent 五项必须各从给定英文枚举选择一项。',
    '选择必须与本章场景因果一致，不能为求轮换硬改；延续重复手法时必须在策划中体现升级。tensionArc 与 worldExpansion 必须保留示例标签和顺序；',
    'foreshadowing 必须在“旧线/阅读债务…”任务合同与“无埋点理由…”无任务合同中二选一，保留所选标签和顺序；',
    'goal、obstacle、choice、payoff、hook、tensionArc、foreshadowing、worldExpansion、decisionChain、knowledgeDesign 不得留空；',
    '每个场景的 trigger、desire、obstacle、action、turn、cost 不得留空。',
  ]);
}

export function buildOutlineInstruction(premise) {
  return boundedJoin([
    '用户想写的故事：『', premise, '』。请生成一份可供长篇连载执行的全书总大纲。\n',
    '必须包含：\n',
    '1. 题材承诺与差异化卖点：读者主要期待看到什么。\n',
    '2. 主角的长期欲望、中期目标和当前行动，以及目标变化的触发条件。\n',
    '3. 主线的“承诺（Promise）—推进（Progress）—兑现（Payoff）”，说明关键升级和最终兑现方向。\n',
    '4. 重要人物各自的欲望、关键选择、代价和主要关系变化，不能只列身份设定。\n',
    '5. 阶段划分：每阶段写清目标、主要阻力、阶段高潮、状态变化、对主线的推进，以及承诺和兑现。\n',
    '6. 尚待回收的主线承诺、人物线和关键伏笔清单。\n',
    '不要机械套模板；所有结构项必须服务这个具体故事。直接输出大纲正文。',
  ]);
}

export function buildSectionsInstruction({
  outline, worldRoute = [], occurredSummary = '', startLayer = WORLD_REVEAL_STAGE_LABELS[0],
}) {
  const route = worldRoute.length ? boundedJoin(worldRoute.map((stage) => boundedJoin([
    `【${stage.layer}】\n`,
    `- 阅读承诺：${stage.readingPromise}\n`,
    `- 可验证证据：${stage.verifiableEvidence}\n`,
    `- 人物行动：${stage.characterAction}\n`,
    `- 选择与代价：${stage.choiceAndCost}\n`,
    `- 认知增量：${stage.knowledgeGain}\n`,
    `- 保留未知：${stage.protectedUnknown}\n`,
    `- 进入下一层门槛：${stage.nextLayerGate}`,
  ])), '\n\n') : '（未提取到可执行的三层路线；仍必须按三层合同规划）';
  const completed = occurredSummary
    || '（尚无已发生分部，从当前生活圈开始）';
  return boundedJoin([
    '基于以下全书大纲、已发生分部摘要和世界揭示路线，规划未来分部（卷）结构。',
    '每个分部必须有独立目标并推进全书主线。\n\n【全书大纲】\n', outline || '（暂无）',
    '\n\n【已发生分部摘要（只是事实，不是未来计划）】\n', completed,
    '\n\n【世界圣经三层揭示路线（作者后台合同）】\n', route, '\n\n',
    worldRoute.length ? ''
      : '世界圣经尚未提供可执行的三层路线。不得自行编造解锁规则或把通用分部冒充宏大世界规划；仍按下方 JSON 字段返回，由服务器拒绝并提醒作者先重构世界圣经。\n\n',
    '返回的未来分部必须至少 2 个，并持续规划到“长线文明与历史”的本轮阶段兑现。',
    `作者已确认的后续起始层是“${startLayer}”；第一个候选必须从这一层开始。`,
    '已发生摘要只能说明剧情事实，不能自行解锁世界层；未由正文原句和作者确认写入长期世界进度的门槛，一律视为未完成。',
    '可以多个分部留在同层，但不得倒退或跳层，也不得把仅写在大纲或世界圣经的未来计划当成已解锁。',
    '只有某部用人物行动和已发生证据完成该层的“进入下一层门槛”，gateOutcome 才能写 open-next，',
    '且下一部必须进入相邻下一层；未完成写 hold。最后一部位于长线层并完成其本轮大承诺时才能写 complete-long。\n',
    'worldProgression.stagePromise 和 gateCondition 必须分别原样复制该层的“阅读承诺”和“进入下一层门槛”；',
    '其余字段要写这一部如何具体执行，不能抄路线的空泛改写。',
    '宏大感要来自规则通过人物行动影响生计、关系、利益和选择代价；',
    '禁止用新地图、更高等级、更大势力和一段百科说明充当世界升级。\n',
    '返回严格的 JSON 对象（不要多余文字），格式：\n',
    '{"sections":[{"title":"8字内纯标题，不带第N部","summary":"本部概述",',
    '"promise":"本部向读者建立的具体期待","goal":"本部明确目标",',
    '"obstacle":"主要阻力","progress":"对全书主线的推进",',
    '"climax":"阶段高潮","payoff":"本部兑现什么承诺",',
    '"stateChange":"本部结束后人物、关系或局势的不可逆变化",',
    '"worldProgression":{"layer":"当前生活圈|中期势力与地域|长线文明与历史",',
    '"stagePromise":"原样复制该层阅读承诺","evidence":"本部让人物可触碰核验的具体证据",',
    '"characterAction":"谁为什么主动追索或利用证据","choiceAndCost":"证据迫使谁怎样选择并失去什么",',
    '"knowledgeGain":"本部结束时读者与视角人物具体多知道哪一层",',
    '"protectedUnknown":"本部仍明确不回答什么","gateOutcome":"hold|open-next|complete-long",',
    '"gateCondition":"原样复制该层进入下一层门槛","gateProgress":"本部用哪项行动和已发生证据未完成/完成门槛"}}]}\n',
    'title 不要序号、书名号、引号；其余字段各 300 字内且不得留空。',
    '相邻分部要有因果和升级，不能只是换地图或重复同类冲突。',
  ]);
}

export const DIGEST_INSTRUCTION =
  '请阅读上文这一章正文，返回严格的 JSON（不要多余文字），格式：' +
  '{"chapterTitle":"本章10字内纯标题，不带第N章",' +
  '"sectionTitle":"本部10字内纯标题，不带第N部",' +
  '"summary":"本章50字内小结","progress":"正文结尾已明确指向的下一步；没有则留空",' +
  '"handoff":{"viewpoint":"章末视角或叙事焦点","time":"章末明确/相对时间",' +
  '"location":"章末地点","ongoingAction":"结尾时仍在进行的动作",' +
  '"immediatePressure":"尚未解除的即时压力","characterState":"在场人物伤势、关系与相对位置末态",' +
  '"resourceState":"关键物品、能力和资源末态","knowledgeBoundary":"读者与视角人物分别已知/未知",' +
  '"unresolvedCausality":"已被正文启动且仍在生效的未完因果"},' +
  '"characters":[{"name":"名","role":"身份","desc":"本章结束时的最新状态"}],' +
  '"memoryCandidates":[{"kind":"character|relationship|ability|item|location|timeline|faction|foreshadowing|knowledge|other",' +
  '"subject":"主体","aliases":["正文明确使用过的昵称或代称"],' +
  '"predicate":"关系或属性","object":"本章明确成立的值",' +
  '"evidence":"本章中的简短事实依据，不照抄长句","importance":1,' +
  '"details":{"target":"关系另一方","relationType":"关系类型","strength":"weak|medium|strong|unknown",' +
  '"visibility":"public|limited|secret|unknown","changeReason":"变化原因",' +
  '"eventType":"acquired|upgraded|used|transferred|damaged|destroyed|moved|status|occurred|other",' +
  '"owner":"持有人","origin":"来源","quantity":"数量","status":"状态","lastLocation":"最后位置",' +
  '"cost":"代价","limitation":"限制","from":"移动起点","to":"移动终点","time":"时间",' +
  '"order":"先后关系","duration":"持续时间","participants":["参与者或成员"],"location":"地点",' +
  '"role":"职位","alignment":"阵营","goal":"目标","relations":"对外关系","territory":"控制区域",' +
  '"foreshadowStatus":"planted|progressing|resolved|abandoned","readerKnowledge":"读者已知",' +
  '"plannedPayoff":"计划回收点","actualPayoff":"实际回收结果","dueChapter":"预计最迟全书章序",' +
  '"knowledgeOwner":"author|reader|character","knower":"知情人物","information":"已知信息",' +
  '"learnedAt":"获知时间"}}]}。' +
  '标题不要书名号、引号、序号或解释；characters 必须完整列出本章实际登场的全部人物，' +
  '包括已有角色，并描述本章结束时的最新身份或状态；未登场的人物不要列出，若无则为空数组。' +
  'memoryCandidates 只列正文明确支持、值得跨章记住的事实，最多 20 条；importance 为 1-5 整数；' +
  'aliases 只列正文中确实用于指代同一主体的昵称、代称或旧名，不猜测别名，不重复 subject，最多 8 条；' +
  '人物类事实的 predicate 优先使用“别名、身份、阵营、性格、目标、能力、限制、当前状态、生死状态”这些固定名称，' +
  '一条候选只写一个属性；能力的代价、弱点或使用上限另写 kind=ability 的限制事实。' +
  '关系事实使用 subject=人物甲、predicate=当前关系类型、object=人物乙；关系变化的原因写入 evidence。' +
  '能力事实的 predicate 优先使用“获得、境界、效果、限制、代价、使用记录”；' +
  '物品事实优先使用“持有人、来源、数量、状态、最后位置”；' +
  '地点事实优先使用“当前位置、移动事件”，时间线事实优先使用“时间、先后、持续时间、参与者、地点”。' +
  'details 只保留当前 kind 适用且正文明确支持的非空字段：relationship 使用 target/relationType/strength/visibility/changeReason；' +
  'ability 使用 eventType/cost/limitation/time/location；item 使用 eventType/owner/origin/quantity/status/lastLocation/time；' +
  'location 使用 eventType/from/to/time/location；timeline 使用 eventType/time/order/duration/participants/location。' +
  'faction 使用 participants/role/alignment/goal/relations/territory；' +
  'foreshadowing 使用 foreshadowStatus/readerKnowledge/plannedPayoff/actualPayoff/dueChapter；' +
  'knowledge 使用 knowledgeOwner/knower/information/learnedAt，knowledgeOwner 必须明确是作者、读者或人物。' +
  'handoff 只能依据本章正文结尾，提取最后时刻已明确成立的边界；不得从 progress、策划或预测补写，也不得混入“下章应该”；不能确认的 handoff 字段用空字符串。' +
  '不要把推测、修辞、常识或未来计划写成事实，无法确认时宁可不列。候选仍需作者确认，若无则为空数组。';

export function buildBookTitleInstruction(premise, outline) {
  return boundedJoin([
    '故事设想：', premise || '', '\n全书大纲：', outline || '', '\n',
    '请拟一个10字以内、有文学性的纯书名。不要书名号、引号、序号、冒号或解释，只输出书名。',
  ]);
}

export function buildChapterTitlesInstruction({ chapterIndex, summary, progress }) {
  return boundedJoin([
    `请为第 ${chapterIndex} 章和它所在分部拟纯标题。\n`,
    '【本章摘要】', summary || '', '\n【后续走向】', progress || '', '\n',
    '返回严格 JSON（不要多余文字）：',
    '{"chapterTitle":"10字内纯章名","sectionTitle":"10字内纯部名"}。',
    '不要序号、书名号、引号、“章名/部名”前缀或解释。',
  ]);
}

export function buildCoreFieldInstruction(field, book, writingAssetContext = '') {
  const names = { world: '世界观', style: '文风基调', constraints: '禁忌约束', pacing: '篇幅节奏' };
  const core = (book.settings && book.settings.core) || {};
  const others = [];
  for (const k of Object.keys(names)) {
    if (k === field) continue;
    others.push(line(names[k], generationCoreFieldText(vtext(core[k]))));
  }
  const shared = boundedJoin([
    '【书名】', typeof book.title === 'string' ? book.title : '', '\n',
    '【故事设想】', book.premise || '', '\n',
    '【全书大纲】', generationBookOutlineText(vtext(book.outline)), '\n',
    storyEngineContext(book.settings?.storyEngine),
    '【当前', names[field], '草稿】', generationCoreFieldText(vtext(core[field])) || '（空）', '\n',
    '【其它已有设定】\n', boundedJoin(others),
  ]);
  if (field === 'world') {
    return boundedJoin([
      '请为这部长篇网文重构一份可持续连载的“世界圣经”。以下材料中，作者明确设定和大纲方向必须保留；',
      '当前世界观草稿只作可改进素材，不是不可推翻的答案。\n', shared, '\n',
      '目标不是写百科，而是造出一个有独特因果、能不断长大、会持续逼人物选择的世界。',
      '“宏大”必须表现为当前生活圈、中期势力/地域、长线文明或历史真相三个可逐步抵达的层级；',
      '不能一次说完，也不能只换地图、堆专名或宣称规模巨大。\n',
      '必须做到：\n',
      '1. 给出一个可被读者一句话记住、且不能轻易替换到同题材作品的核心世界钩子。\n',
      '2. 至少建立三条相互咬合的因果链：规则如何改变普通人的日常与生计；如何塑造权力、阶层和势力冲突；',
      '又如何让主角拥有机会同时承担不可回避的代价。\n',
      '3. 能力、科技、超凡、制度或资源必须写清来源、使用条件、上限、代价、稀缺性与可被反制之处；',
      '禁止临时新增万能能力、免费资源或只对主角失效的规则。\n',
      '4. 势力不是标签：各自要有赖以生存的资源、真实利益、内部裂缝、对主角既可合作又会冲突的理由。\n',
      '5. 历史只保留会继续影响当下制度、地理、仇恨、技术或谜团的伤口；每项宏观设定都要落到人物可触碰的证据和选择后果。\n',
      '6. 设计三层分阶段揭示路线：当前生活圈先兑现何种阅读承诺，中期如何凭行动推开势力与地域，长线文明或历史真相如何改写旧认知；',
      '每层都要写可验证证据、人物行动、选择代价、认知增量、保留未知和进入下一层门槛。章数只作节奏参考，不能按章号自动解锁；',
      '上一层门槛未在正文中完成时，不允许越级泄露下一层答案。\n',
      '7. 主动删除同题材常见的默认拼装件；如果使用常见母题，必须说明它在本书中因哪条规则、代价或社会后果而不可互换。\n',
      '8. 在“独特机制”中给出至少三个只能由本书规则催生的标志性场面原型；每个都必须同时包含可见行动、人物欲望、规则阻碍与实际代价，',
      '不能只列奇观名词、地点名或氛围画面。\n',
      '9. 把这些可持续看点单列：至少六种可以在连载中变奏出现的标志性场面原型，覆盖日常生计、规则博弈、',
      '关系交换、势力冲突、探索发现和阶段兑现；每种写清读者看点、人物行动、阻碍、代价与不可机械重复之处。\n',
      '10. 建立秘密分层与认知边界：区分作者底层真相、当前读者已知、主角已知、关键势力各自已知、',
      '每阶段允许验证的新认知和必须保留的未知；禁止把分阶段揭示路线当成角色知识。\n',
      '11. 输出前在内部完成三项压力测试，但不要输出测试过程：去掉全部专名后若仍能直接套进同题材作品，就重做差异化机制；',
      '若核心设定不能迫使普通人、势力与主角作出互相冲突的选择，就补足因果和代价；若只能支撑一次揭秘或只会靠战力膨胀续写，',
      '就重做前期、中期、长线三个不同的剧情发动机。\n',
      '全文建议 2600—4200 中文字，至少 1800 字符。严格按以下十二个栏目输出；“一句话世界钩子”之外每栏至少 50 字符，',
      '不要 Markdown 代码围栏、写作说明或栏目之外的开场白。\n',
      '其中“持续看点与标志性场面”栏必须依次使用以下六个子标记：',
      WORLD_APPEAL_SCENE_LABELS.map((label) => `〔${label}〕`).join('、'), '；',
      '每个子标记内再严格依次填写',
      WORLD_APPEAL_SCENE_FIELDS.map((field) => `${field}：具体内容`).join('；'), '。\n',
      '“分阶段揭示路线”栏必须依次使用以下三个子标记：',
      WORLD_REVEAL_STAGE_LABELS.map((label) => `〔${label}〕`).join('、'), '；',
      '每个阶段再严格依次填写',
      WORLD_REVEAL_STAGE_FIELDS.map((field) => `${field}：具体内容`).join('；'), '。',
      '本层“进入下一层门槛”必须能成为下一层证据的来源，不能只把地图名、敌人等级或势力数量越写越大。\n',
      '“秘密分层与认知边界”栏必须依次使用以下六个子标记并填具体内容：',
      WORLD_KNOWLEDGE_BOUNDARY_LABELS.map((label) => `〔${label}〕`).join('、'), '。\n',
      '十二个顶层栏目如下：\n',
      boundedJoin(WORLD_BIBLE_SECTION_LABELS.map((label) => `【${label}】\n`)),
    ]);
  }
  if (field === 'style') {
    return boundedJoin([
      '请为这部长篇网文重构一份可长期稳定执行的“文风圣经”。以下材料中的故事方向、世界规则和禁忌必须遵守；',
      '当前文风草稿只作可改进素材，不是不可推翻的答案。\n', shared, '\n',
      writingAssetContext ? boundedJoin([
        writingAssetContext, '\n',
        '已绑定资产只提供抽象观察证据：提炼共同的有效特征，解决互相冲突之处，并使它们服务本书题材与人物；',
        '不得逐份拼接、复述来源或把外部参考凌驾于本书事实和禁忌之上。\n',
      ]) : '',
      '目标不是堆“细腻、紧凑、有代入感、像人写的”等形容词，而是把文风写成任何正文模型都能执行、',
      '审稿模型也能从成稿中核对的观察规则。文风只决定怎样呈现，不能改写剧情事实、人物动机和因果。\n',
      '必须做到：\n',
      '1. 明确固定视角、叙事距离和人物知识边界；若允许切换，写清触发条件与禁止方式，避免无意全知。\n',
      '2. 规定镜头优先观察什么、忽略什么，以及两至三类与本书题材或世界机制相连的标志性细节渠道；',
      '不能只写“多用五感”。\n',
      '3. 分别写清日常推进、对话交锋、动作冲突和余波场景的句长、段落与停顿如何变化；',
      '禁止用全篇碎短段或全篇长句冒充节奏。\n',
      '4. 对话要有身份、即时目的、回避方式与潜台词，说明怎样区分人物声音；禁止人人都替作者讲道理或讲设定。\n',
      '5. 情绪必须优先通过选择、身体反应、注意力偏差、语言失误和关系动作呈现；',
      '同时写清何时允许直述，避免“全不说情绪”形成新的模板。\n',
      '6. 设定信息按“人物触碰到的证据 → 当下判断或误判 → 行动后果”进入正文；',
      '禁止百科段、旁白替读者总结意义和人物突然长篇讲解。\n',
      '7. 爽点、反转与高潮要写过程、对手反应和余波，不能只提高音量或一句概述结果；',
      '安静段也要保留人物欲望、摩擦或信息差。\n',
      '8. 规定开篇如何尽快进入人物当前问题、转场如何承接上一场结果、章尾如何从真实未完成行动或信息差形成牵引；',
      '禁止每章复用同一种事故、金句或突然揭密。\n',
      '9. 给出与本书气质相配的词汇密度、动词选择、意象来源和修辞上限；禁止密集比喻、排比、',
      '“不是……而是……”式结论、主题总结和同构短句。\n',
      '10. 把规则分成“全书稳定锚点”“可随场景变化的范围”“明确禁止表达”；',
      '稳定不等于每章复刻同一节奏、同一意象、同一对话比例或同一五段结构。\n',
      '输出前在内部完成三项压力测试，但不要输出测试过程：删掉“细腻、克制、沉浸、电影感”等形容词后是否仍可执行；',
      '任取战斗与安静对话两种场景是否既像同一本书又不会同速同腔；是否每条禁用项都有正向替代手段，避免模型只会回避而不会写。\n',
      '全文建议 1400—2400 中文字，至少 1000 字符。严格按以下十个栏目输出；每栏都必须有具体内容，',
      '不要示范可被机械复用的完整句子，不要 Markdown 代码围栏、写作说明或栏目之外的开场白：\n',
      boundedJoin(STYLE_BIBLE_SECTION_LABELS.map((label) => `【${label}】\n`)),
    ]);
  }
  return boundedJoin([
    shared, '请为这本书重新拟定『', names[field],
    '』，300—800 字，与其它设定、全书大纲和作品核心循环保持一致。',
    '只输出该项内容，不要解释、不要标题；要求具体可执行，避免“细腻、紧凑、有代入感”等空泛形容词。',
  ]);
}

export function buildChapterReviewInstruction({
  chapterIndex, bookChapterIndex = chapterIndex, content, context,
  recentReviewSignals = [], chapterPlan, sectionOutline,
}) {
  const reviewableWorldGate = reviewableSectionWorldGate(sectionOutline);
  const hasSectionWorldContract = Boolean(sectionWorldContractPrompt(sectionOutline));
  const worldExpansionReviewChain = chapterPlan?.qualityProtocolVersion >= 2
    ? '展开前认知→既有依据→证据→边界增量→选择代价→保留未知'
    : '既有依据→证据→边界增量→选择代价→保留未知';
  const noForeshadowingTask = /^无埋点理由\s*[:：]/u.test(
    typeof chapterPlan?.foreshadowing === 'string' ? chapterPlan.foreshadowing.trim() : '',
  );
  const foreshadowingReviewChain = noForeshadowingTask
    ? '无埋点理由→本章聚焦→既有未知保持不动'
    : chapterPlan?.qualityProtocolVersion >= 3
      ? '旧线→单一叙事节拍→读者认知前后变化→载体→当下作用→行动影响→世界线作用→保留未知'
      : '旧线→载体→当下作用→行动影响→保留未知';
  const noKnowledgeTask = /^无认知任务理由\s*[:：]/u.test(
    typeof chapterPlan?.knowledgeDesign === 'string'
      ? chapterPlan.knowledgeDesign.trim() : '',
  );
  const knowledgeReviewChain = noKnowledgeTask
    ? '无认知任务理由→本章聚焦→既有判断保持不动'
    : '当前问题→可见依据→允许结论→至少两个替代解释→至少两个交叉来源→保留未知';
  return boundedJoin([
    `请以专业审稿编辑的身份，审阅第 ${chapterIndex} 章正文（当前分部章序）；它是全书第 ${bookChapterIndex} 章。\n`,
    goldenThreeGuidance(bookChapterIndex), '\n',
    '黄金三章只指出当前题材承诺的缺失与风险，不要求固定以打斗、穿越、系统或同一种事故开场。\n\n',
    recentReviewSignalContext(recentReviewSignals),
    chapterPlanContext(chapterPlan),
    '【全书/本部上下文】\n', context, '\n\n',
    `【第 ${chapterIndex} 章正文】\n`, content, '\n\n',
    CHAPTER_REVIEW_CRITERIA, '\n',
    '若系统提示词提供了作品核心循环，要检查正文是否正在建立、执行、变奏或升级这套持续体验；不能因为单章处于蓄力或余波阶段机械扣分，但长期脱离核心循环应优先报告。\n',
    '若提供了本章策划卡，必须同时核对正文是否实际完成其目标、阻碍、选择、兑现与钩子；策划卡不是正文证据，未落到场景中的意图应判为风险。\n',
    '若策划卡提供写前节奏意图，必须把 webFictionSignals.rhythmFingerprint 当作正文实际结果独立提取并逐项比较；',
    '不一致不自动等于失败，合理的人物因果改写可在 planComparison.summary 说明 adapted，但无意复刻近期风险或关键兑现/代价落空必须在对应检查项指出。\n',
    '若策划卡包含张力曲线、分层埋点、世界边界扩张、决策因果链或认知证据边界，planComparison 必须分别指出正文中的压力变化因果、',
    '具体载体、当下作用、人物反应与保留未知；新版合同还必须逐项核对压力来源→变化链→选择高点→兑现余波、',
    foreshadowingReviewChain, '、', worldExpansionReviewChain, '、',
    '当前误判/未决→不可撤回行动→利益受损者→针对性反制→状态改写→后续索债、以及',
    knowledgeReviewChain, '；',
    '不能把策划文字本身当成落地证据，也不能因正文重复了神秘名词就判 fulfilled。\n',
    '若策划卡包含场景链，要逐场核对欲望、阻碍、行动、转折和代价是否被正文演成具体过程，并额外核对承接触发；',
    '尤其检查后一场是否真的由前一场的新局势触发。只用一段概述带过、靠换地点并列事件、删除前场后后场仍可原样发生，',
    '或场景结束后人物可用资源、关系、认知、风险和目标均未变化，都应在 sceneExecution 判为风险。\n',
    '若上下文提供人物导演卡，characterChoice 要核对当前欲望、恐惧与受压反应是否真正驱动选择；同时检查不同人物的措辞、回避方式和潜台词是否可区分。导演卡中的秘密不是正文已揭示事实，不得因正文暂未公开而扣分。\n',
    '策划中的[建立承诺:ID]、[推进债务:ID]、[兑现债务:ID]是编辑后台任务，不是小说文字。',
    '只在正文确实完成对应动作时，把该 ID 写入 promiseLedgerCandidates；evidence 必须逐字复制正文中一段可定位的连续短句，',
    'summary 用一句话记录读者实际获得的新承诺、进展或兑现结果。beat 必须原样落实策划所选节拍：建立承诺只能 plant，兑现只能 payoff，',
    '推进只能 pressure/misdirect/reinterpret/collide；readerBefore、readerAfter、actionConsequence、worldLink、worldEffect 必须与 v3 策划合同完全一致。',
    '若正文只是重复神秘名词、读者判断没有变化、人物行动不受影响、证据不足、策划仍是旧 v1/v2、策划要求延期或本章无埋点任务，返回空数组；',
    '不得自创 ID、改变策划动作，也不得把候选当成已经更新账本。\n',
    hasSectionWorldContract
      ? reviewableWorldGate
        ? `本部世界合同计划完成从“${reviewableWorldGate.layer}”到“${reviewableWorldGate.toLayer}”的门槛。只有本章正文中的人物行动确实完成“${reviewableWorldGate.gateCondition}”时，worldGateCandidates 才返回 1 项；evidence 必须逐字复制正文连续原文，summary 只概括这段证据实际完成了什么。仅接近门槛、重复设定、旁白宣布、策划写了完成或证据不在本章时返回 []。候选仍需作者确认，不得当成已经解锁。\n`
        : '本部世界合同不允许在本章解锁相邻下一层，worldGateCandidates 必须返回 []；不得因为正文出现更大势力、新地图或高层名词而伪造门槛完成。\n'
      : '',
    chapterPlanComparisonInstruction(chapterPlan),
    '返回严格的 JSON（不要多余文字），格式：\n',
    '{"score":78, "verdict":"40字内一句话判断",',
    '"webFictionSignals":{"chapterFunction":"本章结构功能，如推进/兑现/转折/缓冲",',
    '"conflictType":"主要冲突类型","emotionTone":"主要情绪类型",',
    '"payoffType":"主要爽点或兑现类型；没有则写无",',
    '"dominantMode":"占比最高的表达方式，如场景/对话/行动/心理/说明",',
    '"rhythmFingerprint":{"pressurePattern":"steady-rise|wave-rise|false-relief|reversal-led|choice-led|aftermath",',
    '"resolutionMethod":"none|force|skill|wit|negotiation|sacrifice|cooperation|endurance|discovery|failure|mixed",',
    '"payoffScale":"none|micro|chapter|stage|major",',
    '"hookMechanism":"none|new-threat|new-information|unfinished-action|forced-choice|relationship-shift|world-opening|deadline|aftermath-question",',
    '"costType":"none|physical|resource|identity|relationship|moral|time|position|knowledge|mixed"}},',
    '"webFictionChecks":[',
    '{"id":"goldenChapter","status":"pass|risk|na","detail":"120字内依据",',
    '"goldenEvidence":{"setupQuote":"仅全书前三章且 status=pass 时必填：本章职责所需问题/机制/压力正文连续原文","fulfillmentQuote":"此后完成首次展示/升级/兑现的正文连续原文"}},',
    '{"id":"premisePromise","status":"pass|risk|na","detail":"120字内依据",',
    '"premiseEvidence":{"promiseQuote":"status=pass 时必填：核心欲望/机制/卖点在正文中运转的连续原文","deliveryQuote":"此后产生相关可感知回报的连续原文"}},',
    '{"id":"chapterGoal","status":"pass|risk|na","detail":"120字内依据",',
    '"goalEvidence":{"goalQuote":"status=pass 时必填：人物形成当下目标的正文连续原文","attemptQuote":"此后人物为该目标采取具体行动的正文连续原文"}},',
    '{"id":"obstacleEscalation","status":"pass|risk|na","detail":"120字内依据",',
    '"obstacleEvidence":{"baseQuote":"status=pass 时必填：前置阻碍/门槛正文连续原文","escalatedQuote":"此后由行动或后果导致的更难局面正文连续原文"}},',
    '{"id":"characterChoice","status":"pass|risk|na","detail":"120字内依据",',
    '"choiceEvidence":{"pressureQuote":"status=pass 时必填：人物面临互斥目标/选项或取舍压力的正文连续原文","choiceQuote":"此后人物主动选定路径的正文连续原文"},',
    '"costEvidence":{"choiceQuote":"声明非 none 代价时必填，且须与 choiceEvidence.choiceQuote 一致","consequenceQuote":"该选择之后实际受损或受限的正文连续原文"}},',
    '{"id":"sceneExecution","status":"pass|risk|na","detail":"120字内依据",',
    '"sceneEvidence":{"actionQuote":"status=pass 时必填：人物具体行动正文连续原文","reactionQuote":"此后他人/环境即时反应正文连续原文","turnQuote":"反应进一步改变局面的正文连续原文"}},',
    '{"id":"effectiveIncrement","status":"pass|risk|na","detail":"120字内依据",',
    '"incrementEvidence":{"triggerQuote":"status=pass 时必填：人物行动或新证据的正文连续原文","stateQuote":"此后形成的新局势/关系/认知/资源状态正文连续原文"}},',
    '{"id":"payoff","status":"pass|risk|na","detail":"120字内依据",',
    '"payoffEvidence":{"actionQuote":"status=pass 时必填：人物主动行动的正文连续原文","resultQuote":"status=pass 时必填：该行动之后可见兑现/状态变化的正文连续原文"}},',
    '{"id":"endingHook","status":"pass|risk|na","detail":"120字内依据",',
    '"hookEvidence":{"setupQuote":"声明非 none 钩子且 status=pass 时必填：章尾前已建立矛盾/行动/信息的正文连续原文","hookQuote":"由此前铺垫推出的章尾牵引正文连续原文"}},',
    '{"id":"tensionDynamics","status":"pass|risk|na","detail":"120字内依据",',
    '"tensionEvidence":{"pressureQuote":"status=pass 时必填：具体压力局面正文连续原文","shiftQuote":"人物行动使局面发生有意义变化的连续原文","aftermathQuote":"此后反制/代价/余波连续原文"}},',
    '{"id":"foreshadowingExecution","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"worldExpansion","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"proseHumanity","status":"pass|risk|na","detail":"120字内依据",',
    '"evidence":"status=risk 时必填：120字内正文连续原文"},',
    '{"id":"expressionBalance","status":"pass|risk|na","detail":"120字内依据",',
    '"evidence":"status=risk 时必填：120字内正文连续原文"},',
    '{"id":"repetitionRisk","status":"pass|risk|na","detail":"120字内依据",',
    '"evidence":"status=risk 时必填：120字内正文连续原文"},',
    '{"id":"longArcProgress","status":"pass|risk|na","detail":"120字内依据",',
    '"longArcEvidence":{"threadQuote":"status=pass 时必填：正文触及既有主线/支线/承诺的连续原文","progressQuote":"此后形成持续新位置/证据/关系/下一步的连续原文"}},',
    '{"id":"styleConsistency","status":"pass|risk|na","detail":"120字内依据",',
    '"evidence":"status=risk 时必填：120字内正文连续原文"},',
    '{"id":"packagingPromise","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"contentRisk","status":"pass|risk|na","detail":"120字内依据"}],',
    '"planComparison":{"overall":"aligned|adapted|partial|diverged|na",',
    '"summary":"300字内总结","items":[{"target":"goal、rhythmIntent 或 scene-1 等标识",',
    '"outcome":"fulfilled|adapted|missed|unclear","evidence":"200字内正文证据"}],',
    '"carryovers":[{"sourceTarget":"对应未完成标识","text":"300字内下章待处理事项",',
    '"reason":"200字内延续理由","suggestedField":"goal|obstacle|choice|payoff|hook|tensionArc|foreshadowing|worldExpansion|decisionChain|knowledgeDesign|notes"}]},',
    '"promiseLedgerCandidates":[{"entryId":"策划中原样债务ID",',
    '"action":"establish|advance|pay","summary":"300字内账本更新摘要",',
    '"evidence":"120字内正文连续原文","beat":"plant|pressure|misdirect|reinterpret|collide|payoff",',
    '"readerBefore":"策划中的读者原判断","readerAfter":"策划中的读者新判断",',
    '"actionConsequence":"策划中的行动影响","worldLink":"none|deepen-current|support-gate",',
    '"worldEffect":"策划中的世界线作用"}],',
    hasSectionWorldContract
      ? '"worldGateCandidates":[{"fromLayer":"当前世界层","toLayer":"相邻下一层","gateCondition":"原样复制当前分部进入门槛","summary":"300字内实际完成结果","evidence":"120字内正文连续原文"}],'
      : '',
    '"issues":[{"title":"15字内问题标题","detail":"80字内具体说明"}],',
    '"suggestions":[{"label":"8字内按钮文案","instruction":"可直接用于抽打的修改指令"}]}\n',
    'webFictionChecks 必须严格按上述 id 各返回一次并保持顺序。status 只用 pass、risk、na。',
    'promiseLedgerCandidates 必须返回数组；没有被正文证据支持的账本动作就返回 []。',
    hasSectionWorldContract
      ? 'worldGateCandidates 必须返回数组；没有被本章正文连续原文完整支持的门槛完成就返回 []。'
      : '',
    'webFictionSignals 五个短标签必须各用 40 字内概括当前章；rhythmFingerprint 五项必须严格从给定英文枚举各选一项。',
    'pressurePattern 判断全章实际压力轨迹；resolutionMethod 判断人物最终靠什么改变局面；payoffScale 判断实际兑现规模；',
    'hookMechanism 判断最后牵引的因果机制；costType 判断本章关键选择已经付出或明确锁定的主要代价。只记录正文实际呈现，不写修改建议。',
    '前两项按上面的黄金三章职责判断，非全书前三章才用 na；其余项目通常必须给 pass 或 risk。',
    'goldenChapter 标 pass 时必须提供 goldenEvidence：setupQuote 逐字引用本章职责所需的问题、机制或压力已经进入现场，fulfillmentQuote 逐字引用此后完成该章对应的首次展示、升级或阶段兑现；',
    '不能因为章序属于前三章、提示词写了职责或审稿人抽象认为“节奏不错”就判 pass；非全书前三章标 na 时不需要 goldenEvidence；',
    'premisePromise 标 pass 时必须提供 premiseEvidence：promiseQuote 逐字引用核心欲望、机制或独特卖点在正文中实际运转的位置，deliveryQuote 逐字引用此后产生且与该卖点直接相关的可感知回报；',
    '只提设定名、由作者解释“这就是本书卖点”、展示与核心承诺无关的小胜，或机制出现却没有给读者任何结果，都必须判 risk；',
    'chapterGoal 至少检查目标是否可感知；obstacleEscalation 检查阻碍和压力变化；',
    'chapterGoal 标 pass 时必须提供 goalEvidence：goalQuote 逐字引用当前视角人物形成可感知当下目标的正文，attemptQuote 逐字引用此后人物为该目标采取的具体行动；',
    '作者摘要里写了目标、旁人下达任务但人物没有接住、人物只说口号却全章没有尝试，或行动与所称目标无关，都必须判 risk；',
    'obstacleEscalation 标 pass 时必须提供 obstacleEvidence：baseQuote 逐字引用前置阻碍或门槛，escalatedQuote 逐字引用此后因人物行动、敌方反制或既有后果而变得更难、时间更紧或选择更窄的局面；',
    '重复同一阻碍、只让人物喊得更凶、连续加入无关事故，或障碍自行消失后换一个毫不相干的新麻烦，都必须判 risk；',
    'characterChoice 检查人物是否尽早主动选择、是否付出或承担与选择匹配的代价；',
    'characterChoice 标 pass 时必须提供 choiceEvidence：pressureQuote 逐字引用人物已经面临的互斥目标、可辨认选项或取舍压力，choiceQuote 逐字引用此后人物主动选定的路径；',
    '没有替代方案的本能反应、他人替主角决定、命令下达后机械服从，或行动完成后才用旁白宣称“这是他的选择”，都必须判 risk；',
    '当 rhythmFingerprint.costType 不是 none 且 characterChoice 标 pass 时必须提供 costEvidence：choiceQuote 逐字引用人物选择，consequenceQuote 逐字引用此后已经发生的资源损失、关系破裂、身份暴露、地位下降、时间损耗、身体伤害、道德债务或选择空间收窄；',
    '只说“他付出了代价”、只感到疲惫或心痛、威胁尚未落地，或本章结束后一切资源、关系与行动空间照旧，都不能把 costType 声明为非 none；',
    'sceneExecution 检查关键事件是否由具体场景、行动、反应和局势转折呈现，且下一场由上一场结果触发，而非概述带过或并列拼接；还要检查开场是否消费上一章交接快照，视角、时间地点、进行中动作、伤势、关系、资源和知识边界被静默重置时必须判 risk；即使没有策划场景链也必须依据正文判断；',
    'sceneExecution 标 pass 时必须提供 sceneEvidence：actionQuote 逐字引用人物具体行动，reactionQuote 逐字引用此后他人或环境的即时反应，turnQuote 逐字引用反应进一步造成的局势转折，三段必须按因果顺序出现；',
    '一句话总结“双方激烈交锋后主角获胜”、只播报最终结果、或把行动/反应/转折写成互不相干的并列事件，都必须判 risk；',
    'effectiveIncrement 检查剧情、关系、线索、能力、世界认知或情绪是否至少一项真实改变；payoff 检查铺垫或本章蓄力是否有有效兑现。',
    'effectiveIncrement 标 pass 时必须提供 incrementEvidence：triggerQuote 逐字引用人物行动或本章新获得的证据，stateQuote 逐字引用由此产生且随后仍成立的新局势、关系、认知、资源或选择空间；',
    '重复读者已经知道的信息、忙碌一章又回到原位、情绪波动后完全复位、只获得没有影响行动的知识，都必须判 risk，不能冒充剧情推进；',
    'payoff 标 pass 时必须提供 payoffEvidence：actionQuote 逐字引用人物主动跨过阻碍的行动，resultQuote 逐字引用其后发生的可见兑现或状态变化，且结果原句必须出现在行动原句之后；',
    '只有无关信息、小便宜、敌人自行放弃、偶然掉落或没有改变局势的结果时必须判 risk，不得用抽象概括冒充挣得的爽点；',
    'endingHook 检查结尾牵引是否来自真实矛盾、未完成行动或信息差，而非生硬断句；',
    '当 rhythmFingerprint.hookMechanism 不是 none 且 endingHook 标 pass 时必须提供 hookEvidence：setupQuote 逐字引用章尾前已经建立的矛盾、行动或信息差，hookQuote 逐字引用其后由此前因果推出的章尾牵引；',
    '结尾才突然出现且此前毫无关联的来电、敲门、爆炸、新敌人或一句“他不知道噩梦才刚开始”，都不能仅凭突兀程度标 pass；',
    'tensionDynamics 检查压力是否由行动与后果产生至少两次有意义变化，有没有希望、小胜、误判、反制、选择或余波，',
    'tensionDynamics 标 pass 时必须提供 tensionEvidence：pressureQuote 逐字引用具体压力局面，shiftQuote 逐字引用人物行动使局面产生的希望、小胜、误判或方向变化，aftermathQuote 逐字引用其后因前述变化产生的反制、代价或余波；',
    '不得把连续事故、持续高音量、只增加紧张形容词或突兀揭密误判为跌宕；\n',
    'foreshadowingExecution 在任务合同时检查策划中的债务 ID 是否与承诺账本状态一致、旧线是否回收/推进、',
    '新线是否有具体载体与当下用途、是否改变读者判断和人物行动；v3 合同还要检查节拍是否有效且没有连续重复同一种手法、',
    '公平误导是否公开了视角人物可见的证据、世界线作用是否真的发生；后台债务 ID 不得出现在小说正文；',
    '在“无埋点理由”合同时，正文遵守指定聚焦且没有硬造线索、假推进或提前揭密可标 pass，违背边界标 risk；',
    '没有任何策划要求且正文也无埋点任务时才标 na，不能因为出现神秘名词就判 pass；\n',
    'worldExpansion 先核对正文是否守住展开前的读者/视角人物认知，再检查世界是否通过人物可验证的一层证据扩大、',
    '新认知是否改变选择或代价，并保留合理未知；没有扩张任务的聚焦章节可标 na。把作者后台真相写成角色已知、',
    '重复讲解已揭示规则、百科说明、全知切镜和专有名词堆砌必须判 risk；\n',
    'proseHumanity 检查是否存在成片同构短段、密集排比或“不是……而是……”、替读者总结主题、',
    '人物同声同气、抽象感叹、明喻堆叠、成片连续短段金句腔，以及破折号集中替代正常句法或反复制造同一种停顿；不要因单个贴切比喻、单次合理破折号或自然对话短段扣分，应看每千字密度、段落集中度与最长连续短段串；proseHumanity、expressionBalance、repetitionRisk 或 styleConsistency 为 risk 时，evidence 必须逐字复制当前正文中一段可定位的连续短句，',
    '引文至少6个字且在当前章中必须唯一；常见短句重复出现时扩大前后文，直到能唯一定位。detail 再解释该原句暴露的具体模式。禁止只写“有 AI 味”、虚构引文或只报段落位置；\n',
    'expressionBalance 检查说明、场景、对话、行动和心理是否长期被单一方式挤占，也要检查短段、排比、总结句和比喻是否同强度重复；',
    'repetitionRisk 只判断正文及所给上下文中有证据的重复桥段、情绪、解释、同质冲突或节奏指纹；',
    '若当前章与最近两章完整指纹相同，或把系统标出的连续风险继续重复却没有因果升级，应判 risk。看不到的历史不得猜测，也不得为机械轮换而扣分。\n',
    'longArcProgress 对照作品核心循环、承诺—推进—兑现账本、全书/本部大纲、阶段摘要和已确认伏笔，检查持续阅读体验、主线承诺、重要人物线或伏笔是否已有长期未推进、逾期未兑现或无因果销账风险；',
    'longArcProgress 标 pass 时必须提供 longArcEvidence：threadQuote 逐字引用正文触及已有主线、支线或读者承诺的位置，progressQuote 逐字引用此后形成且能持续到后文的新证据、新关系位置、新约束或明确下一步；',
    '只提一次线索名、复述旧目标、角色口头说“以后再查”，或加入对后文没有影响的小插曲，都必须判 risk；证据不足时标 na，不得编造未提供的历史。\n',
    'styleConsistency 仅在系统提示词包含“文风基调”或“已绑定创作资产”时检查：先对照全书文风圣经的稳定锚点与禁止表达，',
    '再检查局部抽象文风资产，判断句式、叙事距离、人物语言、修辞密度和节奏是否明显偏离；',
    '局部资产只能细化可变维度，不能覆盖全书稳定锚点。合理的战斗、对话、悬疑、感情、日常或高潮场景变化不得机械判 risk。',
    '两者都没有时必须标 na。\n',
    'packagingPromise 对照书名、作品简介/初始设想和当前正文检查题材承诺是否一致；全书前三章还要重点判断开篇是否及时兑现包装卖点。',
    '后续章节只检查是否仍服务该承诺，不得猜测未提供的开篇内容。\n',
    'contentRisk 只提示当前正文中需要作者进一步核对的明显风险线索，例如露骨色情、违法犯罪美化、仇恨骚扰、未成年人伤害、现实人物名誉、侵权搬运、广告联系方式等；',
    '没有明显线索可标 pass，但必须说明这不是法律结论或平台最新规则审核，不得声称已经合规。\n',
    'score 是 0-100 整数。issues 给 3-5 条，优先报告最影响追读与一致性的问题；',
    'suggestions 给 3 条，必须是可直接执行的具体改法，不能只有“加强描写”“提升节奏”等空话。',
  ]);
}

export function buildWritingAssetExtractionInstruction({ sourceName, sourceKind, sourceText }) {
  return boundedJoin([
    '请分析下面的创作样本，并严格按给定结构返回 JSON。\n',
    `【来源说明】${sourceName}\n【授权类型】${sourceKind}\n`,
    '【输出结构】\n',
    '{"style":{"summary":"整体文风概括","narrative":"叙事视角与距离",',
    '"sentenceRhythm":"句式与节奏","vocabulary":"词汇与语言密度",',
    '"dialogue":"对话特点","dialogueRatio":"对话占比与分布",',
    '"description":"描写取舍与重心","humor":"幽默感及使用方式",',
    '"emotion":"情绪表达","emotionTemperature":"情绪温度",',
    '"conflictFrequency":"冲突出现频率","payoffType":"主要爽点/兑现类型",',
    '"conflictAndPayoff":"冲突与爽点呈现","chapterHooks":"开篇与章尾牵引",',
    '"prompt":"可直接用于本书文风设定的抽象执行指令","avoid":["应避免的表达"]},',
    '"story":{"summary":"样本可见的故事结构概括","evidenceLevel":"low|medium|high",',
    '"premisePattern":"题材承诺或核心假设","protagonistDrive":"主角驱动力",',
    '"conflictEngine":"持续冲突来源","escalation":"升级方式",',
    '"arcStructure":"阶段或弧线结构","chapterPattern":"单章推进模式",',
    '"payoffPattern":"兑现模式","hookPattern":"悬念与追读模式",',
    '"reusableTechniques":["可复用技法"],"uncertainties":["样本不足而无法确认的内容"]}}\n',
    '所有字段都要给出；确实无法判断时写“样本不足，无法确认”，不要编造。',
    'prompt 要具体说明视角与距离、句式、对话比例、描写重心、幽默感、情绪温度、节奏、冲突频率、爽点/兑现和章尾牵引，',
    '但不得出现作者名、作品名或样本专有名词。\n',
    '【创作样本】\n', sourceText,
  ]);
}
