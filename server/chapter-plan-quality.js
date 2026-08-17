import { sectionWorldContract } from './section-world-contract.js';

export const TENSION_CONTRACT_LABELS = Object.freeze([
  '压力来源', '变化链', '选择高点', '兑现与余波',
]);
export const FORESHADOWING_CONTRACT_LABELS = Object.freeze([
  '旧线/阅读债务', '具体载体', '当下作用', '行动影响', '保留未知',
]);
export const FORESHADOWING_CONTRACT_LABELS_V3 = Object.freeze([
  '旧线/阅读债务', '叙事节拍', '认知变化', '具体载体',
  '当下作用', '行动影响', '世界线作用', '保留未知',
]);
export const FORESHADOWING_NO_TASK_LABELS = Object.freeze([
  '无埋点理由', '本章聚焦', '既有未知处理',
]);
const WORLD_EXPANSION_CONTRACT_LABELS_V1 = Object.freeze([
  '既有依据', '可验证证据', '边界增量/机制深化', '选择与代价', '保留未知',
]);
export const WORLD_EXPANSION_CONTRACT_LABELS = Object.freeze([
  '展开前认知', '既有依据', '可验证证据',
  '边界增量/机制深化', '选择与代价', '保留未知',
]);
export const DECISION_CHAIN_CONTRACT_LABELS = Object.freeze([
  '当前误判/未决', '验证/争取行动', '利益受损者',
  '针对性反制', '状态改写', '后续索债',
]);
export const KNOWLEDGE_DESIGN_CONTRACT_LABELS = Object.freeze([
  '当前问题', '可见依据', '允许结论', '替代解释', '交叉验证', '保留未知',
]);
export const KNOWLEDGE_DESIGN_NO_TASK_LABELS = Object.freeze([
  '无认知任务理由', '本章聚焦', '既有判断处理',
]);

export const CHAPTER_PLAN_QUALITY_FORMATS = Object.freeze({
  tensionArc: '压力来源：谁因什么处境承压；变化链：具体局势A→人物行动后的局势B→反制或代价后的局势C；选择高点：谁必须怎样选择；兑现与余波：兑现什么并留下什么后果',
  foreshadowing: '旧线/阅读债务：本章推进或回收什么；叙事节拍：植入/加压/公平误导/变义/线索碰撞/回收六选一；认知变化：读者原先判断→本章结束后的新判断；具体载体：可见的物件、动作、矛盾或错误判断；当下作用：载体在当前场景有什么用；行动影响：它迫使谁改变什么行动或承担什么风险；世界线作用：不关联/深化当前层/支撑下一层门槛及具体作用；保留未知：本章明确不回答什么',
  worldExpansion: '展开前认知：本章开始时读者与当前视角人物已经知道什么、仍把什么当未知；既有依据：世界圣经或大纲中的哪条既有规则、势力利益或历史后果；可验证证据：人物能触碰或核验什么；边界增量/机制深化：本章结束时读者与人物具体多知道哪一层；选择与代价：证据迫使谁怎样选择并承担什么；保留未知：本章仍不揭示什么',
  decisionChain: '当前误判/未决：人物本章开始时错误相信什么或必须解决什么；验证/争取行动：人物为验证判断或争取目标采取什么不可撤回行动；利益受损者：谁因该行动失去利益、控制或安全；针对性反制：对方如何针对这次具体行动反制；状态改写：章初的资源/关系/认知/权限状态→章末的新状态；后续索债：本章选择造成什么必须继续处理的具体后果',
  knowledgeDesign: '当前问题：读者与视角人物本章要判断什么；可见依据：正文会公平展示什么物证、行为、记录或矛盾；允许结论：依据最多能推出哪一层；替代解释：合理解释A｜合理解释B；交叉验证：独立来源A＋独立来源B；保留未知：本章明确不能据此确认什么',
});
export const CHAPTER_PLAN_NO_FORESHADOWING_FORMAT =
  '无埋点理由：为什么本章不推进、兑现或建立阅读债务；本章聚焦：本章把注意力用在哪项行动、关系或兑现上；既有未知处理：哪些既有未知保持原状态，既不假装推进也不提前揭示';
