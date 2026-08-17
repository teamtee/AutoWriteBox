import {
  MAX_CHAPTER_PLAN_SCENES, MAX_PLAN_CARRYOVER_REASON_CHARS,
  MAX_PLAN_CARRYOVER_TEXT_CHARS, MAX_PLAN_COMPARISON_EVIDENCE_CHARS,
  MAX_PLAN_COMPARISON_SUMMARY_CHARS,
} from './limits.js';
import {
  CHAPTER_PLAN_FIELDS, chapterPlanRevision, normalizeChapterPlan,
} from './chapter-plan-schema.js';

export const CHAPTER_PLAN_OUTCOMES = Object.freeze([
  'fulfilled', 'adapted', 'missed', 'unclear',
]);
export const CHAPTER_PLAN_COMPARISON_OVERALL = Object.freeze([
  'aligned', 'adapted', 'partial', 'diverged', 'na',
]);
export const CHAPTER_PLAN_CARRYOVER_FIELDS = Object.freeze([
  'goal', 'obstacle', 'choice', 'payoff', 'hook',
  'tensionArc', 'foreshadowing', 'worldExpansion',
  'decisionChain', 'knowledgeDesign', 'notes',
]);

const FIELD_LABELS = Object.freeze({
  goal: '本章目标', obstacle: '主要阻碍', choice: '关键选择',
  payoff: '兑现 / 爽点', hook: '章末钩子',
  tensionArc: '张力曲线', foreshadowing: '分层埋点',
  worldExpansion: '世界边界扩张', decisionChain: '决策因果链',
  knowledgeDesign: '认知与证据边界', notes: '补充约束',
  rhythmIntent: '写前节奏意图',
});
const OUTCOME_SET = new Set(CHAPTER_PLAN_OUTCOMES);
const OVERALL_SET = new Set(CHAPTER_PLAN_COMPARISON_OVERALL);
const CARRYOVER_FIELD_SET = new Set(CHAPTER_PLAN_CARRYOVER_FIELDS);
const TARGET_PATTERN = new RegExp(
  `^(?:${CHAPTER_PLAN_FIELDS.join('|')}|rhythmIntent|scene-(?:[1-9]|1[0-${MAX_CHAPTER_PLAN_SCENES - 10}]))$`,
  'u',
);

function cleanText(value, maxLength, truncate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length > maxLength && !truncate) return null;
  return chars.slice(0, maxLength).join('');
}

export function chapterPlanReviewTargets(value) {
  const plan = normalizeChapterPlan(value);
  const targets = CHAPTER_PLAN_FIELDS.flatMap((field) => plan[field]
    ? [{ target: field, label: FIELD_LABELS[field], planned: plan[field] }]
    : []);
  if (plan.rhythmIntentVersion === 1) {
    targets.push({
      target: 'rhythmIntent', label: FIELD_LABELS.rhythmIntent,
      planned: JSON.stringify(plan.rhythmIntent),
    });
  }
  plan.scenes.forEach((scene, index) => {
    const details = [
      scene.trigger && `承接触发=${scene.trigger}`,
      scene.desire && `欲望=${scene.desire}`,
      scene.obstacle && `阻碍=${scene.obstacle}`,
      scene.action && `行动=${scene.action}`,
      scene.turn && `转折=${scene.turn}`,
      scene.cost && `代价=${scene.cost}`,
    ].filter(Boolean).join('；');
    if (scene.title || details) {
      targets.push({
        target: `scene-${index + 1}`,
        label: `场景 ${index + 1}${scene.title ? ` · ${scene.title}` : ''}`,
        planned: details || scene.title,
      });
    }
  });
  return targets;
}

export function normalizeChapterPlanComparison(value, {
  truncate = false, chapterPlan, requireForPlanned = false,
} = {}) {
  const targets = chapterPlan === undefined ? null : chapterPlanReviewTargets(chapterPlan);
  if (value === undefined) {
    return requireForPlanned && targets?.length ? null : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !OVERALL_SET.has(value.overall)) return null;
  const summary = cleanText(
    value.summary, MAX_PLAN_COMPARISON_SUMMARY_CHARS, truncate,
  );
  if (!summary || !Array.isArray(value.items) || !Array.isArray(value.carryovers)) return null;
  if (value.items.length > CHAPTER_PLAN_FIELDS.length + MAX_CHAPTER_PLAN_SCENES + 1
    || value.carryovers.length > CHAPTER_PLAN_FIELDS.length + MAX_CHAPTER_PLAN_SCENES + 1) {
    return null;
  }

  const byTarget = new Map();
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.target !== 'string' || !TARGET_PATTERN.test(item.target)
      || !OUTCOME_SET.has(item.outcome) || byTarget.has(item.target)) return null;
    const evidence = cleanText(
      item.evidence, MAX_PLAN_COMPARISON_EVIDENCE_CHARS, truncate,
    );
    if (!evidence) return null;
    byTarget.set(item.target, { target: item.target, outcome: item.outcome, evidence });
  }

  const carryovers = [];
  const carryoverTargets = new Set();
  for (const item of value.carryovers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.sourceTarget !== 'string' || !TARGET_PATTERN.test(item.sourceTarget)
      || item.sourceTarget === 'rhythmIntent'
      || carryoverTargets.has(item.sourceTarget)
      || !CARRYOVER_FIELD_SET.has(item.suggestedField)) return null;
    const source = byTarget.get(item.sourceTarget);
    if (!source || source.outcome === 'fulfilled') return null;
    const text = cleanText(item.text, MAX_PLAN_CARRYOVER_TEXT_CHARS, truncate);
    const reason = cleanText(item.reason, MAX_PLAN_CARRYOVER_REASON_CHARS, truncate);
    if (!text || !reason) return null;
    carryoverTargets.add(item.sourceTarget);
    carryovers.push({
      sourceTarget: item.sourceTarget, text, reason, suggestedField: item.suggestedField,
    });
  }

  if (value.overall === 'na' && (byTarget.size || carryovers.length)) return null;
  if (value.overall !== 'na' && !byTarget.size) return null;
  if (targets) {
    const expected = new Set(targets.map((item) => item.target));
    if (!expected.size) {
      if (value.overall !== 'na' || byTarget.size || carryovers.length) return null;
    } else if (value.overall === 'na' || expected.size !== byTarget.size
      || [...expected].some((target) => !byTarget.has(target))) return null;
  }
  return { overall: value.overall, summary, items: [...byTarget.values()], carryovers };
}

export function incomingChapterPlanCarryover(chapter, {
  sourceChapterId = chapter?.id, sourceChapterTitle = chapter?.title,
} = {}) {
  const review = chapter?.review;
  if (!review || review.sourceFingerprint !== chapter?.bodyFingerprint
    || review.sourcePlanRevision !== chapterPlanRevision(chapter?.plan)) return null;
  const comparison = normalizeChapterPlanComparison(review.planComparison, {
    chapterPlan: chapter?.plan,
  });
  if (!comparison?.carryovers.length) return null;
  return {
    sourceChapterId,
    sourceChapterTitle: typeof sourceChapterTitle === 'string' ? sourceChapterTitle : '',
    sourceBodyFingerprint: review.sourceFingerprint,
    sourcePlanRevision: review.sourcePlanRevision,
    summary: comparison.summary,
    items: comparison.carryovers,
  };
}
