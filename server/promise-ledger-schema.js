import { createHash } from 'node:crypto';
import {
  MAX_ID_CHARS,
  MAX_PROMISE_LEDGER_CONTEXT_CHARS, MAX_PROMISE_LEDGER_ENTRIES,
  MAX_PROMISE_NOTES_CHARS, MAX_PROMISE_PROGRESS_CHARS,
  MAX_PROMISE_PROGRESS_EVENTS, MAX_PROMISE_TEXT_CHARS, MAX_REVIEW_CHECK_DETAIL_CHARS,
  MAX_TOTAL_BOOK_CHAPTERS,
} from './limits.js';
import { chapterPlanForeshadowingNarrativeContract } from './chapter-plan-quality.js';

export const PROMISE_LEDGER_ID_PATTERN = /^promise_[0-9a-f]{32}$/;
export const PROMISE_PROGRESS_ID_PATTERN = /^progress_[0-9a-f]{32}$/;
export const PROMISE_KINDS = Object.freeze([
  'main', 'character', 'mystery', 'relationship', 'growth', 'world', 'other',
]);
export const PROMISE_STATUSES = Object.freeze(['planned', 'open', 'paid', 'abandoned']);
export const PROMISE_NARRATIVE_BEATS = Object.freeze([
  'plant', 'pressure', 'misdirect', 'reinterpret', 'collide', 'payoff',
]);
export const PROMISE_WORLD_LINKS = Object.freeze([
  'none', 'deepen-current', 'support-gate',
]);

const kindSet = new Set(PROMISE_KINDS);
const statusSet = new Set(PROMISE_STATUSES);
const narrativeBeatSet = new Set(PROMISE_NARRATIVE_BEATS);
const worldLinkSet = new Set(PROMISE_WORLD_LINKS);
const progressStatusSet = new Set(['active', 'stale']);
const sourceIdPattern = /^[\w-]+$/;
const bodyFingerprintPattern = /^[A-Za-z0-9_-]{43}$/;

export function requirePromiseLedgerId(value, errorCode = 'BAD_PROMISE_ENTRY') {
  if (typeof value !== 'string' || !PROMISE_LEDGER_ID_PATTERN.test(value)) fail(errorCode);
  return value;
}

export function emptyPromiseLedger() {
  return { entries: [] };
}

function fail(code) {
  throw new Error(code);
}

function cleanText(value, maxLength, errorCode, sizeErrorCode, { required = false } = {}) {
  if (value === undefined) value = '';
  if (typeof value !== 'string') fail(errorCode);
  const text = value.trim();
  if (text.length > maxLength * 2 || Array.from(text).length > maxLength) {
    fail(sizeErrorCode);
  }
  if (required && !text) fail(errorCode);
  return text;
}

function chapterNumber(value, errorCode, { optional = true } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOTAL_BOOK_CHAPTERS) {
    fail(errorCode);
  }
  return value;
}

