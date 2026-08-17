import { MAX_VERSION_TEXT_CHARS } from './limits.js';
import { chapterOutputLeakDiagnostics } from './chapter-output-guard.js';

const AI_STYLE_PATTERNS = Object.freeze({
  contrastFormula: /(?:不是|并非)[^。！？\n]{0,30}(?:而是|只是)/gu,
  simileMarker: /仿佛|像是|如同|宛如/gu,
  emDash: /——/gu,
  authorVerdict: /(?:这让[他她]|现在[他她]知道了|[他她](?:意识到|明白了))[^。！？\n]{0,50}[。！？]?/gu,
  sceneSummaryShell: /(?:进行了一番(?:激烈的|长时间的)?(?:争论|讨论|交涉|战斗)|进行了(?:激烈的|长时间的)(?:争论|讨论|交涉|战斗)|经过一番(?:争论|讨论|交涉|战斗|搏斗)|(?:双方|众人)(?:展开了?|进行了一番|进行了)(?:激烈的|长时间的)?(?:争论|讨论|交涉|战斗)|最终(?:达成一致|解决了争端|决定了去向))[^。！？\n]{0,40}[。！？]?/gu,
});

function countMatches(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function stripQuotedSpeech(text) {
  if (!/[“「『]/u.test(text)) return text;
  const closingByOpening = new Map([['“', '”'], ['「', '」'], ['『', '』']]);
  const stack = [];
  const chunks = [];
  let narrativeStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const closing = closingByOpening.get(char);
    if (closing) {
      if (!stack.length && index > narrativeStart) chunks.push(text.slice(narrativeStart, index));
      stack.push(closing);
      continue;
    }
    if (stack.length && char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) narrativeStart = index + 1;
    }
  }
  if (!stack.length && narrativeStart < text.length) chunks.push(text.slice(narrativeStart));
  return chunks.join('');
}

function repeatedPhraseClusters(text) {
  const segments = text.split(/[\s。！？？，、；：“”‘’（）《》——]+/u)
    .map((segment) => segment.trim()).filter((segment) => segment.length >= 10);
  const segmentStride = segments.length + 1;
  // value = count * segmentStride + lastSegment。一个短语每个句段最多计一次，
  // 只有跨至少三个不同句段复现才算成片，避免单段规律串或单句口吃放大指标。
  const states = new Map();
  segments.forEach((segment, segmentIndex) => {
    const seenInSegment = new Set();
    for (let index = 0; index + 10 <= segment.length; index += 1) {
      seenInSegment.add(segment.slice(index, index + 10));
    }
    for (const phrase of seenInSegment) {
      const encoded = states.get(phrase);
      if (encoded === undefined) {
        states.set(phrase, segmentStride + segmentIndex);
        continue;
      }
      const count = Math.floor(encoded / segmentStride);
      states.set(phrase, (count + 1) * segmentStride + segmentIndex);
    }
  });
  let repeatedPhraseClusterCount = 0;
  let repeatedPhraseExcessCount = 0;
  for (const encoded of states.values()) {
    const count = Math.floor(encoded / segmentStride);
    if (count >= 3) {
      repeatedPhraseClusterCount += 1;
      repeatedPhraseExcessCount += count - 2;
    }
  }
  return { repeatedPhraseClusterCount, repeatedPhraseExcessCount };
}

