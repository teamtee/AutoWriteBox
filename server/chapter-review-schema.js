import {
  MAX_REVIEW_CHECK_DETAIL_CHARS, MAX_REVIEW_SIGNAL_CHARS,
} from './limits.js';

export const CHAPTER_REVIEW_CHECK_IDS = Object.freeze([
  'goldenChapter',
  'premisePromise',
  'chapterGoal',
  'obstacleEscalation',
  'characterChoice',
  'effectiveIncrement',
  'payoff',
  'endingHook',
  'expressionBalance',
  'repetitionRisk',
  'longArcProgress',
  'styleConsistency',
  'packagingPromise',
  'contentRisk',
]);

const PREVIOUS_CHAPTER_REVIEW_CHECK_IDS = CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'contentRisk',
);
const PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS = PREVIOUS_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'packagingPromise',
);
const PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS = PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'styleConsistency',
);
const LEGACY_CHAPTER_REVIEW_CHECK_IDS = PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'longArcProgress',
);

export const CHAPTER_REVIEW_CHECK_STATUSES = Object.freeze(['pass', 'risk', 'na']);
export const CHAPTER_REVIEW_SIGNAL_FIELDS = Object.freeze([
  'chapterFunction',
  'conflictType',
  'emotionTone',
  'payoffType',
  'dominantMode',
]);

const CHECK_ID_SET = new Set(CHAPTER_REVIEW_CHECK_IDS);
const CHECK_STATUS_SET = new Set(CHAPTER_REVIEW_CHECK_STATUSES);

function cleanText(value, maxLength, truncate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length > maxLength && !truncate) return null;
  return chars.slice(0, maxLength).join('');
}

// 新模型输出必须在提供检查表时一次给齐，避免 UI 把“模型漏字段”误画成
// 通过。旧审稿没有该字段仍然合法，便于现有书籍和备份无损升级。
export function normalizeChapterReviewChecks(value, { truncate = false } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const expectedIds = value.length === CHAPTER_REVIEW_CHECK_IDS.length
    ? CHAPTER_REVIEW_CHECK_IDS
    : value.length === PREVIOUS_CHAPTER_REVIEW_CHECK_IDS.length
      ? PREVIOUS_CHAPTER_REVIEW_CHECK_IDS
      : value.length === PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS.length
        ? PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS
        : value.length === PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS.length
          ? PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS
          : value.length === LEGACY_CHAPTER_REVIEW_CHECK_IDS.length
            ? LEGACY_CHAPTER_REVIEW_CHECK_IDS
            : null;
  if (!expectedIds) return null;

  const byId = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !CHECK_ID_SET.has(item.id) || !CHECK_STATUS_SET.has(item.status)
      || byId.has(item.id)) {
      return null;
    }
    const detail = cleanText(item.detail, MAX_REVIEW_CHECK_DETAIL_CHARS, truncate);
    if (!detail) return null;
    byId.set(item.id, { id: item.id, status: item.status, detail });
  }
  if (byId.size !== expectedIds.length
    || expectedIds.some((id) => !byId.has(id))) return null;
  return expectedIds.map((id) => byId.get(id));
}

export function normalizeChapterReviewSignals(value, { truncate = false } = {}) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of CHAPTER_REVIEW_SIGNAL_FIELDS) {
    const text = cleanText(value[field], MAX_REVIEW_SIGNAL_CHARS, truncate);
    if (!text) return null;
    result[field] = text;
  }
  return result;
}
