import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_STAGE_SUMMARIES_PER_BOOK, MAX_STAGE_SUMMARY_CHARS,
  MAX_STAGE_SUMMARY_SOURCE_SECTIONS, MAX_STAGE_SUMMARY_TITLE_CHARS,
} from './limits.js';

export const STAGE_SUMMARY_ID_PATTERN = /^stage_[0-9a-f]{32}$/;
export const STAGE_SUMMARY_STATUSES = new Set(['draft', 'frozen']);

const isRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);
const codePointLength = (value) => Array.from(value).length;
const validText = (value, max, { required = true } = {}) => typeof value === 'string'
  && codePointLength(value) <= max && (!required || value.trim().length > 0);
const validTimestamp = (value) => typeof value === 'string'
  && Number.isFinite(Date.parse(value));
const validFingerprint = (value) => typeof value === 'string'
  && /^[A-Za-z0-9_-]{43}$/.test(value);

export function createStageSummaryId() {
  return `stage_${randomUUID().replaceAll('-', '')}`;
}

export function normalizeStageSummaries(value, sectionIds) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STAGE_SUMMARIES_PER_BOOK
    || !Array.isArray(sectionIds)) return null;
  const positions = new Map(sectionIds.map((id, index) => [id, index]));
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (!isRecord(item) || !STAGE_SUMMARY_ID_PATTERN.test(item.id)
      || seen.has(item.id) || !validText(item.title, MAX_STAGE_SUMMARY_TITLE_CHARS)
      || !validText(item.summary, MAX_STAGE_SUMMARY_CHARS)
      || !STAGE_SUMMARY_STATUSES.has(item.status)
      || !positions.has(item.startSectionId) || !positions.has(item.endSectionId)
      || positions.get(item.startSectionId) > positions.get(item.endSectionId)
      || positions.get(item.endSectionId) - positions.get(item.startSectionId) + 1
        > MAX_STAGE_SUMMARY_SOURCE_SECTIONS
      || !validFingerprint(item.sourceFingerprint)
      || !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt)) return null;
    seen.add(item.id);
    result.push({
      id: item.id,
      title: item.title.trim(),
      startSectionId: item.startSectionId,
      endSectionId: item.endSectionId,
      summary: item.summary.trim(),
      status: item.status,
      sourceFingerprint: item.sourceFingerprint,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  return result;
}

export function stageSummaryRange(book, startSectionId, endSectionId) {
  const sections = Array.isArray(book?.sections) ? book.sections : [];
  const startIndex = sections.indexOf(startSectionId);
  const endIndex = sections.indexOf(endSectionId);
  if (startIndex < 0 || endIndex < startIndex) throw new Error('BAD_STAGE_SUMMARY_RANGE');
  if (endIndex - startIndex + 1 > MAX_STAGE_SUMMARY_SOURCE_SECTIONS) {
    throw new Error('STAGE_SUMMARY_RANGE_TOO_LARGE');
  }
  return { startIndex, endIndex, sectionIds: sections.slice(startIndex, endIndex + 1) };
}

export function stageSummarySourceSnapshot(book, startSectionId, endSectionId) {
  const range = stageSummaryRange(book, startSectionId, endSectionId);
  const rows = range.sectionIds.map((sectionId, offset) => {
    const item = book?.sectionSummaries?.[sectionId];
    return {
      sectionId,
      index: range.startIndex + offset + 1,
      title: typeof item?.title === 'string' ? item.title : '',
      summary: typeof item?.summary === 'string' ? item.summary : '',
    };
  });
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(rows), 'utf8').digest('base64url');
  return { ...range, rows, fingerprint };
}

export function stageSummaryIsStale(book, item) {
  try {
    return stageSummarySourceSnapshot(
      book, item.startSectionId, item.endSectionId,
    ).fingerprint !== item.sourceFingerprint;
  } catch {
    return true;
  }
}

export function stageSummaryPublicView(book, item) {
  const { startIndex, endIndex } = stageSummaryRange(
    book, item.startSectionId, item.endSectionId,
  );
  return {
    ...item,
    startSectionIndex: startIndex + 1,
    endSectionIndex: endIndex + 1,
    stale: stageSummaryIsStale(book, item),
  };
}