export function chapterRevisionStyleMetrics(text) {
  const source = typeof text === 'string' ? text : '';
  const narrativeOnly = stripQuotedSpeech(source);
  const paragraphs = source.split(/\n\s*\n/u).map((row) => row.trim()).filter(Boolean);
  const shortFlags = paragraphs.map((row) => row.replace(/\s/gu, '').length <= 12);
  const shortParagraphs = shortFlags.filter(Boolean).length;
  let maxConsecutiveShortParagraphs = 0;
  let currentShortRun = 0;
  for (const isShort of shortFlags) {
    currentShortRun = isShort ? currentShortRun + 1 : 0;
    maxConsecutiveShortParagraphs = Math.max(maxConsecutiveShortParagraphs, currentShortRun);
  }
  const clusteredShortParagraphs = shortFlags.filter((isShort, index) => isShort
    && (shortFlags[index - 1] || shortFlags[index + 1])).length;
  const paragraphLengths = paragraphs.map((row) => row.replace(/\s/gu, '').length);
  let maxConsecutiveSimilarParagraphs = 0;
  let currentSimilarRun = 0;
  paragraphLengths.forEach((length, index) => {
    const previous = paragraphLengths[index - 1];
    const similar = index > 0
      && Math.abs(length - previous) <= Math.max(8, Math.min(length, previous) * 0.2);
    currentSimilarRun = similar ? currentSimilarRun + 1 : 1;
    maxConsecutiveSimilarParagraphs = Math.max(
      maxConsecutiveSimilarParagraphs, currentSimilarRun,
    );
  });
  const simileMarkerCount = countMatches(source, AI_STYLE_PATTERNS.simileMarker);
  const simileParagraphs = paragraphs.filter(
    (row) => countMatches(row, AI_STYLE_PATTERNS.simileMarker) > 0,
  ).length;
  const emDashCount = countMatches(source, AI_STYLE_PATTERNS.emDash);
  const emDashParagraphs = paragraphs.filter((row) => row.includes('——')).length;
  const repeatedPhrases = repeatedPhraseClusters(source);
  return {
    contrastFormulaCount: countMatches(source, AI_STYLE_PATTERNS.contrastFormula),
    authorVerdictCount: countMatches(narrativeOnly, AI_STYLE_PATTERNS.authorVerdict),
    sceneSummaryShellCount: countMatches(narrativeOnly, AI_STYLE_PATTERNS.sceneSummaryShell),
    simileMarkerCount,
    similePerKChars: source.length ? simileMarkerCount * 1000 / source.length : 0,
    simileParagraphRatio: paragraphs.length ? simileParagraphs / paragraphs.length : 0,
    emDashCount,
    emDashPerKChars: source.length ? emDashCount * 1000 / source.length : 0,
    emDashParagraphRatio: paragraphs.length ? emDashParagraphs / paragraphs.length : 0,
    shortParagraphRatio: paragraphs.length ? shortParagraphs / paragraphs.length : 0,
    maxConsecutiveShortParagraphs,
    shortParagraphClusterRatio: paragraphs.length
      ? clusteredShortParagraphs / paragraphs.length : 0,
    maxConsecutiveSimilarParagraphs,
    ...repeatedPhrases,
  };
}

function reviewEvidenceQuotes(item) {
  if (!item || typeof item !== 'object') return [];
  const quotes = [];
  for (const [key, nested] of Object.entries(item)) {
    if ((key === 'evidence' || key.endsWith('Quote'))
      && typeof nested === 'string' && nested.trim()) {
      quotes.push(nested.trim());
    } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      quotes.push(...reviewEvidenceQuotes(nested));
    }
  }
  return quotes;
}

