import { MAX_LLM_INPUT_CHARS } from './limits.js';
import {
  generationBookOutlineText, generationCharacterRows, generationCoreFieldText,
  generationPriorSectionSummary,
  generationMemoryRelevantText, generationMemoryRows, generationSectionOutlineText,
  previousChapterEndingText, recentSectionSummary,
} from './generation-context.js';

export {
  generationBookOutlineText, generationCharacterRows, generationCoreFieldText,
  generationPriorSectionSummary,
  generationMemoryRelevantText, generationMemoryRows, generationSectionOutlineText,
  previousChapterEndingText, recentSectionSummary,
} from './generation-context.js';

function boundedJoin(parts, separator = '') {
  let total = Math.max(0, parts.length - 1) * separator.length;
  for (const part of parts) {
    total += String(part ?? '').length;
    if (total > MAX_LLM_INPUT_CHARS) throw new Error('LLM_INPUT_TOO_LARGE');
  }
  return parts.join(separator);
}

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

export const WEB_FICTION_WRITING_PRINCIPLES = [
  '【长期网文创作准则】\n',
  '以下是创作正文时必须遵守的通用底线；本书的世界观、文风、禁忌和篇幅节奏是具体规范。',
  '若发生冲突，以禁忌约束和用户本次明确修改要求为最高优先级。\n',
  '1. 写具体的人、行动、对话与后果，不用抽象总结代替关键场景，不用百科说明代替剧情。\n',
  '2. 人物必须依据自身欲望、处境和已知信息行动；对话要有身份差异、潜台词和即时目的。\n',
  '3. 克制模板化修辞：不要密集堆砌比喻、排比、短句金句和“不是……而是……”式总结；',
  '同一种句式或意象不要机械重复。长短句随场景自然变化，文字清楚、有质感但不炫技。\n',
  '4. 每章都要改变故事状态，至少推进剧情、关系、线索、能力、认知或情绪中的一项；',
  '安静章节也必须有选择、信息差或关系变化，不能只是过场。\n',
  '5. 爽点不是只指打赢：发现真相、展现能力、扳回一局、获得资源、情绪释放、关系兑现都可以。',
  '兑现必须由前文铺垫和人物选择产生，不能凭空送给主角。\n',
  '6. 章节应有压力与缓冲、蓄力与兑现，避免从头到尾同一强度；重要转折要写成场景，',
  '不要用一段概述匆忙烧掉本可持续展开的剧情。\n',
  '7. 结尾留下由真实矛盾、未完成行动或新信息产生的牵引力，不用生硬断句制造假悬念。\n',
  '8. 输出前静默核对姓名、身份、数量、时间、地点、能力边界和人物知识边界，避免前后矛盾。',
].join('');

export const CHAPTER_EXECUTION_CHECKLIST = [
  '【本章执行清单】\n',
  '- 尽快进入当前人物目标、异常或冲突，不以无目的背景介绍开场。\n',
  '- 让“目标 → 阻碍 → 选择 → 后果/变化”在本章形成可感知的推进。\n',
  '- 至少安排一次有效兑现和一次后续牵引；二者必须服务本章与主线，不能机械拼装。\n',
  '- 用场景和人物反应承载信息，删掉重复解释、空泛感叹及只为显得深刻的修辞。\n',
  '- 保留必要的呼吸感，但不能让主要人物长时间被动旁观或让剧情原地踏步。\n',
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
    return [
      `- 全书第 ${row.bookChapterIndex} 章：章节功能=${signals.chapterFunction}`,
      `；冲突=${signals.conflictType}；情绪=${signals.emotionTone}`,
      `；爽点/兑现=${signals.payoffType}；主要表达=${signals.dominantMode}`,
    ].join('');
  });
  return boundedJoin([
    '【最近章节节奏记录（由当时审稿提取）】\n',
    boundedJoin(lines, '\n'), '\n',
    '只在记录提供证据时避免连续重复的桥段、冲突、情绪、兑现和表达方式；',
    '不为追求机械轮换而破坏当前剧情因果。\n',
  ]);
}

export function buildSystemPrompt(core = {}, writingAssetContext = '') {
  return boundedJoin([
    '你是一位擅长长篇连载的专业网文作者。严格遵守以下设定与创作准则：\n',
    WEB_FICTION_WRITING_PRINCIPLES, '\n',
    line('世界观', generationCoreFieldText(vtext(core.world))),
    line('文风基调', generationCoreFieldText(vtext(core.style))),
    writingAssetContext ? `${writingAssetContext}\n` : '',
    // 硬约束仍是最高优先级；超出模型预算时保留开头和结尾并明确标记。
    line('禁忌约束', generationCoreFieldText(vtext(core.constraints))),
    line('篇幅节奏', generationCoreFieldText(vtext(core.pacing))),
  ]).trim();
}

