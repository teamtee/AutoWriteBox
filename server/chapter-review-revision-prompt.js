import { createHash } from 'node:crypto';
import { boundedJoin } from './prompt-join.js';
import { CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE } from './chapter-plan-quality.js';

const NON_AUTOMATIC_CHECKS = new Set(['contentRisk']);

function reviewChecks(review, status) {
  return Array.isArray(review?.webFictionChecks)
    ? review.webFictionChecks.filter((item) => item?.status === status
      && !NON_AUTOMATIC_CHECKS.has(item.id))
    : [];
}

function unresolvedPlanItems(review) {
  return Array.isArray(review?.planComparison?.items)
    ? review.planComparison.items.filter((item) =>
      item?.outcome === 'missed' || item?.outcome === 'unclear')
    : [];
}

export function chapterReviewRevision(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return '';
  return createHash('sha256').update(JSON.stringify(review)).digest('base64url');
}

export function chapterReviewRevisionTargets(review) {
  if (!review || typeof review !== 'object') return null;
  const risks = reviewChecks(review, 'risk');
  const protectedChecks = reviewChecks(review, 'pass');
  const planItems = unresolvedPlanItems(review);
  const contentRisk = Array.isArray(review?.webFictionChecks)
    && review.webFictionChecks.some((item) =>
      item?.id === 'contentRisk' && item.status === 'risk');
  // issues / suggestions 没有类型归属。若 contentRisk 有风险，宁可只使用已经
  // 分型的正文检查，避免把合规提示误当成授权写作模型删改内容。
  const issues = contentRisk ? [] : Array.isArray(review.issues) ? review.issues : [];
  const suggestions = contentRisk
    ? [] : Array.isArray(review.suggestions) ? review.suggestions : [];
  // 审稿协议固定会给若干 issues / suggestions；它们不能单独触发无限润色。
  // 只有正式风险项或未落地策划存在时，才允许让写作模型再改一轮。
  if (!risks.length && !planItems.length) return null;
  return {
    verdict: review.verdict,
    risks,
    protectedChecks,
    planItems,
    issues,
    suggestions,
  };
}

export const CHAPTER_REVIEW_REVISION_SYSTEM_APPENDIX = [
  '\n你现在根据已经完成的证据审稿生成“定向精修候选”。',
  '审稿是编辑诊断，不是新的故事事实；若审稿意见与已发生事实、作者策划或人物知识边界冲突，以事实和策划为准。',
  '候选不会自动保存，作者会通读后决定是否放入正文草稿。',
  '任何 promise_ 开头的债务 ID、策划合同标签、qualityProtocolVersion、designProtocolVersion、审稿 JSON 字段都属于编辑后台信息，绝不能写进正文候选。',
].join('');

export function buildChapterReviewRevisionInstruction({
  chapterIndex, bookChapterIndex = chapterIndex, context, content, review, chapterPlan,
}) {
  const targets = chapterReviewRevisionTargets(review);
  if (!targets) throw new Error('CHAPTER_REVIEW_HAS_NO_REVISIONS');
  return boundedJoin([
    `请根据当前有效审稿，对全书第 ${bookChapterIndex} 章（当前分部第 ${chapterIndex} 章）生成一次定向精修候选。\n`,
    '只输出完整章节正文，不要标题、修改说明、Markdown、代码围栏或前后解释。\n\n',
    '【修改原则】\n',
    '1. 只修复下方“风险项、未落地策划、主要问题和编辑建议”中有正文证据的问题；不要自由重写整章。\n',
    '2. 保留事件顺序与结果、人物决定、关系状态、姓名身份、数量、时间地点、能力/物品/知识边界、已埋线索和章末因果。\n',
    '3. “已通过保护项”中的正文证据原句是确定性保护锚点，候选必须逐字保留；若同一句又被风险项明确引用，则只允许最小改写该冲突句，其余通过证据仍须逐字保留。\n',
    '4. 不得用新增事故、陌生援手、万能能力、长篇解释、突然揭密、强行金句或提高情绪音量伪装修复。\n',
    '5. 场景断链时，优先让后一场消费前一场已经存在的转折或代价；张力平直时，优先改变已有行动的后果与人物选择压力，不另造无关事件。\n',
    '6. 去 AI 味必须落实到具体句段：减少同构短段、总结主题、模板转折、密集排比/比喻和人物同声；不要把文字洗成干瘪流水账。\n',
    '7. contentRisk 属于作者另行核对的内容与平台风险，不在本次自动精修中擅自删改。\n\n',
    '【当前有效审稿诊断（不是故事事实）】\n', JSON.stringify(targets), '\n\n',
    chapterPlan && typeof chapterPlan === 'object' ? boundedJoin([
      '【当前作者策划（未来意图，不是已发生事实）】\n', JSON.stringify(chapterPlan), '\n',
      chapterPlan.qualityProtocolVersion >= 1
        ? CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE : '', '\n',
    ]) : '',
    '【作品与连续性上下文】\n', context || '（无额外上下文）', '\n\n',
    '【当前完整正文】\n', content,
  ]);
}