export function chapterRevisionImprovement(value, sourceText, {
  stageId, review,
} = {}) {
  if (typeof value !== 'string' || typeof sourceText !== 'string') return null;
  const sourceMetrics = chapterRevisionStyleMetrics(sourceText);
  const candidateMetrics = chapterRevisionStyleMetrics(value);
  const reviewChecks = Array.isArray(review?.webFictionChecks)
    ? review.webFictionChecks : [];
  const riskEvidence = [...new Set(reviewChecks
    .filter((item) => item?.status === 'risk'
      && typeof item.evidence === 'string' && item.evidence.trim())
    .map((item) => item.evidence.trim()))];
  const remainingRiskEvidence = riskEvidence.filter((quote) => value.includes(quote));
  const riskEvidenceRemoved = remainingRiskEvidence.length === 0;
  // 保留旧字段，兼容前端和既有调用方；现在代表全部带原文引文的风险目标。
  const targetEvidenceRemoved = riskEvidence.length ? riskEvidenceRemoved : null;
  const allProtectedEvidence = [...new Set(reviewChecks
    .filter((item) => item?.status === 'pass')
    .flatMap(reviewEvidenceQuotes))];
  const conflictedProtectedEvidence = allProtectedEvidence.filter((protectedQuote) =>
    riskEvidence.some((riskQuote) => protectedQuote.includes(riskQuote)
      || riskQuote.includes(protectedQuote)));
  const protectedEvidence = allProtectedEvidence.filter(
    (quote) => !conflictedProtectedEvidence.includes(quote),
  );
  const lostProtectedEvidence = protectedEvidence.filter((quote) => !value.includes(quote));
  const protectedEvidenceRetained = lostProtectedEvidence.length === 0;
  const candidateChanged = value.trim() !== sourceText.trim();
  const noStyleRegression = candidateMetrics.contrastFormulaCount
      <= sourceMetrics.contrastFormulaCount
    && candidateMetrics.authorVerdictCount <= sourceMetrics.authorVerdictCount
    && candidateMetrics.sceneSummaryShellCount <= sourceMetrics.sceneSummaryShellCount
    && candidateMetrics.simileMarkerCount <= sourceMetrics.simileMarkerCount
    && candidateMetrics.similePerKChars <= sourceMetrics.similePerKChars + 0.05
    && candidateMetrics.simileParagraphRatio <= sourceMetrics.simileParagraphRatio + 0.02
    && candidateMetrics.emDashCount <= sourceMetrics.emDashCount
    && candidateMetrics.emDashPerKChars <= sourceMetrics.emDashPerKChars + 0.05
    && candidateMetrics.emDashParagraphRatio <= sourceMetrics.emDashParagraphRatio + 0.02
    && candidateMetrics.shortParagraphRatio <= sourceMetrics.shortParagraphRatio + 0.05
    && candidateMetrics.maxConsecutiveShortParagraphs
      <= sourceMetrics.maxConsecutiveShortParagraphs
    && candidateMetrics.shortParagraphClusterRatio
      <= sourceMetrics.shortParagraphClusterRatio + 0.02
    && (sourceMetrics.maxConsecutiveSimilarParagraphs < 6
      || candidateMetrics.maxConsecutiveSimilarParagraphs
        <= sourceMetrics.maxConsecutiveSimilarParagraphs)
    && candidateMetrics.repeatedPhraseClusterCount
      <= sourceMetrics.repeatedPhraseClusterCount
    && candidateMetrics.repeatedPhraseExcessCount
      <= sourceMetrics.repeatedPhraseExcessCount;
  const targetImproved = stageId === 'intensity-shape'
    ? noStyleRegression && candidateChanged
      && (sourceMetrics.maxConsecutiveSimilarParagraphs < 6
        || candidateMetrics.maxConsecutiveSimilarParagraphs
          < sourceMetrics.maxConsecutiveSimilarParagraphs)
    : stageId === 'scene-grounding'
    ? noStyleRegression && candidateChanged
      && (sourceMetrics.sceneSummaryShellCount === 0
        || candidateMetrics.sceneSummaryShellCount < sourceMetrics.sceneSummaryShellCount)
    : stageId === 'abstract-summary'
    ? noStyleRegression && candidateChanged
      && (sourceMetrics.authorVerdictCount === 0
        || candidateMetrics.authorVerdictCount < sourceMetrics.authorVerdictCount)
    : stageId === 'rhetoric-repetition'
    ? noStyleRegression && (
      candidateMetrics.contrastFormulaCount < sourceMetrics.contrastFormulaCount
      || candidateMetrics.simileMarkerCount < sourceMetrics.simileMarkerCount
      || candidateMetrics.emDashCount < sourceMetrics.emDashCount
      || candidateMetrics.repeatedPhraseClusterCount
        < sourceMetrics.repeatedPhraseClusterCount
      || candidateMetrics.repeatedPhraseExcessCount
        < sourceMetrics.repeatedPhraseExcessCount
    )
    : review
      ? candidateChanged && riskEvidenceRemoved
      : targetEvidenceRemoved === null ? true : targetEvidenceRemoved;
  return {
    sourceMetrics, candidateMetrics, targetEvidenceRemoved,
    riskEvidenceCount: riskEvidence.length, remainingRiskEvidence, riskEvidenceRemoved,
    protectedEvidenceCount: protectedEvidence.length,
    conflictedProtectedEvidence, lostProtectedEvidence,
    protectedEvidenceRetained, candidateChanged,
    noStyleRegression, targetImproved,
    valid: noStyleRegression && targetImproved && protectedEvidenceRetained,
  };
}

