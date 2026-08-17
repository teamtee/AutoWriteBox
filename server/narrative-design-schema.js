import { MAX_CHAPTER_PLAN_FIELD_CHARS } from './limits.js';

export const NARRATIVE_DESIGN_PROTOCOL_VERSION = 1;
export const NARRATIVE_CHAPTER_FUNCTIONS = Object.freeze([
  'investigation', 'confrontation', 'action', 'relationship',
  'aftermath', 'setup', 'payoff', 'transition',
]);
const FUNCTION_SET = new Set(NARRATIVE_CHAPTER_FUNCTIONS);
const PLACEHOLDER = /^(?:待定|待补充|待完善|待确认|暂无|无|不知道|进一步明确)[。！!？?]?$/u;

function clean(value, max = MAX_CHAPTER_PLAN_FIELD_CHARS) {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, max).join('');
}

function meaningful(value, minimum = 4) {
  const text = clean(value);
  return Array.from(text).length >= minimum && !PLACEHOLDER.test(text);
}

function cleanList(value, maxItems = 4, maxChars = 240) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item, maxChars)).filter((item) => meaningful(item))
    .filter((item, index, rows) => rows.indexOf(item) === index)
    .slice(0, maxItems);
}

export function normalizeNarrativeDesign(value, {
  errorCode = 'BAD_NARRATIVE_DESIGN',
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.designProtocolVersion !== NARRATIVE_DESIGN_PROTOCOL_VERSION
    || !FUNCTION_SET.has(value.chapterFunction)) throw new Error(errorCode);
  const rawDecision = value.decision;
  if (!rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) {
    throw new Error(errorCode);
  }
  const decision = {
    currentBelief: clean(rawDecision.currentBelief, 200),
    action: clean(rawDecision.action, 240),
    harmedStakeholder: clean(rawDecision.harmedStakeholder, 200),
    counteraction: clean(rawDecision.counteraction, 240),
    responseChoice: clean(rawDecision.responseChoice, 240),
    stateBefore: clean(rawDecision.stateBefore, 200),
    stateAfter: clean(rawDecision.stateAfter, 200),
    nextDebt: clean(rawDecision.nextDebt, 200),
  };
  if (Object.values(decision).some((entry) => !meaningful(entry))) {
    throw new Error(errorCode);
  }
  const rawKnowledge = value.knowledge;
  if (!rawKnowledge || typeof rawKnowledge !== 'object' || Array.isArray(rawKnowledge)
    || !['task', 'none'].includes(rawKnowledge.mode)) throw new Error(errorCode);
  let knowledge;
  if (rawKnowledge.mode === 'none') {
    knowledge = {
      mode: 'none',
      noTaskReason: clean(rawKnowledge.noTaskReason, 120),
      focus: clean(rawKnowledge.focus, 120),
      existingJudgment: clean(rawKnowledge.existingJudgment, 120),
    };
    if ([knowledge.noTaskReason, knowledge.focus, knowledge.existingJudgment]
      .some((entry) => !meaningful(entry))) throw new Error(errorCode);
  } else {
    knowledge = {
      mode: 'task',
      question: clean(rawKnowledge.question, 45),
      visibleEvidence: clean(rawKnowledge.visibleEvidence, 75),
      allowedConclusion: clean(rawKnowledge.allowedConclusion, 55),
      alternatives: cleanList(rawKnowledge.alternatives, 4, 45),
      crossValidation: cleanList(rawKnowledge.crossValidation, 4, 45),
      protectedUnknown: clean(rawKnowledge.protectedUnknown, 50),
    };
    if ([knowledge.question, knowledge.visibleEvidence, knowledge.allowedConclusion,
      knowledge.protectedUnknown].some((entry) => !meaningful(entry))
      || knowledge.alternatives.length < 2 || knowledge.crossValidation.length < 2) {
      throw new Error(errorCode);
    }
  }
  return {
    designProtocolVersion: NARRATIVE_DESIGN_PROTOCOL_VERSION,
    chapterFunction: value.chapterFunction,
    decision,
    knowledge,
  };
}

function fit(value, max) {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  const prefix = chars.slice(0, max).join('');
  const boundary = Math.max(
    prefix.lastIndexOf('。'), prefix.lastIndexOf('；'),
    prefix.lastIndexOf('，'), prefix.lastIndexOf(','),
  );
  return boundary >= Math.floor(max * 0.55) ? prefix.slice(0, boundary) : prefix;
}

export function narrativeDesignPlanFields(value) {
  const design = normalizeNarrativeDesign(value);
  const decisionChain = [
    `当前误判/未决：${fit(design.decision.currentBelief, 45)}`,
    `验证/争取行动：初次行动：${fit(design.decision.action, 52)}；反制后选择：${fit(design.decision.responseChoice, 52)}`,
    `利益受损者：${fit(design.decision.harmedStakeholder, 45)}`,
    `针对性反制：${fit(design.decision.counteraction, 62)}`,
    `状态改写：${fit(design.decision.stateBefore, 42)}→${fit(design.decision.stateAfter, 42)}`,
    `后续索债：${fit(design.decision.nextDebt, 50)}`,
  ].join('；');
  const knowledgeDesign = design.knowledge.mode === 'none'
    ? [
      `无认知任务理由：${design.knowledge.noTaskReason}`,
      `本章聚焦：${design.knowledge.focus}`,
      `既有判断处理：${design.knowledge.existingJudgment}`,
    ].join('；')
    : [
      `当前问题：${design.knowledge.question}`,
      `可见依据：${design.knowledge.visibleEvidence}`,
      `允许结论：${design.knowledge.allowedConclusion}`,
      `替代解释：${design.knowledge.alternatives.join('｜')}`,
      `交叉验证：${design.knowledge.crossValidation.join('＋')}`,
      `保留未知：${design.knowledge.protectedUnknown}`,
    ].join('；');
  return {
    designProtocolVersion: NARRATIVE_DESIGN_PROTOCOL_VERSION,
    decisionChain,
    knowledgeDesign,
    chapterFunction: design.chapterFunction,
  };
}