function normalizeProgress(value, errorCode, sizeErrorCode) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(errorCode);
  if (value.length > MAX_PROMISE_PROGRESS_EVENTS) fail(sizeErrorCode);
  const seen = new Set();
  return value.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.id !== 'string' || !PROMISE_PROGRESS_ID_PATTERN.test(event.id)
      || seen.has(event.id)) fail(errorCode);
    seen.add(event.id);
    const normalized = {
      id: event.id,
      chapter: chapterNumber(event.chapter, errorCode, { optional: false }),
      note: cleanText(
        event.note, MAX_PROMISE_PROGRESS_CHARS, errorCode, sizeErrorCode,
        { required: true },
      ),
    };
    const evidenceKeys = [
      'beat', 'readerBefore', 'readerAfter', 'actionConsequence',
      'worldLink', 'worldEffect', 'evidence', 'source', 'status', 'confirmedAt',
    ];
    const hasEvidence = evidenceKeys.some((key) =>
      Object.prototype.hasOwnProperty.call(event, key));
    if (!hasEvidence) return normalized;
    if (!narrativeBeatSet.has(event.beat)
      || !worldLinkSet.has(event.worldLink)
      || !progressStatusSet.has(event.status)
      || !event.source || typeof event.source !== 'object' || Array.isArray(event.source)
      || typeof event.confirmedAt !== 'string'
      || !Number.isFinite(Date.parse(event.confirmedAt))) fail(errorCode);
    const sectionId = cleanText(
      event.source.sectionId, MAX_ID_CHARS, errorCode, sizeErrorCode, { required: true },
    );
    const chapterId = cleanText(
      event.source.chapterId, MAX_ID_CHARS, errorCode, sizeErrorCode, { required: true },
    );
    const bodyFingerprint = cleanText(
      event.source.bodyFingerprint, 43, errorCode, sizeErrorCode, { required: true },
    );
    if (!sourceIdPattern.test(sectionId) || !sourceIdPattern.test(chapterId)
      || !bodyFingerprintPattern.test(bodyFingerprint)) fail(errorCode);
    const readerBefore = cleanText(
      event.readerBefore, MAX_PROMISE_PROGRESS_CHARS, errorCode, sizeErrorCode,
      { required: true },
    );
    const readerAfter = cleanText(
      event.readerAfter, MAX_PROMISE_PROGRESS_CHARS, errorCode, sizeErrorCode,
      { required: true },
    );
    if (readerBefore === readerAfter) fail(errorCode);
    return {
      ...normalized,
      beat: event.beat,
      readerBefore,
      readerAfter,
      actionConsequence: cleanText(
        event.actionConsequence, MAX_PROMISE_PROGRESS_CHARS,
        errorCode, sizeErrorCode, { required: true },
      ),
      worldLink: event.worldLink,
      worldEffect: cleanText(
        event.worldEffect, MAX_PROMISE_PROGRESS_CHARS,
        errorCode, sizeErrorCode, { required: true },
      ),
      evidence: cleanText(
        event.evidence, MAX_REVIEW_CHECK_DETAIL_CHARS,
        errorCode, sizeErrorCode, { required: true },
      ),
      source: { sectionId, chapterId, bodyFingerprint },
      status: event.status,
      confirmedAt: event.confirmedAt,
    };
  });
}

export function normalizePromiseEntryInput(value, {
  errorCode = 'BAD_PROMISE_ENTRY',
  sizeErrorCode = 'PROMISE_LEDGER_TOO_LARGE',
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !PROMISE_LEDGER_ID_PATTERN.test(value.id)
    || !kindSet.has(value.kind) || !statusSet.has(value.status)
    || !Number.isInteger(value.importance) || value.importance < 1
    || value.importance > 5) fail(errorCode);
  const expectedStartChapter = chapterNumber(
    value.expectedStartChapter, errorCode, { optional: false },
  );
  const expectedEndChapter = chapterNumber(
    value.expectedEndChapter, errorCode, { optional: false },
  );
  if (expectedStartChapter > expectedEndChapter) fail(errorCode);
  const resolution = cleanText(
    value.resolution, MAX_PROMISE_TEXT_CHARS, errorCode, sizeErrorCode,
    { required: value.status === 'paid' || value.status === 'abandoned' },
  );
  const resolvedChapter = chapterNumber(value.resolvedChapter, errorCode);
  if (value.status === 'paid' && resolvedChapter === null) fail(errorCode);
  if ((value.status === 'planned' || value.status === 'open')
    && (resolution || resolvedChapter !== null)) fail(errorCode);
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    importance: value.importance,
    promise: cleanText(
      value.promise, MAX_PROMISE_TEXT_CHARS, errorCode, sizeErrorCode,
      { required: true },
    ),
    introducedChapter: chapterNumber(value.introducedChapter, errorCode),
    expectedStartChapter,
    expectedEndChapter,
    progress: normalizeProgress(value.progress, errorCode, sizeErrorCode),
    resolution,
    resolvedChapter,
    nextPromise: cleanText(
      value.nextPromise, MAX_PROMISE_TEXT_CHARS, errorCode, sizeErrorCode,
    ),
    notes: cleanText(value.notes, MAX_PROMISE_NOTES_CHARS, errorCode, sizeErrorCode),
  };
}

function storedTimestamp(value, errorCode) {
  if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value))) {
    fail(errorCode);
  }
  return value;
}