export const CHAPTER_REVISION_STAGES = Object.freeze([
  Object.freeze({
    id: 'scene-grounding', label: '概述化 → 具体场景',
    focus: '找出把关键冲突、选择、兑现或关系变化一笔带过的概述，把必要部分还原为可见的行动、对话、反应与后果。',
    guard: '只补足原文已经成立或明确暗示的过程，不新增人物、设定、胜负、线索或剧情结果。',
  }),
  Object.freeze({
    id: 'abstract-summary', label: '抽象总结 → 人物反应',
    focus: '处理替人物下结论、空泛感叹、作者代替读者总结意义和反复解释情绪的句段，用人物当下的动作、感官、停顿或有目的的内心替代。',
    guard: '不要为了“含蓄”删掉读者理解因果所必需的信息，也不要把所有内心活动都改成动作。',
  }),
  Object.freeze({
    id: 'rhetoric-repetition', label: '重复修辞与模板句',
    focus: '清理密集比喻、同构排比、连续短句金句、“不是……而是……”式总结、重复意象和为了深刻而深刻的句子。',
    guard: '保留真正符合人物与场景的少量有力表达，不把文字改成干瘪流水账。',
  }),
  Object.freeze({
    id: 'character-voice', label: '人物同声 → 声音分化',
    focus: '让主要人物的用词、句长、回避方式、攻击方式、潜台词和即时目的符合各自身份、欲望、压力反应与关系温度。',
    guard: '不得把作者秘密写成角色已知，不得靠口癖标签化人物，也不得改变对话承载的事实和决定。',
  }),
  Object.freeze({
    id: 'intensity-shape', label: '同强度节奏 → 张弛变化',
    focus: '调整长期同句长、同段长、同情绪强度或持续高压/持续平淡的问题，让蓄力、冲突、反应、决定和余波形成清楚的强弱变化。',
    guard: '不能凭空加入追杀、争吵、反转或章末事故；节奏变化必须来自原有矛盾和人物反应。',
  }),
  Object.freeze({
    id: 'low-value-paragraphs', label: '无效段落与重复信息',
    focus: '删除或合并重复说明、无信息过渡、同义反复、无后果闲聊、已被场景证明后的再次解释，以及不改变情绪或局势的空转段落。',
    guard: '保留必要呼吸感、人物关系细节、因果桥梁和后文理解所需的铺垫，不能把章节压成剧情摘要。',
  }),
]);

const STAGE_BY_ID = new Map(CHAPTER_REVISION_STAGES.map((stage) => [stage.id, stage]));

export function chapterRevisionStage(value) {
  return typeof value === 'string' ? STAGE_BY_ID.get(value) ?? null : null;
}

export function normalizeChapterRevisionCandidate(value, sourceText) {
  if (typeof value !== 'string' || typeof sourceText !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_VERSION_TEXT_CHARS
    || /^```/u.test(text) || /```$/u.test(text)
    || !chapterOutputLeakDiagnostics(text).valid) return null;
  // 分项修订必须返回完整章节；超长正文被压成提要时宁可拒绝候选，也不让
  // 作者误把摘要采纳为正文。短章不使用比例门槛，避免误伤实验性片段。
  if (sourceText.length >= 500 && text.length < Math.ceil(sourceText.length * 0.3)) return null;
  return text;
}