export function buildContext({ book = {}, section = {}, prevChapter = null }) {
  const chars = (arr) => {
    return boundedJoin(generationCharacterRows(arr), '\n');
  };
  const parts = [
    line('书名', typeof book.title === 'string' ? book.title : ''),
    line('作品简介 / 初始设想', generationCoreFieldText(
      typeof book.premise === 'string' ? book.premise : '',
    )),
    line('全书大纲', generationBookOutlineText(vtext(book.outline))),
    line('此前分部剧情', generationPriorSectionSummary(book, section.id)),
    line('本部大纲', generationSectionOutlineText(section.outline?.content)),
    line('本部前情', recentSectionSummary(section.summary)),
  ];
  const mainC = chars(book.characters);
  const secC = chars(section.characters);
  if (mainC) parts.push(boundedJoin(['【主要人物】\n', mainC, '\n']));
  if (secC) parts.push(boundedJoin(['【本部人物】\n', secC, '\n']));
  const memoryRows = generationMemoryRows(book.memory, {
    relevantText: generationMemoryRelevantText({ book, section, prevChapter }),
  });
  if (memoryRows.length) {
    parts.push(boundedJoin(['【已确认长期记忆】\n', boundedJoin(memoryRows, '\n'), '\n']));
  }
  if (prevChapter) {
    const lineC = chars(prevChapter.characters);
    if (lineC) parts.push(boundedJoin(['【上一章登场人物】\n', lineC, '\n']));
    if (prevChapter.content) {
      parts.push(boundedJoin(['【上一章结尾】', previousChapterEndingText(prevChapter.content), '\n']));
    }
    parts.push(line('接下来要写', prevChapter.progress));
  }
  return boundedJoin(parts).trim();
}

