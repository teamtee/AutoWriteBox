import {
  MAX_GOLDEN_THREE_CHECK_SUMMARY_CHARS, MAX_GOLDEN_THREE_EVIDENCE_CHARS,
  MAX_GOLDEN_THREE_FIX_INSTRUCTION_CHARS, MAX_GOLDEN_THREE_FIX_LABEL_CHARS,
  MAX_GOLDEN_THREE_FIX_PROBLEM_CHARS, MAX_GOLDEN_THREE_FIXES,
  MAX_GOLDEN_THREE_VERDICT_CHARS, MAX_ID_CHARS, MAX_TITLE_CHARS,
} from './limits.js';

export const GOLDEN_THREE_CHECK_IDS = Object.freeze([
  'premisePromise', 'protagonistAttachment', 'protagonistDrive', 'coreLoop',
  'centralConflict', 'differentiation', 'firstPayoff', 'threeChapterEscalation',
  'continuationPull',
]);
export const GOLDEN_THREE_FIX_TARGETS = Object.freeze([
  'chapter-1', 'chapter-2', 'chapter-3', 'all',
]);

const CHECK_ID_SET = new Set(GOLDEN_THREE_CHECK_IDS);
const FIX_TARGET_SET = new Set(GOLDEN_THREE_FIX_TARGETS);
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORAGE_ID_PATTERN = /^[\w-]+$/;

function cleanText(value, maxLength, truncate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length > maxLength && !truncate) return null;
  return chars.slice(0, maxLength).join('');
}

export function normalizeGoldenThreeReview(value, {
  truncate = false, chapterContents, requireEvidenceQuotes = false,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isInteger(value.score) || value.score < 0 || value.score > 100
    || !Array.isArray(value.checks) || value.checks.length !== GOLDEN_THREE_CHECK_IDS.length
    || !Array.isArray(value.fixes) || value.fixes.length < 1
    || value.fixes.length > MAX_GOLDEN_THREE_FIXES) return null;
  const verdict = cleanText(value.verdict, MAX_GOLDEN_THREE_VERDICT_CHARS, truncate);
  if (!verdict) return null;

  const checks = new Map();
  for (const check of value.checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check)
      || !CHECK_ID_SET.has(check.id) || checks.has(check.id)
      || !['pass', 'risk'].includes(check.status)
      || !Array.isArray(check.evidence) || check.evidence.length < 1
      || check.evidence.length > 3) return null;
    const summary = cleanText(
      check.summary, MAX_GOLDEN_THREE_CHECK_SUMMARY_CHARS, truncate,
    );
    if (!summary) return null;
    const seenChapters = new Set();
    const evidence = [];
    for (const item of check.evidence) {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || ![1, 2, 3].includes(item.chapter) || seenChapters.has(item.chapter)) return null;
      const hasQuotedEvidence = Object.prototype.hasOwnProperty.call(item, 'quote')
        || Object.prototype.hasOwnProperty.call(item, 'analysis');
      if (requireEvidenceQuotes && !hasQuotedEvidence) return null;
      if (hasQuotedEvidence) {
        const quote = cleanText(item.quote, MAX_GOLDEN_THREE_EVIDENCE_CHARS, truncate);
        const analysis = cleanText(item.analysis, MAX_GOLDEN_THREE_EVIDENCE_CHARS, truncate);
        const chapterContent = Array.isArray(chapterContents)
          ? chapterContents[item.chapter - 1] : undefined;
        if (!quote || Array.from(quote).length < 4 || !analysis
          || (requireEvidenceQuotes && (typeof chapterContent !== 'string'
            || !chapterContent.includes(quote)))) return null;
        seenChapters.add(item.chapter);
        evidence.push({ chapter: item.chapter, quote, analysis });
        continue;
      }
      const detail = cleanText(item.detail, MAX_GOLDEN_THREE_EVIDENCE_CHARS, truncate);
      if (!detail) return null;
      seenChapters.add(item.chapter);
      evidence.push({ chapter: item.chapter, detail });
    }
    checks.set(check.id, { id: check.id, status: check.status, summary, evidence });
  }
  if (GOLDEN_THREE_CHECK_IDS.some((id) => !checks.has(id))) return null;

  const fixes = [];
  for (const fix of value.fixes) {
    if (!fix || typeof fix !== 'object' || Array.isArray(fix)
      || !FIX_TARGET_SET.has(fix.target)) return null;
    const label = cleanText(fix.label, MAX_GOLDEN_THREE_FIX_LABEL_CHARS, truncate);
    const problem = cleanText(fix.problem, MAX_GOLDEN_THREE_FIX_PROBLEM_CHARS, truncate);
    const instruction = cleanText(
      fix.instruction, MAX_GOLDEN_THREE_FIX_INSTRUCTION_CHARS, truncate,
    );
    if (!label || !problem || !instruction) return null;
    fixes.push({ target: fix.target, label, problem, instruction });
  }
  return { score: value.score, verdict, checks: GOLDEN_THREE_CHECK_IDS.map((id) => checks.get(id)), fixes };
}

export function normalizeStoredGoldenThreeReview(value, {
  errorCode = 'STORAGE_DATA_INVALID',
} = {}) {
  if (value === undefined || value === null) return undefined;
  const normalized = normalizeGoldenThreeReview(value);
  if (!normalized || !HASH_PATTERN.test(value.sourceContextRevision)
    || !Array.isArray(value.sources) || value.sources.length !== 3
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(errorCode);
  }
  const sources = value.sources.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.sectionId !== 'string' || !STORAGE_ID_PATTERN.test(source.sectionId)
      || source.sectionId.length > MAX_ID_CHARS
      || typeof source.chapterId !== 'string' || !STORAGE_ID_PATTERN.test(source.chapterId)
      || source.chapterId.length > MAX_ID_CHARS
      || source.bookChapterIndex !== index + 1
      || typeof source.title !== 'string' || source.title.length > MAX_TITLE_CHARS
      || !HASH_PATTERN.test(source.bodyFingerprint)) throw new Error(errorCode);
    return {
      sectionId: source.sectionId, chapterId: source.chapterId,
      bookChapterIndex: source.bookChapterIndex, title: source.title,
      bodyFingerprint: source.bodyFingerprint,
    };
  });
  return {
    ...normalized, sourceContextRevision: value.sourceContextRevision,
    sources, updatedAt: value.updatedAt,
  };
}