export const CHAPTER_PLAN_NO_KNOWLEDGE_TASK_FORMAT =
  '无认知任务理由：为什么本章不新增、验证或改写判断；本章聚焦：本章把篇幅用于哪项行动、关系、兑现或余波；既有判断处理：现有问题与假说保持什么状态，不假装获得新结论';

// 策划卡字段是作者的思考结果。按 context-not-control，这里说明每个字段
// 想避免的问题和背后的原因，由模型判断本章怎么落地；只有会污染正文的
// 后台锚点仍是硬约束，且已由 chapter-output-guard.js 确定性拦截。
export const CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE = [
  '【策划卡各字段想解决的问题】\n',
  '这些字段是作者的思考结果，不是需要在正文里出现的标签，也不需要逐栏对应成段落。',
  '下面说明每一栏想避免什么问题；怎么落地由你根据本章判断。\n',
  '- 张力：读者疲劳几乎都来自“事情一直在发生，但强度没有变化”。',
  '“压力来源”是人物实际受到的具体限制，“变化链”的每一步应当由上一步的行动或后果逼出来，',
  '“选择高点”是人物回避不了的那个决定，“兑现与余波”是读者能看见的结果和它留下的新局面。',
  '并排摆放三件事不会产生张力，后一件由前一件造成才会。\n',
  '- 埋点：伏笔失效通常有两种，一种是读者根本没注意到，一种是读者早就猜到却迟迟不揭。',
  '所以“具体载体”要先在当前场景真的有用，再去改变人物行动——读者记住的是有用的东西，不是被点名的东西。',
  '若策划写了“叙事节拍、认知变化、世界线作用”，本章只推进一拍',
  '（植入、加压、公平误导、变义、线索碰撞、回收），并让读者的判断真的发生变化；',
  '同一个名词再出现一次，读者不会觉得有推进。公平误导的前提是可见证据都已交给读者，',
  '隐瞒视角人物已经看见的关键事实会让揭晓时变成欺骗而不是惊讶。',
  '若策划采用“无埋点理由”格式，本章就不必为显得神秘另造线索，把篇幅用在指定的行动、关系或兑现上更有效。\n',
  '- 决策因果：从“收到线索”直接跳到“得到答案”，读者会觉得主角只是在接收剧情。',
  '先让人物带着当前误判或未决问题采取一次不可撤回的行动，让因此受损的一方针对这次行动反制，',
  '章末的资源、关系、认知、权限或风险与章初不同——下一章处理本章选择留下的债务，',
  '比外挂一个新事故更能让人觉得故事在长。\n',
  '- 认知与证据：推理的说服力来自“当时还有别的可能”。有判断任务时，正文只推到策划允许的结论，',
  '保留至少两个当时同样合理的解释，并让关键结论有两个互相独立的来源。',
  '能力、直觉、匿名消息、反派自白和自动出现的文件单独成立时，读者会认为是作者在直接给答案。',
  '没有判断任务时，明确把篇幅给行动、关系、兑现或余波即可，不必硬造悬疑。\n',
  '- 世界展开：让人相信世界很大的不是名词数量，而是人物触碰到规则时付出的代价。',
  '从“既有依据”出发，用人物能触碰、核验的证据推进一层认知，让证据迫使人物选择并承担后果，',
  '同时守住“保留未知”。已经揭示过的规则应当直接参与行动，重新包装成新谜底读者会认出来。\n',
  '- 一条硬约束：形如[推进债务:promise_…]、[兑现债务:promise_…]、[建立承诺:promise_…]、',
  '[延期债务:promise_…]的编辑后台锚点，以及本卡片的栏目名，都不能出现在正文、对话或叙述中；',
  '出现即整段作废。\n',
].join('');