export function buildChapterInstruction({
  chapterIndex, bookChapterIndex = chapterIndex, wordTarget, mode, whip, currentContent,
  recentReviewSignals = [],
}) {
  const base = `请写第 ${chapterIndex} 章正文，约 ${wordTarget} 字，直接输出正文，不要标题和解说。`;
  const current = currentContent ? boundedJoin(['\n【当前章原文】\n', currentContent, '\n']) : '';
  const opening = bookChapterIndex <= 3
    ? `${goldenThreeGuidance(bookChapterIndex)}\n`
    : '';
  const craft = boundedJoin([
    '\n', opening, recentReviewSignalContext(recentReviewSignals),
    CHAPTER_EXECUTION_CHECKLIST, '\n',
  ]);
  if (mode === 'rewrite') {
    return boundedJoin([
      current,
      `重写第 ${chapterIndex} 章，保持大纲方向与核心情节，重点修复平淡、概述化和模板化表达。`,
      craft, base,
    ]);
  }
  if (mode === 'whip') {
    return boundedJoin([
      current,
      '用户对当前内容不满，最高优先级要求：『', whip, '』。请据此重写。',
      craft, base,
    ]);
  }
  return boundedJoin([craft, base]);
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

export function buildSectionsInstruction(outline) {
  return boundedJoin([
    '基于以下全书大纲，规划分部（卷）结构。每个分部必须有独立目标并推进全书主线。\n', outline, '\n',
    '返回严格的 JSON 对象（不要多余文字），格式：\n',
    '{"sections":[{"title":"8字内纯标题，不带第N部","summary":"本部概述",',
    '"promise":"本部向读者建立的具体期待","goal":"本部明确目标",',
    '"obstacle":"主要阻力","progress":"对全书主线的推进",',
    '"climax":"阶段高潮","payoff":"本部兑现什么承诺",',
    '"stateChange":"本部结束后人物、关系或局势的不可逆变化"}]}\n',
    '至少 2 个部，title 不要序号、书名号、引号；其余字段各 300 字内且不得留空。',
    '相邻分部要有因果和升级，不能只是换地图或重复同类冲突。',
  ]);
}

export const DIGEST_INSTRUCTION =
  '请阅读上文这一章正文，返回严格的 JSON（不要多余文字），格式：' +
  '{"chapterTitle":"本章10字内纯标题，不带第N章",' +
  '"sectionTitle":"本部10字内纯标题，不带第N部",' +
  '"summary":"本章50字内小结","progress":"下一步剧情走向",' +
  '"characters":[{"name":"名","role":"身份","desc":"本章结束时的最新状态"}],' +
  '"memoryCandidates":[{"kind":"character|relationship|ability|item|location|timeline|faction|foreshadowing|knowledge|other",' +
  '"subject":"主体","predicate":"关系或属性","object":"本章明确成立的值",' +
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

export function buildCoreFieldInstruction(field, book) {
  const names = { world: '世界观', style: '文风基调', constraints: '禁忌约束', pacing: '篇幅节奏' };
  const core = (book.settings && book.settings.core) || {};
  const others = [];
  for (const k of Object.keys(names)) {
    if (k === field) continue;
    others.push(line(names[k], generationCoreFieldText(vtext(core[k]))));
  }
  return boundedJoin([
    '这本书的故事设想：『', book.premise || '', '』。\n已有设定：\n',
    boundedJoin(others), '请为这本书重新拟定『', names[field],
    '』，200 字内，与其它设定保持一致，只输出该项内容，不要解释、不要标题。',
  ]);
}

export function buildChapterReviewInstruction({
  chapterIndex, bookChapterIndex = chapterIndex, content, context,
  recentReviewSignals = [],
}) {
  return boundedJoin([
    `请以专业审稿编辑的身份，审阅第 ${chapterIndex} 章正文（当前分部章序）；它是全书第 ${bookChapterIndex} 章。\n`,
    goldenThreeGuidance(bookChapterIndex), '\n',
    '黄金三章只指出当前题材承诺的缺失与风险，不要求固定以打斗、穿越、系统或同一种事故开场。\n\n',
    recentReviewSignalContext(recentReviewSignals),
    '【全书/本部上下文】\n', context, '\n\n',
    `【第 ${chapterIndex} 章正文】\n`, content, '\n\n',
    CHAPTER_REVIEW_CRITERIA, '\n',
    '返回严格的 JSON（不要多余文字），格式：\n',
    '{"score":78, "verdict":"40字内一句话判断",',
    '"webFictionSignals":{"chapterFunction":"本章结构功能，如推进/兑现/转折/缓冲",',
    '"conflictType":"主要冲突类型","emotionTone":"主要情绪类型",',
    '"payoffType":"主要爽点或兑现类型；没有则写无",',
    '"dominantMode":"占比最高的表达方式，如场景/对话/行动/心理/说明"},',
    '"webFictionChecks":[',
    '{"id":"goldenChapter","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"premisePromise","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"chapterGoal","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"obstacleEscalation","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"characterChoice","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"effectiveIncrement","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"payoff","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"endingHook","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"expressionBalance","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"repetitionRisk","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"longArcProgress","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"styleConsistency","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"packagingPromise","status":"pass|risk|na","detail":"120字内依据"},',
    '{"id":"contentRisk","status":"pass|risk|na","detail":"120字内依据"}],',
    '"issues":[{"title":"15字内问题标题","detail":"80字内具体说明"}],',
    '"suggestions":[{"label":"8字内按钮文案","instruction":"可直接用于抽打的修改指令"}]}\n',
    'webFictionChecks 必须严格按上述 id 各返回一次并保持顺序。status 只用 pass、risk、na。',
    'webFictionSignals 五个字段必须各用 40 字内短标签概括当前章，只记录正文实际呈现，不写修改建议。',
    '前两项按上面的黄金三章职责判断，非全书前三章才用 na；其余项目通常必须给 pass 或 risk。',
    'chapterGoal 至少检查目标是否可感知；obstacleEscalation 检查阻碍和压力变化；',
    'characterChoice 检查人物是否尽早主动选择、是否付出或承担与选择匹配的代价；',
    'effectiveIncrement 检查剧情、关系、线索、能力、世界认知或情绪是否至少一项真实改变；payoff 检查铺垫或本章蓄力是否有有效兑现；',
    'endingHook 检查结尾牵引是否来自真实矛盾、未完成行动或信息差，而非生硬断句；',
    'expressionBalance 检查说明、场景、对话、行动和心理是否长期被单一方式挤占；',
    'repetitionRisk 只判断正文及所给上下文中有证据的重复桥段、情绪、解释或同质冲突，看不到的历史不得猜测。\n',
    'longArcProgress 对照全书/本部大纲、阶段摘要和已确认伏笔，检查主线承诺、重要人物线或伏笔是否已有长期未推进风险；',
    '证据不足时标 na，不得编造未提供的历史。\n',
    'styleConsistency 仅在系统提示词包含“已绑定创作资产”时检查：对照抽象文风卡判断句式、叙事距离、人物语言、修辞密度和节奏是否明显偏离；',
    '合理的战斗、对话、悬疑、感情、日常或高潮场景变化不得机械判 risk。没有绑定资产时必须标 na。\n',
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
