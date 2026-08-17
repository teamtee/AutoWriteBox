import crypto from 'node:crypto';

import {
  CHAPTER_EXECUTION_CHECKLIST, CONTEXT_LAYER_GUIDANCE,
} from './prompts.js';
import { CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE } from './chapter-plan-quality.js';
import { chapterOutputLeakDiagnostics } from './chapter-output-guard.js';

const META_PATTERN = /上一章|下一章|第\s*\d+\s*章|读者|作者|策划|伏笔|正文候选/u;

export const API_EDITORIAL_REVIEW_CHECK_IDS = Object.freeze([
  'opening', 'characterAgency', 'sceneCausality', 'payoff', 'tensionDynamics',
  'foreshadowLayers', 'worldScale', 'continuity', 'proseHumanity', 'endingPull',
]);

export function apiEditorialFingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function apiEditorialDraftMetrics(draft, spec) {
  const paragraphs = draft.split(/\n\s*\n/u).map((row) => row.trim()).filter(Boolean);
  const shortParagraphs = paragraphs.filter(
    (row) => row.replace(/\s/gu, '').length <= 12,
  ).length;
  const nonWhitespaceCharacters = draft.replace(/\s/gu, '').length;
  const problems = [];
  if (nonWhitespaceCharacters < spec.minCharacters) problems.push('正文低于最小字符数');
  if (nonWhitespaceCharacters > spec.maxCharacters) problems.push('正文超过最大字符数');
  if (/```|^#{1,6}\s/mu.test(draft)) problems.push('正文混入 Markdown 标记');
  if (META_PATTERN.test(draft)) problems.push('正文混入创作侧元话语');
  if (!chapterOutputLeakDiagnostics(draft).valid) problems.push('正文混入编辑后台标记');
  const shortParagraphRatio = paragraphs.length ? shortParagraphs / paragraphs.length : 0;
  const aiStyleSignals = {
    contrastFormulaCount: (draft.match(/(?:不是|并非)[^。！？\n]{0,30}(?:而是|只是)/gu) ?? []).length,
    simileMarkerCount: (draft.match(/仿佛|像是|如同|宛如/gu) ?? []).length,
    emDashCount: (draft.match(/——/gu) ?? []).length,
  };
  if (shortParagraphRatio > spec.maxShortParagraphRatio) problems.push('短段比例过高');
  return {
    nonWhitespaceCharacters,
    paragraphs: paragraphs.length,
    shortParagraphs,
    shortParagraphRatio,
    aiStyleSignals,
    bodyFingerprint: apiEditorialFingerprint(draft),
    deterministicGatePassed: problems.length === 0,
    deterministicProblems: problems,
  };
}

export function extractApiEditorialJson(raw) {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('API 审稿没有返回 JSON 对象');
  return JSON.parse(trimmed.slice(first, last + 1));
}

export function validateApiEditorialReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('API 审稿结构无效');
  }
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
    throw new Error('API 审稿缺少有效 score');
  }
  if (!value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) {
    throw new Error('API 审稿缺少 checks');
  }
  if (!Array.isArray(value.rewriteInstructions)) {
    throw new Error('API 审稿缺少 rewriteInstructions');
  }
  for (const id of API_EDITORIAL_REVIEW_CHECK_IDS) {
    const check = value.checks[id];
    if (!check || typeof check !== 'object' || Array.isArray(check)
      || typeof check.pass !== 'boolean'
      || typeof check.evidence !== 'string' || !check.evidence.trim()
      || typeof check.issue !== 'string') {
      throw new Error(`API 审稿检查项无效：${id}`);
    }
  }
  const failedCheckIds = API_EDITORIAL_REVIEW_CHECK_IDS.filter(
    (id) => value.checks[id].pass !== true,
  );
  const rewriteInstructions = value.rewriteInstructions
    .filter((row) => typeof row === 'string' && row.trim())
    .slice(0, 6);
  const mustRewrite = value.mustRewrite === true || failedCheckIds.length > 0;
  if (mustRewrite && rewriteInstructions.length < 1) {
    throw new Error('API 审稿要求返修但没有定向 rewriteInstructions');
  }
  return {
    ...value,
    score: Math.round(value.score),
    mustRewrite,
    failedCheckIds,
    rewriteInstructions,
  };
}

function failedCheckCount(review) {
  if (Array.isArray(review?.failedCheckIds)) return review.failedCheckIds.length;
  return API_EDITORIAL_REVIEW_CHECK_IDS.filter(
    (id) => review?.checks?.[id]?.pass !== true,
  ).length;
}

function deterministicProblemCount(metrics) {
  return Array.isArray(metrics?.deterministicProblems)
    ? metrics.deterministicProblems.length : Number.MAX_SAFE_INTEGER;
}

function aiStyleSignalCount(metrics) {
  if (!metrics?.aiStyleSignals || typeof metrics.aiStyleSignals !== 'object') {
    return Number.MAX_SAFE_INTEGER;
  }
  return Object.values(metrics.aiStyleSignals).reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0), 0,
  );
}

function compareApiEditorialCandidates(left, right) {
  const leftGate = left?.metrics?.deterministicGatePassed === true ? 1 : 0;
  const rightGate = right?.metrics?.deterministicGatePassed === true ? 1 : 0;
  if (leftGate !== rightGate) return rightGate - leftGate;
  const failedDifference = failedCheckCount(left?.review) - failedCheckCount(right?.review);
  if (failedDifference) return failedDifference;
  const rewriteDifference = Number(left?.review?.mustRewrite === true)
    - Number(right?.review?.mustRewrite === true);
  if (rewriteDifference) return rewriteDifference;
  const problemDifference = deterministicProblemCount(left?.metrics)
    - deterministicProblemCount(right?.metrics);
  if (problemDifference) return problemDifference;
  const scoreDifference = (right?.review?.score ?? -1) - (left?.review?.score ?? -1);
  if (scoreDifference) return scoreDifference;
  const styleDifference = aiStyleSignalCount(left?.metrics)
    - aiStyleSignalCount(right?.metrics);
  if (styleDifference) return styleDifference;
  return (left?.iteration ?? Number.MAX_SAFE_INTEGER)
    - (right?.iteration ?? Number.MAX_SAFE_INTEGER);
}

export function selectBestApiEditorialCandidate(candidates = []) {
  if (!Array.isArray(candidates)) return null;
  return candidates.filter((candidate) => candidate?.metrics && candidate?.review)
    .sort(compareApiEditorialCandidates)[0] ?? null;
}

export function apiEditorialCandidatePasses(candidate, spec) {
  return Boolean(candidate?.metrics?.deterministicGatePassed
    && candidate?.review?.mustRewrite !== true
    && Number.isFinite(candidate?.review?.score)
    && candidate.review.score >= spec.minimumReviewScore);
}

export function buildApiEditorialWriterInstruction({
  spec, brief, plan, previousChapter, contextEntries,
}) {
  return [
    `请创作《${spec.bookTitle}》第${spec.chapterIndex}章《${spec.chapterTitle}》正文。`,
    '',
    '输出边界：',
    '- 只输出正文，不输出章名、说明、JSON、Markdown或创作分析。',
    `- ${spec.minCharacters}—${spec.maxCharacters}个非空白字符。`,
    `- 12字以内短段不超过全部段落的${Math.round(spec.maxShortParagraphRatio * 100)}%。`,
    '- 关键世界观只能通过物证、信息差、人物行动和后果逐层露出，禁止百科式揭秘。',
    '- 不得使用“上一章、下一章、读者、作者、策划、伏笔”等元话语。',
    '- 输出前静默核对姓名、数字、时间、地点、知识边界与已发生结果。',
    '- 执行章级张力曲线，但不要把箭头、层级、策划字段名或主编术语写进正文。',
    '- 场景不能并列复位：第一场承接前情或直接诱因，后续场必须消费前场造成的新资源、关系、认知、风险或目标。',
    '',
    CONTEXT_LAYER_GUIDANCE,
    CHAPTER_EXECUTION_CHECKLIST,
    plan?.qualityProtocolVersion >= 1 ? CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE : '',
    '',
    '主编创作任务书：', brief,
    '',
    '章级因果约束（不要逐项复述）：', JSON.stringify(plan, null, 2),
    '',
    '作者编辑参考（用于方向与阅读债务，不得冒充已发生事实）：',
    contextEntries.map((entry) => `【${entry.path}】\n${entry.text}`).join('\n\n'),
    '',
    '紧接的前一章全文：', previousChapter,
  ].join('\n');
}

export function buildApiEditorialReviewerInstruction({
  spec, brief, plan, previousChapter, draft, metrics,
}) {
  const noForeshadowingTask = /^无埋点理由\s*[:：]/u.test(
    typeof plan?.foreshadowing === 'string' ? plan.foreshadowing.trim() : '',
  );
  return [
    `你是《${spec.bookTitle}》的长篇网文主编。审查第${spec.chapterIndex}章 API 初稿。`,
    '不要续写，不要礼貌性表扬。必须根据正文给出可执行返修意见。',
    '重点判断：开场进入速度、人物主动性、场景因果、阶段兑现、张力变化、章末追读力、埋点层次、宏观世界扩张、连续性、人物语言差异、短段碎裂和模板化 AI 表达。',
    '张力不能只看事故数量或情绪音量：检查压力是否因行动与后果至少发生两次变化，是否有希望/小胜、受阻/反制、关键选择、兑现或余波。',
    'sceneCausality 必须执行删除测试：若删掉前一场，后一场仍能原样发生，或只靠换地点/陌生人闯入连接，就是并列拼盘；有效转折必须改变资源、关系、认知、风险或目标。',
    noForeshadowingTask
      ? '本章策划明确无埋点任务：检查正文是否聚焦指定行动/关系/兑现，且没有硬造线索、假装推进或提前揭示既有未知；不得仅因没有新谜团扣分。'
      : '埋点只检查策划实际选择的回收、推进或建立任务；每项都应有正文证据，不要求一章机械覆盖近中长三层。',
    '宏大世界观不能靠名词数量评分，只看本章是否让世界边界变大且保留可追溯的信息缺口。',
    plan?.qualityProtocolVersion >= 1 ? CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE : '',
    '返回严格 JSON，不要代码围栏：',
    '{"score":0,"verdict":"不超过40字","mustRewrite":true,"checks":{"opening":{"pass":false,"evidence":"","issue":""},"characterAgency":{"pass":false,"evidence":"","issue":""},"sceneCausality":{"pass":false,"evidence":"","issue":""},"payoff":{"pass":false,"evidence":"","issue":""},"tensionDynamics":{"pass":false,"evidence":"","issue":""},"foreshadowLayers":{"pass":false,"evidence":"","issue":""},"worldScale":{"pass":false,"evidence":"","issue":""},"continuity":{"pass":false,"evidence":"","issue":""},"proseHumanity":{"pass":false,"evidence":"","issue":""},"endingPull":{"pass":false,"evidence":"","issue":""}},"rewriteInstructions":["最多6条，指出位置、保留项和具体改法"]}',
    '',
    `确定性检查：${JSON.stringify(metrics)}`,
    '',
    '主编任务书：', brief,
    '',
    '章级因果约束：', JSON.stringify(plan, null, 2),
    '',
    '前一章结尾参考：', previousChapter.slice(-1800),
    '',
    '待审正文：', draft,
  ].join('\n');
}

export function buildApiEditorialRewriteInstruction({
  spec, brief, plan, previousChapter, draft, review, metrics,
}) {
  return [
    `请重写《${spec.bookTitle}》第${spec.chapterIndex}章《${spec.chapterTitle}》。`,
    '只输出完整重写正文，不输出章名、解释、修改说明或 Markdown。',
    '保留审稿明确认可的有效场景、人物选择和埋点；只围绕证据明确的薄弱项修改。',
    `正文保持${spec.minCharacters}—${spec.maxCharacters}个非空白字符，短段比例不超过${Math.round(spec.maxShortParagraphRatio * 100)}%。`,
    '当前底稿是历次 API 候选中的最优版；禁止以修复一项为代价破坏已通过的开场、人物选择、场景因果、兑现、埋点或章末牵引。',
    '不得把全章翻新成另一套情节；审稿未指出风险的事件结果、人物决定和信息边界必须保留。',
    '不得为了回应审稿而让人物说出主题、解释埋点或堆叠新设定。',
    plan?.qualityProtocolVersion >= 1 ? CHAPTER_PLAN_QUALITY_EXECUTION_GUIDANCE : '',
    '',
    '主编任务书：', brief,
    '',
    '章级因果约束：', JSON.stringify(plan, null, 2),
    '',
    '确定性问题：', JSON.stringify(metrics.deterministicProblems),
    '',
    'API 主编审稿：', JSON.stringify(review, null, 2),
    '',
    '前一章结尾参考：', previousChapter.slice(-1800),
    '',
    '待重写正文：', draft,
  ].join('\n');
}