const PLACEHOLDER_TEXT = /^(?:待定|待补充|待完善|待确认|暂无|无|不知道|待进一步明确)[。！!？?]?$/u;
const GENERIC_TENSION_BEAT = /^(?:受阻|希望|小胜|缓冲|反制|误判|选择|反转|升级|高潮|兑现|余波|更紧张|压力上升|冲突升级)[。！!？?]?$/u;
// v3 变化链至少要有一个后续节点明确消费前一步行动或后果。纯粹把三个
// “又有人/事故出现”并排写长，虽然字段和字数都合格，仍不构成跌宕。
const CAUSAL_TENSION_TRANSITION = /(?:使|迫使|导致|因此|于是|从而|换来|引来|引走|触发|暴露|失去|拒绝|反制|借此|不得不|转而|改(?:去|为|查|追)|打开|关闭|锁定|撤回|夺走|换取)/u;
const GENERIC_SECTION_TEXT = /^(?:伏笔|线索|真相|秘密|推进剧情|影响行动|产生影响|更大世界|更大势力|更强敌人|付出代价|保留未知|暂不揭示)[。！!？?]?$/u;
const TEMPLATE_SECTION_TEXT = new Set([
  '谁因什么处境承压', '谁必须怎样选择', '兑现什么并留下什么后果',
  '本章推进或回收什么', '可见的物件、动作、矛盾或错误判断',
  '载体在当前场景有什么用', '它迫使谁改变什么行动', '本章明确不回答什么',
  '植入/加压/公平误导/变义/线索碰撞/回收六选一',
  '读者原先判断→本章结束后的新判断',
  '它迫使谁改变什么行动或承担什么风险',
  '不关联/深化当前层/支撑下一层门槛及具体作用',
  '世界圣经或大纲中的哪条既有规则、势力利益或历史后果',
  '人物能触碰或核验什么', '读者具体多知道哪一层',
  '证据迫使谁怎样选择并承担什么', '本章仍不揭示什么',
  '本章开始时读者与当前视角人物已经知道什么、仍把什么当未知',
  '本章结束时读者与人物具体多知道哪一层',
  '为什么本章不推进、兑现或建立阅读债务',
  '本章把注意力用在哪项行动、关系或兑现上',
  '哪些既有未知保持原状态，既不假装推进也不提前揭示',
  '人物本章开始时错误相信什么或必须解决什么',
  '人物为验证判断或争取目标采取什么不可撤回行动',
  '谁因该行动失去利益、控制或安全', '对方如何针对这次具体行动反制',
  '章初的资源/关系/认知/权限状态→章末的新状态',
  '本章选择造成什么必须继续处理的具体后果',
  '读者与视角人物本章要判断什么', '正文会公平展示什么物证、行为、记录或矛盾',
  '依据最多能推出哪一层', '合理解释A｜合理解释B',
  '独立来源A＋独立来源B', '本章明确不能据此确认什么',
  '为什么本章不新增、验证或改写判断',
  '本章把篇幅用于哪项行动、关系、兑现或余波',
  '现有问题与假说保持什么状态，不假装获得新结论',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function meaningful(value, minimum = 4) {
  const source = text(value);
  return Array.from(source).length >= minimum && !PLACEHOLDER_TEXT.test(source);
}

function labelSections(value, labels) {
  const source = text(value);
  const markers = labels.map((label) => {
    const full = `${label}：`;
    const ascii = `${label}:`;
    const fullIndex = source.indexOf(full);
    const asciiIndex = source.indexOf(ascii);
    const index = fullIndex < 0 ? asciiIndex
      : asciiIndex < 0 ? fullIndex : Math.min(fullIndex, asciiIndex);
    return { label, index, markerLength: index === fullIndex ? full.length : ascii.length };
  });
  const duplicateLabels = labels.filter((label) => {
    const variants = [`${label}：`, `${label}:`];
    return variants.reduce((count, marker) =>
      count + source.split(marker).length - 1, 0) > 1;
  });
  const present = markers.filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  const orderValid = markers.every((entry, index) => entry.index >= 0
    && (index === 0 || markers[index - 1].index < entry.index));
  const prefixValid = markers[0]?.index === 0;
  const sections = {};
  present.forEach((entry, index) => {
    const start = entry.index + entry.markerLength;
    const end = present[index + 1]?.index ?? source.length;
    sections[entry.label] = source.slice(start, end).replace(/^[；;\s]+|[；;\s]+$/gu, '');
  });
  return { source, sections, orderValid, prefixValid, duplicateLabels };
}

function contractDiagnostics(value, labels) {
  const {
    source, sections, orderValid, prefixValid, duplicateLabels,
  } = labelSections(value, labels);
  const missingLabels = labels.filter((label) => !Object.prototype.hasOwnProperty.call(
    sections, label,
  ));
  const thinLabels = labels.filter((label) => Object.prototype.hasOwnProperty.call(
    sections, label,
  ) && (!meaningful(sections[label])
    || GENERIC_SECTION_TEXT.test(text(sections[label]))
    || TEMPLATE_SECTION_TEXT.has(text(sections[label]))));
  return {
    active: Boolean(source),
    valid: Boolean(source) && !missingLabels.length && !thinLabels.length
      && orderValid && prefixValid && !duplicateLabels.length,
    missingLabels,
    thinLabels,
    orderValid,
    prefixValid,
    duplicateLabels,
    sections,
  };
}

function tensionDiagnostics(value, protocolVersion = 1) {
  const diagnostics = contractDiagnostics(value, TENSION_CONTRACT_LABELS);
  const chain = text(diagnostics.sections['变化链']).split(/\s*(?:→|⇒|->|—>)\s*/u)
    .map((entry) => entry.trim()).filter(Boolean);
  const concreteChain = chain.filter((entry) => meaningful(entry)
    && !GENERIC_TENSION_BEAT.test(entry)
    && !/^(?:具体局势A|人物行动后的局势B|反制或代价后的局势C)$/u.test(entry));
  const distinctChain = new Set(concreteChain.map((entry) => entry
    .replace(/[\s，。！？、；;,.!?]/gu, '')));
  const shapeValid = chain.length >= 3 && concreteChain.length >= 3
    && distinctChain.size >= 3;
  const causalTransitionCount = concreteChain.slice(1)
    .filter((entry) => CAUSAL_TENSION_TRANSITION.test(entry)).length;
  const parallelIncidentRisk = protocolVersion >= 3 && shapeValid
    && causalTransitionCount < 1;
  const chainValid = shapeValid && !parallelIncidentRisk;
  return {
    ...diagnostics,
    valid: diagnostics.valid && chainValid,
    chainCount: chain.length,
    concreteChainCount: concreteChain.length,
    causalTransitionCount,
    parallelIncidentRisk,
    chainValid,
  };
}

const NARRATIVE_BEAT_ALIASES = Object.freeze({
  植入: 'plant', 加压: 'pressure', 公平误导: 'misdirect',
  误导: 'misdirect', 变义: 'reinterpret', 线索碰撞: 'collide', 回收: 'payoff',
});

function narrativeBeat(value) {
  const source = text(value);
  const matches = Object.entries(NARRATIVE_BEAT_ALIASES)
    .filter(([label]) => source.includes(label))
    .map(([, beat]) => beat);
  return new Set(matches).size === 1 ? matches[0] : null;
}

function readerChange(value) {
  const parts = text(value).split(/\s*(?:→|⇒|->|—>)\s*/u)
    .map((part) => part.trim()).filter(Boolean);
  return parts.length === 2 && meaningful(parts[0]) && meaningful(parts[1])
    && parts[0] !== parts[1]
    ? { before: parts[0], after: parts[1] } : null;
}

function worldLink(value) {
  const source = text(value);
  if (/^(?:不关联|无关|不连接|不推进世界线)/u.test(source)) return 'none';
  if (/(?:下一层|门槛|解锁)/u.test(source)) return 'support-gate';
  return source ? 'deepen-current' : null;
}

function foreshadowingDiagnostics(value, protocolVersion) {
  const source = text(value);
  if (source.startsWith(`${FORESHADOWING_NO_TASK_LABELS[0]}：`)
    || source.startsWith(`${FORESHADOWING_NO_TASK_LABELS[0]}:`)) {
    return {
      ...contractDiagnostics(source, FORESHADOWING_NO_TASK_LABELS),
      mode: 'none',
    };
  }
  const labels = protocolVersion >= 3
    ? FORESHADOWING_CONTRACT_LABELS_V3 : FORESHADOWING_CONTRACT_LABELS;
  const diagnostics = contractDiagnostics(source, labels);
  if (protocolVersion < 3) return {
    ...diagnostics,
    mode: 'task',
  };
  const beat = narrativeBeat(diagnostics.sections['叙事节拍']);
  const cognition = readerChange(diagnostics.sections['认知变化']);
  const linkedWorld = worldLink(diagnostics.sections['世界线作用']);
  const effectiveThinLabels = diagnostics.thinLabels.filter((label) =>
    label !== '叙事节拍' || !beat);
  return {
    ...diagnostics,
    valid: diagnostics.active && !diagnostics.missingLabels.length
      && !effectiveThinLabels.length && diagnostics.orderValid
      && diagnostics.prefixValid && !diagnostics.duplicateLabels.length
      && Boolean(beat && cognition && linkedWorld),
    thinLabels: effectiveThinLabels,
    mode: 'task', beat, cognition, worldLink: linkedWorld,
  };
}

function distinctContractItems(value, separator) {
  const items = text(value).split(separator).map((item) => item.trim())
    .filter((item) => meaningful(item));
  return [...new Set(items.map((item) => item.replace(/[\s，。！？、；;,.!?]/gu, '')))].length;
}

function continuityFingerprint(value) {
  return text(value).replace(/[\s，。！？、；;：:,.!?“”‘’（）()【】\[\]]/gu, '');
}

function exactSubstantiveRepeat(left, right, minimum = 8) {
  const a = continuityFingerprint(left);
  const b = continuityFingerprint(right);
  return a.length >= minimum && a === b;
}

export function chapterPlanContinuityDiagnostics(previousPlan, nextPlan) {
  const previous = chapterPlanContinuityLedger(previousPlan);
  const nextDesign = chapterPlanDesignDiagnostics(nextPlan);
  if (!previous || !nextDesign.active || !nextDesign.valid) {
    return { active: false, valid: true, risks: [], advisories: [], checks: {} };
  }
  const nextDecision = nextDesign.decision.sections;
  const nextKnowledge = nextDesign.knowledge.sections;
  const nextState = nextDesign.decision.stateChange;
  const risks = [];
  const advisories = [];
  const addRisk = (id, field, detail) => risks.push({ id, field, detail });
  if (previous.knowledgeMode === 'task' && nextDesign.knowledge.mode === 'task'
    && exactSubstantiveRepeat(
      previous.conclusionAlreadyKnown, nextKnowledge['允许结论'],
    )) {
    addRisk('repeated-known-conclusion', 'knowledgeDesign',
      '下一章把前章已经允许成立的结论原样再次作为新结论。');
  }
  if (previous.knowledgeMode === 'task' && nextDesign.knowledge.mode === 'task') {
    const nextEvidence = [nextKnowledge['可见依据'], nextKnowledge['交叉验证']]
      .filter(Boolean);
    if (previous.evidenceAlreadyUsed.some((prior) => nextEvidence.some((current) =>
      exactSubstantiveRepeat(prior, current)))) {
      addRisk('repeated-evidence-package', 'knowledgeDesign',
        '下一章原样重复使用前章证据组合，没有形成独立验证、失效或变义。');
    }
  }
  if (exactSubstantiveRepeat(
    previous.opponentCounteraction, nextDecision['针对性反制'],
  )) {
    addRisk('repeated-counteraction', 'decisionChain',
      '对手原样重复前章反制，没有根据人物新行动调整策略。');
  }
  if (exactSubstantiveRepeat(previous.payoffAlreadyDelivered, nextPlan?.payoff)) {
    addRisk('repeated-payoff', 'payoff', '下一章原样重复前章已经交付的兑现。');
  }
  if (exactSubstantiveRepeat(previous.hookAlreadyUsed, nextPlan?.hook)) {
    addRisk('repeated-hook', 'hook', '下一章原样重复前章已经使用的章末钩子。');
  }
  const resetsToPriorStart = exactSubstantiveRepeat(previous.startState, nextState?.before);
  const priorStateActuallyChanged = !exactSubstantiveRepeat(
    previous.startState, previous.endState,
  );
  if (resetsToPriorStart && priorStateActuallyChanged) {
    addRisk('state-reset', 'decisionChain',
      '下一章章初状态复位到前章章初，抹掉了前章已经发生的状态改写。');
  }
  const startAnchored = exactSubstantiveRepeat(previous.endState, nextState?.before);
  if (!startAnchored) advisories.push({
    id: 'state-carryover-not-explicit', field: 'decisionChain',
    detail: '下一章章初状态没有原样锚定前章章末状态；可能是合理改写，也可能遗漏连续性。',
  });
  const debtFingerprint = continuityFingerprint(previous.unresolvedDebt);
  const nextActionText = continuityFingerprint([
    nextPlan?.goal, nextPlan?.choice, nextDecision['验证/争取行动'],
    nextDecision['后续索债'],
  ].filter(Boolean).join(''));
  const debtAddressed = debtFingerprint.length >= 8
    && (nextActionText.includes(debtFingerprint) || debtFingerprint.includes(nextActionText));
  if (!debtAddressed) advisories.push({
    id: 'prior-debt-not-explicit', field: 'decisionChain',
    detail: '下一章没有原样提及前章后续索债；需要结合语义确认是否真正消费。',
  });
  const rhythmRepeated = previous.rhythmIntent && nextPlan?.rhythmIntent
    && ['pressurePattern', 'resolutionMethod', 'payoffScale', 'hookMechanism', 'costType']
      .every((field) => previous.rhythmIntent[field] === nextPlan.rhythmIntent[field]);
  if (rhythmRepeated) advisories.push({
    id: 'exact-rhythm-repeat', field: 'rhythmIntent',
    detail: '相邻两章五维节奏意图完全相同；除非后果或规模升级，否则容易形成同节拍重复。',
  });
  return {
    active: true,
    valid: risks.length === 0,
    risks,
    advisories,
    checks: {
      startAnchored, debtAddressed, rhythmRepeated,
      previousEndState: previous.endState,
      nextStartState: nextState?.before ?? '',
    },
  };
}

export function chapterPlanContinuityLedger(value = {}) {
  const design = chapterPlanDesignDiagnostics(value);
  if (!design.active || !design.valid) return null;
  const quality = chapterPlanQualityDiagnostics(value);
  const decisionSections = design.decision.sections;
  const knowledgeSections = design.knowledge.sections;
  const foreshadowSections = quality.foreshadowing.sections ?? {};
  const stateChange = design.decision.stateChange;
  return {
    startState: stateChange?.before ?? '',
    endState: stateChange?.after ?? '',
    actionAlreadyTaken: decisionSections['验证/争取行动'] ?? '',
    opponentCounteraction: decisionSections['针对性反制'] ?? '',
    unresolvedDebt: decisionSections['后续索债'] ?? '',
    knowledgeMode: design.knowledge.mode,
    questionAlreadyHandled: design.knowledge.mode === 'task'
      ? knowledgeSections['当前问题'] ?? '' : '',
    conclusionAlreadyKnown: design.knowledge.mode === 'task'
      ? knowledgeSections['允许结论'] ?? '' : '',
    evidenceAlreadyUsed: design.knowledge.mode === 'task'
      ? [knowledgeSections['可见依据'], knowledgeSections['交叉验证']]
        .filter(Boolean) : [],
    protectedUnknown: design.knowledge.mode === 'task'
      ? knowledgeSections['保留未知'] ?? '' : '',
    payoffAlreadyDelivered: typeof value.payoff === 'string' ? value.payoff : '',
    hookAlreadyUsed: typeof value.hook === 'string' ? value.hook : '',
    foreshadowingCarrierAlreadyUsed: foreshadowSections['具体载体'] ?? '',
    rhythmIntent: value.rhythmIntent && typeof value.rhythmIntent === 'object'
      ? value.rhythmIntent : null,
  };
}

export function chapterPlanDesignDiagnostics(value = {}) {
  const decision = contractDiagnostics(
    value.decisionChain, DECISION_CHAIN_CONTRACT_LABELS,
  );
  const stateChange = readerChange(decision.sections['状态改写']);
  const decisionValid = decision.valid && Boolean(stateChange);
  const source = text(value.knowledgeDesign);
  if (source.startsWith(`${KNOWLEDGE_DESIGN_NO_TASK_LABELS[0]}：`)
    || source.startsWith(`${KNOWLEDGE_DESIGN_NO_TASK_LABELS[0]}:`)) {
    const knowledge = contractDiagnostics(source, KNOWLEDGE_DESIGN_NO_TASK_LABELS);
    return {
      active: decision.active || knowledge.active,
      valid: decisionValid && knowledge.valid,
      decision: { ...decision, valid: decisionValid, stateChange },
      knowledge: { ...knowledge, mode: 'none' },
    };
  }
  const knowledge = contractDiagnostics(source, KNOWLEDGE_DESIGN_CONTRACT_LABELS);
  const alternativeCount = distinctContractItems(
    knowledge.sections['替代解释'], /\s*(?:｜|\||；|;)\s*/u,
  );
  const crossValidationCount = distinctContractItems(
    knowledge.sections['交叉验证'], /\s*(?:＋|\+)\s*/u,
  );
  const knowledgeValid = knowledge.valid && alternativeCount >= 2
    && crossValidationCount >= 2
    && text(knowledge.sections['允许结论']) !== text(knowledge.sections['保留未知']);
  return {
    active: decision.active || knowledge.active,
    valid: decisionValid && knowledgeValid,
    decision: { ...decision, valid: decisionValid, stateChange },
    knowledge: {
      ...knowledge, valid: knowledgeValid, mode: 'task',
      alternativeCount, crossValidationCount,
    },
  };
}

export function chapterPlanQualityDiagnostics(value = {}) {
  const protocolVersion = value.qualityProtocolVersion === 3
    ? 3 : value.qualityProtocolVersion === 2 ? 2 : 1;
  const tension = tensionDiagnostics(value.tensionArc, protocolVersion);
  const foreshadowing = foreshadowingDiagnostics(value.foreshadowing, protocolVersion);
  const worldExpansion = contractDiagnostics(
    value.worldExpansion, protocolVersion >= 2
      ? WORLD_EXPANSION_CONTRACT_LABELS : WORLD_EXPANSION_CONTRACT_LABELS_V1,
  );
  const active = tension.active || foreshadowing.active || worldExpansion.active;
  return {
    protocolVersion,
    active,
    valid: active && tension.valid && foreshadowing.valid && worldExpansion.valid,
    tension,
    foreshadowing,
    worldExpansion,
  };
}

export function chapterPlanForeshadowingNarrativeContract(value = {}) {
  const diagnostics = chapterPlanQualityDiagnostics(value).foreshadowing;
  if (diagnostics.mode !== 'task' || !diagnostics.valid || !diagnostics.beat
    || !diagnostics.cognition || !diagnostics.worldLink) return null;
  return {
    beat: diagnostics.beat,
    readerBefore: diagnostics.cognition.before,
    readerAfter: diagnostics.cognition.after,
    actionConsequence: diagnostics.sections['行动影响'],
    worldLink: diagnostics.worldLink,
    worldEffect: diagnostics.sections['世界线作用'],
  };
}

export function chapterPlanWorldLinkAlignment(value = {}, sectionOutline = '') {
  const narrative = chapterPlanForeshadowingNarrativeContract(value);
  if (!narrative || narrative.worldLink !== 'support-gate') {
    return { required: false, valid: true, gateCondition: '' };
  }
  const section = sectionWorldContract(sectionOutline);
  return {
    required: true,
    valid: Boolean(section?.gateCondition
      && narrative.worldEffect.includes(section.gateCondition)),
    gateCondition: section?.gateCondition ?? '',
  };
}