export function normalizePromiseLedger(value, {
  errorCode = 'BAD_PROMISE_LEDGER',
  sizeErrorCode = 'PROMISE_LEDGER_TOO_LARGE',
} = {}) {
  if (value === undefined) return emptyPromiseLedger();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.entries)) fail(errorCode);
  if (value.entries.length > MAX_PROMISE_LEDGER_ENTRIES) fail(sizeErrorCode);
  const ids = new Set();
  const entries = value.entries.map((entry) => {
    const normalized = normalizePromiseEntryInput(entry, { errorCode, sizeErrorCode });
    if (ids.has(normalized.id)) fail(errorCode);
    ids.add(normalized.id);
    return {
      ...normalized,
      createdAt: storedTimestamp(entry.createdAt, errorCode),
      updatedAt: storedTimestamp(entry.updatedAt, errorCode),
    };
  });
  return { entries };
}

export function promiseLedgerRevision(value) {
  const ledger = normalizePromiseLedger(value);
  return createHash('sha256').update(JSON.stringify(ledger)).digest('base64url');
}

export function promiseLedgerView(value) {
  const ledger = normalizePromiseLedger(value);
  return { ...ledger, revision: promiseLedgerRevision(ledger) };
}

function promisePriority(entry, bookChapterIndex) {
  if (entry.status === 'open') {
    if (bookChapterIndex > entry.expectedEndChapter) return 10_000
      + (bookChapterIndex - entry.expectedEndChapter) * 10 + entry.importance;
    if (bookChapterIndex >= entry.expectedStartChapter) return 8_000
      + entry.importance * 10 - Math.max(0, entry.expectedEndChapter - bookChapterIndex);
    return 6_000 + entry.importance * 10
      - Math.min(999, entry.expectedStartChapter - bookChapterIndex);
  }
  if (entry.status === 'planned') return 4_000 + entry.importance * 10
    - Math.min(999, Math.max(0, entry.expectedStartChapter - bookChapterIndex));
  if (entry.nextPromise) return 2_000 + entry.importance;
  if (entry.resolvedChapter !== null && entry.resolvedChapter >= bookChapterIndex - 5) {
    return 1_000 + entry.resolvedChapter;
  }
  return -1;
}

function activeEvidenceBeats(entry) {
  return entry.progress.filter((event) => event.status !== 'stale' && event.beat)
    .sort((left, right) => left.chapter - right.chapter
      || (left.confirmedAt ?? '').localeCompare(right.confirmedAt ?? '')
      || left.id.localeCompare(right.id));
}

function promiseRow(entry, bookChapterIndex) {
  const status = {
    planned: '计划中（尚未向读者建立）', open: '已建立待兑现',
    paid: '已兑现', abandoned: '已放弃',
  }[entry.status];
  let timing = `预计全书第${entry.expectedStartChapter}–${entry.expectedEndChapter}章兑现`;
  if (entry.status === 'open' && bookChapterIndex > entry.expectedEndChapter) {
    timing += `；已逾期${bookChapterIndex - entry.expectedEndChapter}章`;
  } else if (entry.status === 'open' && bookChapterIndex >= entry.expectedStartChapter) {
    timing += bookChapterIndex === entry.expectedEndChapter ? '；本章到期' : '；已进入兑现窗口';
  }
  const introduced = entry.introducedChapter
    ? `；全书第${entry.introducedChapter}章建立` : '';
  const beatLabels = {
    plant: '植入', pressure: '加压', misdirect: '公平误导',
    reinterpret: '变义', collide: '线索碰撞', payoff: '回收',
  };
  const progress = entry.progress.filter((event) => event.status !== 'stale')
    .sort((left, right) => left.chapter - right.chapter)
    .slice(-3)
    .map((event) => event.beat
      ? `第${event.chapter}章[${beatLabels[event.beat]}]=${event.note}；读者认知“${event.readerBefore}”→“${event.readerAfter}”；行动后果=${event.actionConsequence}；世界线=${event.worldEffect}`
      : `第${event.chapter}章=${event.note}`)
    .join('；');
  const resolution = entry.resolution
    ? `；结果${entry.resolvedChapter ? `（第${entry.resolvedChapter}章）` : ''}=${entry.resolution}`
    : '';
  const next = entry.nextPromise ? `；由此产生的新承诺=${entry.nextPromise}` : '';
  return `- [债务ID:${entry.id}][${status}][重要度${entry.importance}] ${entry.promise}（${timing}${introduced}`
    + `${progress ? `；最近推进=${progress}` : ''}${resolution}${next}）`;
}

