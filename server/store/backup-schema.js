import {
  bookSectionSummaryWindow, buildBookSummaryFromSectionSummaries,
} from '../generation-context.js';
import {
  MAX_BOOK_PROMPT_SUMMARY_CHARS, MAX_BOOK_SECTION_SUMMARY_CHARS,
  MAX_BOOK_SECTIONS, MAX_CHARACTER_DESC_CHARS, MAX_CHARACTER_NAME_CHARS,
  MAX_CHARACTER_ROLE_CHARS, MAX_DIGEST_PROGRESS_CHARS, MAX_DIGEST_SUMMARY_CHARS,
  MAX_MEMORY_CANDIDATES_PER_CHAPTER, MAX_MEMORY_EVIDENCE_CHARS,
  MAX_MEMORY_FACTS_PER_BOOK, MAX_MEMORY_OBJECT_CHARS, MAX_MEMORY_PREDICATE_CHARS,
  MAX_MEMORY_REJECTIONS_PER_BOOK, MAX_MEMORY_SUBJECT_CHARS, MAX_PREMISE_CHARS,
  MAX_REVIEW_INSTRUCTION_CHARS, MAX_SECTION_CHAPTERS, MAX_SECTION_SUMMARY_CHARS,
  MAX_STORED_CHARACTERS, MAX_TITLE_CHARS, MAX_TOTAL_BACKUP_CHAPTERS,
  MAX_TOTAL_BOOK_CHAPTERS, MAX_VERSION_HISTORY_ITEMS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import {
  isMemoryFactStatus, isMemoryKind, MEMORY_ID_PATTERN,
  normalizeStoredMemoryAliases, normalizeStoredMemoryCandidate, normalizeStoredMemoryDetails,
} from '../memory-schema.js';
import { normalizePlatformConfirmations } from '../platform-governance-schema.js';
import {
  normalizeChapterReviewChecks, normalizeChapterReviewSignals,
} from '../chapter-review-schema.js';
import { normalizeChapterPlan } from '../chapter-plan-schema.js';
import { chapterPlanWorldLinkAlignment } from '../chapter-plan-quality.js';
import { normalizeChapterPlanComparison } from '../chapter-plan-review-schema.js';
import {
  normalizeChapterReviewPromiseCandidates,
} from '../chapter-review-promise-schema.js';
import {
  normalizeChapterReviewWorldGateCandidates,
} from '../chapter-review-world-schema.js';
import { normalizeStoryEngine } from '../story-engine-schema.js';
import { normalizePromiseLedger } from '../promise-ledger-schema.js';
import { normalizeCharacterCraft } from '../character-craft-schema.js';
import { normalizeStoredGoldenThreeReview } from '../golden-three-review-schema.js';
import { normalizeStageSummaries } from '../stage-summary-schema.js';
import { contentFingerprint, currentText, isValidVersioned } from './versioned.js';
import { normalizeWorldProgressState } from '../world-progress-schema.js';
import { normalizeChapterHandoff } from '../chapter-handoff-schema.js';

export function createBackupSchema(dependencies) {
  const {
    backupFormat, backupVersion, isObjectRecord, migrateBookTitleInPlace,
    migrateChapterInPlace, normalizeEntityTitle, safeId, serializationSettings,
    storageIdPathKey, titleSources, validDailyWordGoal,
  } = dependencies;

function invalidBackup() {
  throw new Error('BACKUP_INVALID');
}

function backupText(value, maxLength, { optional = false, codePoints = false } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') return invalidBackup();
  // codePoints 用于与模型摘要清洗逻辑一致；先用 UTF-16 长度快速拒绝明显超限输入。
  const length = codePoints
    ? (value.length > maxLength * 2 ? value.length : Array.from(value).length)
    : value.length;
  if (length > maxLength) return invalidBackup();
  return value;
}

function cloneBackupVersioned(value) {
  if (!isValidVersioned(value)) return invalidBackup();
  return { versions: [...value.versions], cursor: value.cursor };
}

function normalizeBackupCharacters(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STORED_CHARACTERS) return invalidBackup();
  const characters = [];
  const seen = new Set();
  for (const character of value) {
    if (!isObjectRecord(character)) return invalidBackup();
    const name = backupText(character.name, MAX_CHARACTER_NAME_CHARS, { codePoints: true });
    const role = backupText(character.role, MAX_CHARACTER_ROLE_CHARS, { codePoints: true });
    const desc = backupText(character.desc, MAX_CHARACTER_DESC_CHARS, { codePoints: true });
    if (!name.trim() || !role.trim()) return invalidBackup();
    const key = `${name}\0${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    characters.push({ name, role, desc });
  }
  return characters;
}

function normalizeBackupMemoryFact(value) {
  if (!isObjectRecord(value) || typeof value.id !== 'string'
    || !MEMORY_ID_PATTERN.test(value.id) || !isMemoryKind(value.kind)
    || !isMemoryFactStatus(value.status) || !Number.isInteger(value.importance)
    || value.importance < 1 || value.importance > 5 || !isObjectRecord(value.source)) {
    return invalidBackup();
  }
  const source = {
    sectionId: backupId(value.source.sectionId),
    chapterId: backupId(value.source.chapterId),
    chapterIndex: value.source.chapterIndex,
    bodyFingerprint: backupText(value.source.bodyFingerprint, 43),
  };
  if (!Number.isInteger(source.chapterIndex) || source.chapterIndex < 1
    || source.chapterIndex > MAX_TOTAL_BOOK_CHAPTERS
    || !/^[A-Za-z0-9_-]{43}$/.test(source.bodyFingerprint)) return invalidBackup();
  const subject = backupText(value.subject, MAX_MEMORY_SUBJECT_CHARS, { codePoints: true });
  const details = normalizeStoredMemoryDetails(value.details, value.kind);
  const aliases = normalizeStoredMemoryAliases(value.aliases, subject);
  if (details === null || aliases === null) return invalidBackup();
  const fact = {
    id: value.id,
    kind: value.kind,
    subject,
    predicate: backupText(value.predicate, MAX_MEMORY_PREDICATE_CHARS, { codePoints: true }),
    object: backupText(value.object, MAX_MEMORY_OBJECT_CHARS, { codePoints: true }),
    evidence: backupText(value.evidence, MAX_MEMORY_EVIDENCE_CHARS, {
      optional: true, codePoints: true,
    }),
    importance: value.importance,
    status: value.status,
    source,
    confirmedAt: backupText(value.confirmedAt, 100),
    updatedAt: backupText(value.updatedAt, 100),
    ...(value.autoAccepted === true ? { autoAccepted: true } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(details ? { details } : {}),
  };
  if (!fact.subject.trim() || !fact.predicate.trim() || !fact.object.trim()
    || !Number.isFinite(Date.parse(fact.confirmedAt))
    || !Number.isFinite(Date.parse(fact.updatedAt))) return invalidBackup();
  return fact;
}

function normalizeBackupBookMemory(value) {
  if (value === undefined) return { facts: [], rejectedCandidateIds: [] };
  if (!isObjectRecord(value) || !Array.isArray(value.facts)
    || value.facts.length > MAX_MEMORY_FACTS_PER_BOOK
    || !Array.isArray(value.rejectedCandidateIds)
    || value.rejectedCandidateIds.length > MAX_MEMORY_REJECTIONS_PER_BOOK) {
    return invalidBackup();
  }
  const facts = value.facts.map(normalizeBackupMemoryFact);
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) return invalidBackup();
  const rejectedCandidateIds = [];
  const rejectedSeen = new Set();
  for (const id of value.rejectedCandidateIds) {
    if (typeof id !== 'string' || !MEMORY_ID_PATTERN.test(id)) return invalidBackup();
    if (!rejectedSeen.has(id)) rejectedCandidateIds.push(id);
    rejectedSeen.add(id);
  }
  return { facts, rejectedCandidateIds };
}

function normalizeBackupBookSectionSummaries(value, sectionIds) {
  if (value === undefined) return {};
  if (!isObjectRecord(value) || Object.keys(value).length > sectionIds.length) {
    return invalidBackup();
  }
  const referenced = new Set(sectionIds);
  const normalized = {};
  for (const [rawSectionId, item] of Object.entries(value)) {
    const sectionId = backupId(rawSectionId);
    if (!referenced.has(sectionId) || !isObjectRecord(item)) return invalidBackup();
    const summary = backupText(
      item.summary, MAX_BOOK_SECTION_SUMMARY_CHARS, { codePoints: true },
    );
    if (!summary) continue;
    Object.defineProperty(normalized, sectionId, {
      value: {
        index: sectionIds.indexOf(sectionId) + 1,
        title: backupText(item.title, MAX_TITLE_CHARS, { optional: true }),
        summary,
      },
      enumerable: true, writable: true, configurable: true,
    });
  }
  return normalized;
}

function normalizeBackupStageSummaries(value, sectionIds) {
  const normalized = normalizeStageSummaries(value, sectionIds);
  return normalized === null ? invalidBackup() : normalized;
}

function normalizeBackupMemoryCandidates(value, bodyFingerprint) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MEMORY_CANDIDATES_PER_CHAPTER) {
    return invalidBackup();
  }
  const candidates = value.map(normalizeStoredMemoryCandidate);
  if (candidates.some((candidate) => !candidate
    || candidate.sourceFingerprint !== bodyFingerprint)) return invalidBackup();
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    return invalidBackup();
  }
  return candidates;
}

function createActiveMemorySourceValidator(book) {
  const pending = new Map();
  for (const fact of book?.memory?.facts ?? []) {
    if (fact.status !== 'active') continue;
    const key = `${fact.source.sectionId}\0${fact.source.chapterId}`;
    const facts = pending.get(key) ?? [];
    facts.push(fact);
    pending.set(key, facts);
  }
  return {
    acceptChapter(sectionId, chapter) {
      const key = `${sectionId}\0${chapter.id}`;
      const facts = pending.get(key);
      if (!facts) return;
      if (facts.some((fact) =>
        (fact.source.bodyFingerprint !== chapter.bodyFingerprint
          && fact.source.bodyFingerprint !== chapter.published?.bodyFingerprint)
        || fact.source.chapterIndex !== chapter.index)) {
        invalidBackup();
      }
      pending.delete(key);
    },
    assertComplete() {
      if (pending.size) invalidBackup();
    },
  };
}

function createActiveWorldGateSourceValidator(book) {
  const pending = new Map();
  for (const gate of book?.settings?.worldProgressState?.gates ?? []) {
    if (gate.status !== 'active') continue;
    const key = `${gate.source.sectionId}\0${gate.source.chapterId}`;
    const gates = pending.get(key) ?? [];
    gates.push(gate);
    pending.set(key, gates);
  }
  return {
    acceptChapter(sectionId, chapter) {
      const key = `${sectionId}\0${chapter.id}`;
      const gates = pending.get(key);
      if (!gates) return;
      if (gates.some((gate) => gate.source.bodyFingerprint !== chapter.bodyFingerprint
        && gate.source.bodyFingerprint !== chapter.published?.bodyFingerprint)) {
        invalidBackup();
      }
      pending.delete(key);
    },
    assertComplete() {
      if (pending.size) invalidBackup();
    },
  };
}

function createActivePromiseEvidenceSourceValidator(book) {
  const pending = new Map();
  for (const entry of book?.settings?.promiseLedger?.entries ?? []) {
    for (const event of entry.progress ?? []) {
      if (event.status !== 'active' || !event.source) continue;
      const key = `${event.source.sectionId}\0${event.source.chapterId}`;
      const events = pending.get(key) ?? [];
      events.push(event);
      pending.set(key, events);
    }
  }
  return {
    acceptChapter(sectionId, chapter) {
      const key = `${sectionId}\0${chapter.id}`;
      const events = pending.get(key);
      if (!events) return;
      const currentContent = currentText(chapter.body);
      const publishedContent = chapter.published?.content;
      if (events.some((event) => {
        const currentMatch = event.source.bodyFingerprint === chapter.bodyFingerprint
          && currentContent.includes(event.evidence);
        const publishedMatch = event.source.bodyFingerprint === chapter.published?.bodyFingerprint
          && typeof publishedContent === 'string' && publishedContent.includes(event.evidence);
        return !currentMatch && !publishedMatch;
      })) invalidBackup();
      pending.delete(key);
    },
    assertComplete() {
      if (pending.size) invalidBackup();
    },
  };
}

function validateBookSectionSummaryEntry(book, section) {
  const item = book?.sectionSummaries?.[section.id];
  if (!item) return;
  const expectedIndex = book.sections.indexOf(section.id) + 1;
  if (expectedIndex < 1
    || item.index !== expectedIndex
    || item.title !== section.title
    || item.summary !== bookSectionSummaryWindow(section.summary)) {
    invalidBackup();
  }
}

function normalizeBackupSectionOutline(value) {
  if (value === undefined) return { content: '', history: [] };
  if (!isObjectRecord(value)
    || typeof value.content !== 'string'
    || value.content.length > MAX_VERSION_TEXT_CHARS
    || !Array.isArray(value.history)
    || value.history.length > MAX_VERSION_HISTORY_ITEMS
    || !value.history.every((text) =>
      typeof text === 'string' && text.length <= MAX_VERSION_TEXT_CHARS)) {
    return invalidBackup();
  }
  return { content: value.content, history: [...value.history] };
}

function normalizeBackupReview(value, body, chapterPlan, sectionOutline) {
  if (value === undefined || value === null) return undefined;
  if (!isObjectRecord(value)
    || !Number.isInteger(value.score) || value.score < 0 || value.score > 100) {
    return invalidBackup();
  }
  const verdict = backupText(value.verdict, 40, { codePoints: true });
  if (!verdict.trim() || !Array.isArray(value.issues)
    || value.issues.length < 1 || value.issues.length > 5
    || !Array.isArray(value.suggestions)
    || value.suggestions.length < 1 || value.suggestions.length > 3) {
    return invalidBackup();
  }
  const issues = value.issues.map((issue) => {
    if (!isObjectRecord(issue)) return invalidBackup();
    const title = backupText(issue.title, 15, { codePoints: true });
    const detail = backupText(issue.detail, 80, { codePoints: true });
    if (!title.trim() || !detail.trim()) return invalidBackup();
    return { title, detail };
  });
  const suggestions = value.suggestions.map((suggestion) => {
    if (!isObjectRecord(suggestion)) return invalidBackup();
    const label = backupText(suggestion.label, 8, { codePoints: true });
    const instruction = backupText(
      suggestion.instruction, MAX_REVIEW_INSTRUCTION_CHARS, { codePoints: true },
    );
    if (!label.trim() || !instruction.trim()) return invalidBackup();
    return { label, instruction };
  });
  const webFictionChecks = normalizeChapterReviewChecks(value.webFictionChecks);
  if (webFictionChecks === null) return invalidBackup();
  const webFictionSignals = normalizeChapterReviewSignals(value.webFictionSignals);
  if (webFictionSignals === null) return invalidBackup();
  const planComparison = normalizeChapterPlanComparison(value.planComparison, {
    chapterPlan,
  });
  if (planComparison === null) return invalidBackup();
  const sourceCursor = value.sourceCursor === undefined ? body.cursor : value.sourceCursor;
  if (!Number.isInteger(sourceCursor) || sourceCursor < 0 || sourceCursor >= body.versions.length) {
    return invalidBackup();
  }
  const promiseLedgerCandidates = normalizeChapterReviewPromiseCandidates(
    value.promiseLedgerCandidates,
    {
      chapterPlan,
      chapterContent: body.versions[sourceCursor],
      allowLegacy: true,
    },
  );
  if (promiseLedgerCandidates === null) return invalidBackup();
  const worldGateCandidates = normalizeChapterReviewWorldGateCandidates(
    value.worldGateCandidates,
    { sectionOutline, chapterContent: body.versions[sourceCursor] },
  );
  if (worldGateCandidates === null) return invalidBackup();
  const sourceFingerprint = value.sourceFingerprint === undefined
    ? contentFingerprint(body.versions[sourceCursor])
    : backupText(value.sourceFingerprint, 128);
  const sourceContextRevision = value.sourceContextRevision === undefined
    ? undefined
    : backupText(value.sourceContextRevision, 43);
  if (sourceContextRevision !== undefined
    && !/^[A-Za-z0-9_-]{43}$/.test(sourceContextRevision)) {
    return invalidBackup();
  }
  const sourcePlanRevision = value.sourcePlanRevision === undefined
    ? undefined
    : backupText(value.sourcePlanRevision, 43);
  if ((sourcePlanRevision !== undefined
      && !/^[A-Za-z0-9_-]{43}$/.test(sourcePlanRevision))
    || (planComparison !== undefined && sourcePlanRevision === undefined)) {
    return invalidBackup();
  }
  const updatedAt = value.updatedAt === undefined ? '' : backupText(value.updatedAt, 100);
  return {
    score: value.score, verdict, issues, suggestions,
    ...(webFictionChecks === undefined ? {} : { webFictionChecks }),
    ...(webFictionSignals === undefined ? {} : { webFictionSignals }),
    ...(planComparison === undefined ? {} : { planComparison }),
    ...(promiseLedgerCandidates === undefined ? {} : { promiseLedgerCandidates }),
    ...(worldGateCandidates === undefined ? {} : { worldGateCandidates }),
    sourceCursor, sourceFingerprint,
    ...(sourceContextRevision === undefined ? {} : { sourceContextRevision }),
    ...(sourcePlanRevision === undefined ? {} : { sourcePlanRevision }),
    updatedAt,
  };
}

function normalizeBackupChapterSummaries(value, chapterIds) {
  if (value === undefined) return {};
  if (!isObjectRecord(value)) return invalidBackup();
  const summaries = {};
  chapterIds.forEach((chapterId, position) => {
    if (!Object.prototype.hasOwnProperty.call(value, chapterId)) return;
    const item = value[chapterId];
    const summary = typeof item === 'string'
      ? backupText(item, MAX_DIGEST_SUMMARY_CHARS, { codePoints: true })
      : isObjectRecord(item)
        ? backupText(item.summary, MAX_DIGEST_SUMMARY_CHARS, { codePoints: true })
        : invalidBackup();
    if (!summary) return;
    Object.defineProperty(summaries, chapterId, {
      value: { index: position + 1, summary },
      enumerable: true, writable: true, configurable: true,
    });
  });
  return summaries;
}

function normalizeBackupPublishedChapter(value) {
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) return invalidBackup();
  const content = backupText(value.content, MAX_VERSION_TEXT_CHARS);
  const bodyFingerprint = backupText(value.bodyFingerprint, 43);
  const publishedAt = backupText(value.publishedAt, 100);
  if (bodyFingerprint !== contentFingerprint(content)
    || !/^[A-Za-z0-9_-]{43}$/.test(bodyFingerprint)
    || !Number.isFinite(Date.parse(publishedAt))
    || !Number.isSafeInteger(value.publicationNumber)
    || value.publicationNumber < 1) return invalidBackup();
  return {
    content, bodyFingerprint, publishedAt,
    publicationNumber: value.publicationNumber,
  };
}

function normalizeBackupBook(book, originalBookId, sectionIds) {
  const sectionSummaries = normalizeBackupBookSectionSummaries(
    book.sectionSummaries, sectionIds,
  );
  const goldenThreeReview = normalizeStoredGoldenThreeReview(
    book.settings.goldenThreeReview, { errorCode: 'BACKUP_INVALID' },
  );
  if (goldenThreeReview) {
    goldenThreeReview.sources = goldenThreeReview.sources.map((source) => ({
      ...source, sectionId: backupId(source.sectionId), chapterId: backupId(source.chapterId),
    }));
  }
  const normalized = {
    id: originalBookId,
    title: backupText(book.title, MAX_TITLE_CHARS),
    titleSource: titleSources.has(book.titleSource) ? book.titleSource : undefined,
    createdAt: backupText(book.createdAt, 100, { optional: true }),
    updatedAt: backupText(book.updatedAt, 100, { optional: true }),
    premise: backupText(book.premise, MAX_PREMISE_CHARS),
    outline: cloneBackupVersioned(book.outline),
    settings: {
      core: {}, history: [], serialization: serializationSettings(book.settings.serialization, {
        errorCode: 'BACKUP_INVALID',
      }),
      storyEngine: normalizeStoryEngine(book.settings.storyEngine, {
        errorCode: 'BACKUP_INVALID', sizeErrorCode: 'BACKUP_INVALID',
      }),
      promiseLedger: normalizePromiseLedger(book.settings.promiseLedger, {
        errorCode: 'BACKUP_INVALID', sizeErrorCode: 'BACKUP_INVALID',
      }),
      characterCraft: normalizeCharacterCraft(book.settings.characterCraft, {
        errorCode: 'BACKUP_INVALID', sizeErrorCode: 'BACKUP_INVALID',
      }),
      worldProgressState: normalizeWorldProgressState(book.settings.worldProgressState, {
        errorCode: 'BACKUP_INVALID', sizeErrorCode: 'BACKUP_INVALID',
      }),
      goldenThreeReview,
    },
    characters: normalizeBackupCharacters(book.characters),
    summary: backupText(book.summary, MAX_BOOK_PROMPT_SUMMARY_CHARS, {
      optional: true, codePoints: true,
    }),
    sectionSummaries,
    stageSummaries: normalizeBackupStageSummaries(book.stageSummaries, sectionIds),
    progress: backupText(book.progress, MAX_DIGEST_PROGRESS_CHARS, {
      optional: true, codePoints: true,
    }),
    sections: [...sectionIds],
    memory: normalizeBackupBookMemory(book.memory),
  };
  for (const field of ['world', 'style', 'constraints', 'pacing']) {
    normalized.settings.core[field] = cloneBackupVersioned(book.settings.core[field]);
  }
  if (Object.keys(sectionSummaries).length) {
    normalized.summary = buildBookSummaryFromSectionSummaries(normalized);
  }
  return migrateBookTitleInPlace(normalized);
}

function normalizeBackupSection(section, sectionId, sectionIndex, chapterIds) {
  return normalizeEntityTitle({
    id: sectionId,
    index: sectionIndex,
    title: backupText(section.title, MAX_TITLE_CHARS),
    titleSource: titleSources.has(section.titleSource) ? section.titleSource : undefined,
    outline: normalizeBackupSectionOutline(section.outline),
    characters: normalizeBackupCharacters(section.characters),
    summary: backupText(section.summary, MAX_SECTION_SUMMARY_CHARS, {
      optional: true, codePoints: true,
    }),
    progress: backupText(section.progress, MAX_DIGEST_PROGRESS_CHARS, {
      optional: true, codePoints: true,
    }),
    chapters: [...chapterIds],
    chapterSummaries: normalizeBackupChapterSummaries(section.chapterSummaries, chapterIds),
  }, '部');
}

function normalizeBackupChapter(chapter, chapterId, chapterIndex, sectionOutline) {
  const body = cloneBackupVersioned(chapter.body);
  const normalized = migrateChapterInPlace({
    id: chapterId,
    index: chapterIndex,
    title: backupText(chapter.title, MAX_TITLE_CHARS),
    titleSource: titleSources.has(chapter.titleSource) ? chapter.titleSource : undefined,
    body,
    characters: normalizeBackupCharacters(chapter.characters),
    summary: backupText(chapter.summary, MAX_DIGEST_SUMMARY_CHARS, {
      optional: true, codePoints: true,
    }),
    progress: backupText(chapter.progress, MAX_DIGEST_PROGRESS_CHARS, {
      optional: true, codePoints: true,
    }),
    handoff: normalizeChapterHandoff(chapter.handoff, {
      errorCode: 'BACKUP_INVALID', sizeErrorCode: 'BACKUP_INVALID',
    }),
    status: 'done',
  });
  normalized.memoryCandidates = normalizeBackupMemoryCandidates(
    chapter.memoryCandidates, normalized.bodyFingerprint,
  );
  normalized.plan = normalizeChapterPlan(chapter.plan, {
    errorCode: 'BACKUP_INVALID', sizeErrorCode: 'BACKUP_INVALID',
  });
  if (sectionOutline !== undefined
    && !chapterPlanWorldLinkAlignment(normalized.plan, sectionOutline).valid) invalidBackup();
  const published = normalizeBackupPublishedChapter(chapter.published);
  if (published) normalized.published = published;
  const review = normalizeBackupReview(
    chapter.review, body, normalized.plan, sectionOutline,
  );
  if (review) normalized.review = review;
  return normalized;
}

function backupId(value) {
  try { return safeId(value); }
  catch { return invalidBackup(); }
}

function validateBackupBook(format, version, book) {
  if (format !== backupFormat || version !== backupVersion || !isObjectRecord(book)) {
    return invalidBackup();
  }
  if (typeof book.title !== 'string' || book.title.length > MAX_TITLE_CHARS
    || typeof book.premise !== 'string' || book.premise.length > MAX_PREMISE_CHARS) {
    return invalidBackup();
  }
  if (!Array.isArray(book.sections) || book.sections.length > MAX_BOOK_SECTIONS) return invalidBackup();
  if (!isValidVersioned(book.outline) || !isObjectRecord(book.settings) || !isObjectRecord(book.settings.core)) {
    return invalidBackup();
  }
  for (const field of ['world', 'style', 'constraints', 'pacing']) {
    if (!isValidVersioned(book.settings.core[field])) return invalidBackup();
  }
  if (book.settings.serialization !== undefined
    && (!isObjectRecord(book.settings.serialization)
      || !validDailyWordGoal(book.settings.serialization.dailyWordGoal))) {
    return invalidBackup();
  }
  if (book.settings.serialization !== undefined) {
    try {
      normalizePlatformConfirmations(book.settings.serialization.platformConfirmations, {
        errorCode: 'BACKUP_INVALID',
      });
    } catch { return invalidBackup(); }
  }

  const originalBookId = backupId(book.id);
  const sectionIds = [];
  const referencedSections = new Set();
  const referencedSectionPaths = new Set();
  for (const rawId of book.sections) {
    const sectionId = backupId(rawId);
    const pathKey = storageIdPathKey(sectionId);
    if (referencedSectionPaths.has(pathKey)) return invalidBackup();
    referencedSections.add(sectionId);
    referencedSectionPaths.add(pathKey);
    sectionIds.push(sectionId);
  }
  const sectionIndexes = new Map(sectionIds.map((sectionId, index) => [sectionId, index + 1]));
  return {
    originalBookId,
    book: normalizeBackupBook(book, originalBookId, sectionIds),
    sectionIds,
    referencedSections,
    sectionIndexes,
  };
}

function validateBackupSection(section, validatedBook, seenSections) {
  if (!isObjectRecord(section)) return invalidBackup();
  const sectionId = backupId(section.id);
  if (!validatedBook.referencedSections.has(sectionId) || seenSections.has(sectionId)) return invalidBackup();
  if (!Array.isArray(section.chapters) || section.chapters.length > MAX_SECTION_CHAPTERS) return invalidBackup();
  if (typeof section.title !== 'string') return invalidBackup();
  const chapterIds = [];
  const referencedChapters = new Set();
  const referencedChapterPaths = new Set();
  for (const rawChapterId of section.chapters) {
    const chapterId = backupId(rawChapterId);
    const pathKey = storageIdPathKey(chapterId);
    if (referencedChapterPaths.has(pathKey)) return invalidBackup();
    referencedChapters.add(chapterId);
    referencedChapterPaths.add(pathKey);
    chapterIds.push(chapterId);
  }
  seenSections.add(sectionId);
  const chapterIndexes = new Map(chapterIds.map((chapterId, index) => [chapterId, index + 1]));
  return {
    sectionId,
    section: normalizeBackupSection(
      section, sectionId, validatedBook.sectionIndexes.get(sectionId), chapterIds,
    ),
    chapterIds,
    referencedChapters,
    chapterIndexes,
  };
}

function validateBackupChapter(chapter, referencedChapters, seenChapters) {
  if (!isObjectRecord(chapter)) return invalidBackup();
  const chapterId = backupId(chapter.id);
  if (!referencedChapters.has(chapterId) || seenChapters.has(chapterId)) return invalidBackup();
  if (typeof chapter.title !== 'string' || !isValidVersioned(chapter.body)) return invalidBackup();
  seenChapters.add(chapterId);
  return chapterId;
}

function validateStoredData(factory) {
  try { return factory(); }
  catch (err) {
    if (err?.message === 'BACKUP_INVALID') throw new Error('STORAGE_DATA_INVALID');
    throw err;
  }
}

function validateStoredBook(book, bookId) {
  const validated = validateStoredData(() =>
    validateBackupBook(backupFormat, backupVersion, book));
  if (validated.originalBookId !== bookId) throw new Error('STORAGE_DATA_INVALID');
  return validated;
}

function validateStoredSection(section, validatedBook, seenSections = new Set()) {
  return validateStoredData(() =>
    validateBackupSection(section, validatedBook, seenSections));
}

function normalizeStoredChapter(chapter, validatedSection, seenChapters = new Set()) {
  return validateStoredData(() => {
    const chapterId = validateBackupChapter(
      chapter, validatedSection.referencedChapters, seenChapters,
    );
    return normalizeBackupChapter(
      chapter, chapterId, validatedSection.chapterIndexes.get(chapterId),
    );
  });
}

function validateBookBackup(snapshot) {
  if (!isObjectRecord(snapshot) || !Array.isArray(snapshot.sections)) return invalidBackup();
  const validatedBook = validateBackupBook(snapshot.format, snapshot.version, snapshot.book);

  const bundles = new Map();
  const seenSections = new Set();
  let totalChapters = 0;
  for (const bundle of snapshot.sections) {
    if (!isObjectRecord(bundle) || !isObjectRecord(bundle.section) || !Array.isArray(bundle.chapters)) return invalidBackup();
    const validatedSection = validateBackupSection(
      bundle.section, validatedBook, seenSections,
    );
    if (bundle.chapters.length !== validatedSection.referencedChapters.size) return invalidBackup();
    const chapters = new Map();
    const seenChapters = new Set();
    for (const chapter of bundle.chapters) {
      const chapterId = validateBackupChapter(
        chapter, validatedSection.referencedChapters, seenChapters,
      );
      chapters.set(chapterId, normalizeBackupChapter(
        chapter, chapterId, validatedSection.chapterIndexes.get(chapterId),
        validatedSection.section.outline?.content,
      ));
    }
    totalChapters += chapters.size;
    if (totalChapters > MAX_TOTAL_BACKUP_CHAPTERS) return invalidBackup();
    validateBookSectionSummaryEntry(validatedBook.book, validatedSection.section);
    bundles.set(validatedSection.sectionId, { section: validatedSection.section, chapters });
  }
  if (bundles.size !== validatedBook.sectionIds.length) return invalidBackup();
  const memorySources = createActiveMemorySourceValidator(validatedBook.book);
  const worldGateSources = createActiveWorldGateSourceValidator(validatedBook.book);
  const promiseEvidenceSources = createActivePromiseEvidenceSourceValidator(validatedBook.book);
  for (const [sectionId, bundle] of bundles) {
    for (const chapter of bundle.chapters.values()) {
      memorySources.acceptChapter(sectionId, chapter);
      worldGateSources.acceptChapter(sectionId, chapter);
      promiseEvidenceSources.acceptChapter(sectionId, chapter);
    }
  }
  memorySources.assertComplete();
  worldGateSources.assertComplete();
  promiseEvidenceSources.assertComplete();
  return { ...validatedBook, bundles };
}

function canonicalizeBookBackup(snapshot) {
  const validated = validateBookBackup(snapshot);
  return {
    format: backupFormat,
    version: backupVersion,
    exportedAt: typeof snapshot.exportedAt === 'string'
      ? snapshot.exportedAt.slice(0, 100)
      : new Date().toISOString(),
    book: validated.book,
    sections: validated.sectionIds.map((sectionId) => {
      const bundle = validated.bundles.get(sectionId);
      return {
        section: bundle.section,
        chapters: bundle.section.chapters.map((chapterId) => bundle.chapters.get(chapterId)),
      };
    }),
  };
}


  return Object.freeze({
    backupText,
    canonicalizeBookBackup,
    createActiveMemorySourceValidator,
    createActivePromiseEvidenceSourceValidator,
    createActiveWorldGateSourceValidator,
    invalidBackup,
    normalizeBackupBook,
    normalizeBackupBookMemory,
    normalizeBackupChapter,
    normalizeBackupStageSummaries,
    normalizeBackupSection,
    normalizeStoredChapter,
    normalizeStoredDigestSummary: (value) => validateStoredData(() => backupText(
      value, MAX_DIGEST_SUMMARY_CHARS, { codePoints: true },
    )),
    validateBackupBook,
    validateBackupChapter,
    validateBackupSection,
    validateBookBackup,
    validateBookSectionSummaryEntry,
    validateStoredBook,
    validateStoredData,
    validateStoredSection,
  });
}