const PLAN_DEBT_TOKEN_PATTERN = /\[(推进债务|兑现债务|建立承诺|延期债务):([^\]\r\n]{1,100})\]/gu;
const PLAN_DEBT_TOKEN_START_PATTERN = /\[(?:推进债务|兑现债务|建立承诺|延期债务):/gu;

function deferralDetailValid(notes, id) {
  const token = `[延期债务:${id}]`;
  const start = notes.indexOf(token);
  if (start < 0) return false;
  const tail = notes.slice(start + token.length);
  const nextToken = tail.search(PLAN_DEBT_TOKEN_START_PATTERN);
  const segment = nextToken < 0 ? tail : tail.slice(0, nextToken);
  const match = segment.match(/延期原因：([^；;\n]+)[；;]\s*下一检查点：([^\n]+)/u);
  return Boolean(match && Array.from(match[1].trim()).length >= 4
    && Array.from(match[2].trim()).length >= 4);
}

export function chapterPlanPromiseAlignment(value, {
  bookChapterIndex = 1, plan = {},
} = {}) {
  const ledger = normalizePromiseLedger(value);
  const chapterIndex = Number.isInteger(bookChapterIndex) && bookChapterIndex >= 1
    ? bookChapterIndex : 1;
  const entriesById = new Map(ledger.entries.map((entry) => [entry.id, entry]));
  const urgentEntries = ledger.entries.filter((entry) => entry.status === 'open'
    && chapterIndex >= entry.expectedStartChapter)
    .sort((left, right) => promisePriority(right, chapterIndex)
      - promisePriority(left, chapterIndex));
  // 刚在上一章获得正文证据的债务暂不继续阻塞下一章，让主线、人物线和
  // 关系线可以有因果地交替推进，而不是一进入窗口就机械地章章打卡。
  // 在其余临期/逾期债务中，只取当前最高优先级的一层；低优先级支线的
  // 形式推进不能遮蔽更逾期或更重要的关键承诺。
  const blockingCandidates = urgentEntries.filter((entry) => {
    const latest = activeEvidenceBeats(entry).at(-1);
    return !latest || latest.chapter < chapterIndex - 1;
  });
  const blockingPriority = blockingCandidates.length
    ? promisePriority(blockingCandidates[0], chapterIndex) : null;
  const blockingUrgentEntries = blockingPriority === null ? [] : blockingCandidates
    .filter((entry) => promisePriority(entry, chapterIndex) === blockingPriority);
  const foreshadowing = typeof plan?.foreshadowing === 'string' ? plan.foreshadowing : '';
  const notes = typeof plan?.notes === 'string' ? plan.notes : '';
  const source = `${foreshadowing}\n${notes}`;
  const noForeshadowingTask = /^无埋点理由\s*[:：]/u.test(foreshadowing.trim());
  const references = [
    ...Array.from(foreshadowing.matchAll(PLAN_DEBT_TOKEN_PATTERN), (match) => ({
      action: match[1], id: match[2], field: 'foreshadowing',
    })),
    ...Array.from(notes.matchAll(PLAN_DEBT_TOKEN_PATTERN), (match) => ({
      action: match[1], id: match[2], field: 'notes',
    })),
  ];
  const markerStartCount = source.match(PLAN_DEBT_TOKEN_START_PATTERN)?.length ?? 0;
  const referenceCounts = new Map();
  for (const reference of references) {
    referenceCounts.set(reference.id, (referenceCounts.get(reference.id) ?? 0) + 1);
  }
  const validReferences = [];
  const invalidReferences = [];
  for (const reference of references) {
    const entry = entriesById.get(reference.id);
    const placementValid = reference.action === '延期债务'
      ? reference.field === 'notes' : reference.field === 'foreshadowing';
    const contradictsNoTask = noForeshadowingTask && reference.action !== '延期债务';
    const valid = !contradictsNoTask && placementValid
      && referenceCounts.get(reference.id) === 1 && entry && (
      (entry.status === 'open' && ['推进债务', '兑现债务', '延期债务'].includes(reference.action))
      || (entry.status === 'planned' && reference.action === '建立承诺')
    ) && (reference.action !== '延期债务'
      || deferralDetailValid(notes, reference.id));
    (valid ? validReferences : invalidReferences).push(reference);
  }
  if (markerStartCount > references.length) {
    invalidReferences.push({ action: '格式错误', id: '' });
  }
  const urgentIds = new Set(urgentEntries.map((entry) => entry.id));
  const blockingUrgentIds = blockingUrgentEntries.map((entry) => entry.id);
  const blockingIds = new Set(blockingUrgentIds);
  const addressedUrgentIds = [...new Set(validReferences
    .filter((reference) => urgentIds.has(reference.id))
    .map((reference) => reference.id))];
  const addressedBlockingUrgentIds = addressedUrgentIds
    .filter((id) => blockingIds.has(id));
  const narrative = chapterPlanForeshadowingNarrativeContract(plan);
  const narrativeConflicts = [];
  const repeatedBeatIds = [];
  if (narrative) {
    const expectedBeats = {
      '建立承诺': new Set(['plant']),
      '推进债务': new Set(['pressure', 'misdirect', 'reinterpret', 'collide']),
      '兑现债务': new Set(['payoff']),
    };
    const trackableReferences = validReferences.filter(
      (reference) => reference.action !== '延期债务',
    );
    if (trackableReferences.length > 1) {
      trackableReferences.forEach((reference) => narrativeConflicts.push({
        id: reference.id, action: reference.action, reason: 'multiple-debt-actions',
      }));
    }
    trackableReferences
      .forEach((reference) => {
        const entry = entriesById.get(reference.id);
        const allowed = expectedBeats[reference.action];
        if (!allowed?.has(narrative.beat)) {
          narrativeConflicts.push({
            id: reference.id, action: reference.action, reason: 'action-beat-mismatch',
          });
          return;
        }
        const activeEvidence = activeEvidenceBeats(entry);
        const latest = activeEvidence.at(-1);
        if (latest && narrative.readerBefore !== latest.readerAfter) {
          narrativeConflicts.push({
            id: reference.id, action: reference.action, reason: 'reader-state-disconnected',
            expectedReaderBefore: latest.readerAfter,
          });
        }
        if (activeEvidence.length >= 2
          && activeEvidence.slice(-2).every((event) => event.beat === narrative.beat)) {
          repeatedBeatIds.push(reference.id);
        }
      });
  }
  return {
    requiresAction: blockingUrgentEntries.length > 0,
    satisfied: blockingUrgentEntries.length === 0
      || addressedBlockingUrgentIds.length > 0,
    urgentCount: urgentEntries.length,
    blockingUrgentCount: blockingUrgentEntries.length,
    blockingUrgentIds,
    addressedUrgentIds,
    addressedBlockingUrgentIds,
    invalidReferences,
    narrativeConflicts,
    repeatedBeatIds,
    references,
    noForeshadowingTask,
  };
}

export function chapterPromiseActionOptions(value, {
  bookChapterIndex = 1, limit = 12,
} = {}) {
  const ledger = normalizePromiseLedger(value);
  const chapterIndex = Number.isInteger(bookChapterIndex) && bookChapterIndex >= 1
    ? bookChapterIndex : 1;
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 12;
  return ledger.entries
    .filter((entry) => entry.status === 'open' || entry.status === 'planned')
    .map((entry) => ({ entry, priority: promisePriority(entry, chapterIndex) }))
    .sort((left, right) => right.priority - left.priority
      || right.entry.importance - left.entry.importance
      || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, safeLimit)
    .map(({ entry }) => {
      const activeBeats = activeEvidenceBeats(entry);
      const lastBeat = activeBeats.at(-1);
      return {
      id: entry.id,
      status: entry.status,
      promise: entry.promise,
      importance: entry.importance,
      expectedStartChapter: entry.expectedStartChapter,
      expectedEndChapter: entry.expectedEndChapter,
      urgent: entry.status === 'open' && chapterIndex >= entry.expectedStartChapter,
      overdue: entry.status === 'open' && chapterIndex > entry.expectedEndChapter,
      lastBeat: lastBeat?.beat,
      lastReaderAfter: lastBeat?.readerAfter,
      recentBeatPattern: activeBeats.slice(-3).map((event) => event.beat),
    };
    });
}

export function generationPromiseLedgerRows(value, {
  bookChapterIndex = 1,
  maxChars = MAX_PROMISE_LEDGER_CONTEXT_CHARS,
} = {}) {
  const ledger = normalizePromiseLedger(value);
  const chapterIndex = Number.isInteger(bookChapterIndex) && bookChapterIndex >= 1
    ? bookChapterIndex : 1;
  const limit = Number.isInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_PROMISE_LEDGER_CONTEXT_CHARS;
  const candidates = ledger.entries
    .map((entry) => ({ entry, priority: promisePriority(entry, chapterIndex) }))
    .filter((item) => item.priority >= 0)
    .sort((left, right) => right.priority - left.priority
      || right.entry.importance - left.entry.importance
      || right.entry.updatedAt.localeCompare(left.entry.updatedAt));
  const rows = [];
  let used = 0;
  for (const { entry } of candidates) {
    const row = promiseRow(entry, chapterIndex);
    const cost = row.length + (rows.length ? 1 : 0);
    if (used + cost > limit) break;
    rows.push(row);
    used += cost;
  }
  if (rows.length < candidates.length) {
    const omitted = '- …其它较低优先级承诺因上下文预算省略…';
    if (used + omitted.length + (rows.length ? 1 : 0) <= limit) rows.push(omitted);
  }
  return rows;
}

// API 审稿确认的叙事节拍带正文来源。正文证据消失时，该节拍以及依赖它的
// 后续自动节拍必须一起退出上下文；人工录入的旧式推进不冒充可自动追溯证据。
export function invalidatePromiseEvidenceSources(book, {
  sectionId, chapterId, bodyFingerprint, preserveFingerprint,
}) {
  const ledger = normalizePromiseLedger(book?.settings?.promiseLedger);
  let changed = false;
  const now = new Date().toISOString();
  for (const entry of ledger.entries) {
    let invalidatedChapter = Number.POSITIVE_INFINITY;
    entry.progress.forEach((event) => {
      if (event.status === 'active'
        && event.source?.sectionId === sectionId
        && event.source?.chapterId === chapterId
        && (!bodyFingerprint || event.source.bodyFingerprint === bodyFingerprint)
        && event.source.bodyFingerprint !== preserveFingerprint) {
        event.status = 'stale';
        invalidatedChapter = Math.min(invalidatedChapter, event.chapter);
        changed = true;
      }
    });
    if (!Number.isFinite(invalidatedChapter)) continue;
    // 后续节拍建立在读者已经看到前一拍的前提上；上游证据消失后不能单独存活。
    entry.progress.forEach((event) => {
      if (event.status === 'active' && event.source
        && event.chapter >= invalidatedChapter) event.status = 'stale';
    });
    const activeEvidence = entry.progress.filter((event) =>
      event.status === 'active' && event.source);
    const activePlant = activeEvidence.find((event) => event.beat === 'plant');
    const activePayoff = [...activeEvidence].reverse().find((event) => event.beat === 'payoff');
    const hadSourcePlant = entry.progress.some((event) => event.source && event.beat === 'plant');
    const hadSourcePayoff = entry.progress.some((event) => event.source && event.beat === 'payoff');
    if (hadSourcePlant && !activePlant && entry.status !== 'abandoned') {
      entry.status = 'planned';
      entry.introducedChapter = null;
      entry.resolution = '';
      entry.resolvedChapter = null;
    } else if (hadSourcePayoff && !activePayoff && entry.status === 'paid') {
      entry.status = 'open';
      entry.resolution = '';
      entry.resolvedChapter = null;
    }
    entry.updatedAt = now;
  }
  if (book?.settings) book.settings.promiseLedger = ledger;
  return changed;
}
