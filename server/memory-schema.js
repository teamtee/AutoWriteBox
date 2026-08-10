import {
  MAX_MEMORY_CANDIDATES_PER_CHAPTER, MAX_MEMORY_EVIDENCE_CHARS,
  MAX_MEMORY_DETAIL_CHARS, MAX_MEMORY_DETAIL_PARTICIPANTS,
  MAX_MEMORY_DETAILS_TOTAL_CHARS,
  MAX_MEMORY_OBJECT_CHARS, MAX_MEMORY_PREDICATE_CHARS, MAX_MEMORY_SUBJECT_CHARS,
} from './limits.js';

export const MEMORY_KINDS = Object.freeze([
  'character', 'relationship', 'ability', 'item', 'location',
  'timeline', 'faction', 'foreshadowing', 'knowledge', 'other',
]);
const MEMORY_KIND_SET = new Set(MEMORY_KINDS);
export const MEMORY_ID_PATTERN = /^memory_[0-9a-f]{32}$/;
export const MEMORY_FACT_STATUSES = Object.freeze(['active', 'stale', 'superseded']);
const MEMORY_FACT_STATUS_SET = new Set(MEMORY_FACT_STATUSES);
const MEMORY_DETAIL_FIELDS = Object.freeze({
  relationship: ['target', 'relationType', 'strength', 'visibility', 'changeReason'],
  ability: ['eventType', 'cost', 'limitation', 'time', 'location'],
  item: ['eventType', 'owner', 'origin', 'quantity', 'status', 'lastLocation', 'time'],
  location: ['eventType', 'from', 'to', 'time', 'location'],
  timeline: ['eventType', 'time', 'order', 'duration', 'participants', 'location'],
  faction: ['participants', 'role', 'alignment', 'goal', 'relations', 'territory'],
  foreshadowing: [
    'foreshadowStatus', 'readerKnowledge', 'plannedPayoff', 'actualPayoff', 'dueChapter',
  ],
  knowledge: ['knowledgeOwner', 'knower', 'information', 'learnedAt'],
});
const MEMORY_DETAIL_ENUMS = Object.freeze({
  strength: new Set(['weak', 'medium', 'strong', 'unknown']),
  visibility: new Set(['public', 'limited', 'secret', 'unknown']),
  eventType: new Set([
    'acquired', 'upgraded', 'used', 'transferred', 'damaged', 'destroyed',
    'moved', 'status', 'occurred', 'other',
  ]),
  foreshadowStatus: new Set(['planted', 'progressing', 'resolved', 'abandoned']),
  knowledgeOwner: new Set(['author', 'reader', 'character']),
});

function cleanText(value, limit) {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, limit).join('')
    : '';
}

function cleanMemoryDetailParticipants(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, MAX_MEMORY_DETAIL_PARTICIPANTS).flatMap((item) => {
    const participant = cleanText(item, MAX_MEMORY_SUBJECT_CHARS);
    if (!participant || seen.has(participant)) return [];
    seen.add(participant);
    return [participant];
  });
}

export function sanitizeMemoryDetails(value, kind) {
  const allowed = MEMORY_DETAIL_FIELDS[kind];
  if (!allowed || !value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const details = {};
  let usedChars = 0;
  for (const field of allowed) {
    if (field === 'participants') {
      const participants = cleanMemoryDetailParticipants(value[field]);
      const selected = [];
      for (const participant of participants) {
        const length = Array.from(participant).length;
        if (usedChars + length > MAX_MEMORY_DETAILS_TOTAL_CHARS) break;
        selected.push(participant);
        usedChars += length;
      }
      if (selected.length) details[field] = selected;
      continue;
    }
    const text = cleanText(value[field], MAX_MEMORY_DETAIL_CHARS);
    if (!text) continue;
    const allowedValues = MEMORY_DETAIL_ENUMS[field];
    if (allowedValues && !allowedValues.has(text)) continue;
    const length = Array.from(text).length;
    if (usedChars + length > MAX_MEMORY_DETAILS_TOTAL_CHARS) continue;
    details[field] = text;
    usedChars += length;
  }
  return Object.keys(details).length ? details : undefined;
}

export function normalizeStoredMemoryDetails(value, kind) {
  if (value === undefined) return undefined;
  const allowed = MEMORY_DETAIL_FIELDS[kind];
  if (!allowed || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !allowed.includes(field))) return null;
  const details = {};
  let usedChars = 0;
  for (const field of allowed) {
    if (value[field] === undefined) continue;
    if (field === 'participants') {
      if (!Array.isArray(value[field])
        || value[field].length > MAX_MEMORY_DETAIL_PARTICIPANTS) return null;
      const participants = cleanMemoryDetailParticipants(value[field]);
      if (participants.length !== value[field].length) return null;
      usedChars += participants.reduce(
        (total, participant) => total + Array.from(participant).length, 0,
      );
      if (usedChars > MAX_MEMORY_DETAILS_TOTAL_CHARS) return null;
      if (participants.length) details[field] = participants;
      continue;
    }
    if (typeof value[field] !== 'string') return null;
    const text = cleanText(value[field], MAX_MEMORY_DETAIL_CHARS);
    if (!text || text !== value[field]) return null;
    const allowedValues = MEMORY_DETAIL_ENUMS[field];
    if (allowedValues && !allowedValues.has(text)) return null;
    usedChars += Array.from(text).length;
    if (usedChars > MAX_MEMORY_DETAILS_TOTAL_CHARS) return null;
    details[field] = text;
  }
  return Object.keys(details).length ? details : null;
}

export function sanitizeMemoryCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MEMORY_CANDIDATES_PER_CHAPTER).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !MEMORY_KIND_SET.has(item.kind)) return [];
    const candidate = {
      kind: item.kind,
      subject: cleanText(item.subject, MAX_MEMORY_SUBJECT_CHARS),
      predicate: cleanText(item.predicate, MAX_MEMORY_PREDICATE_CHARS),
      object: cleanText(item.object, MAX_MEMORY_OBJECT_CHARS),
      evidence: cleanText(item.evidence, MAX_MEMORY_EVIDENCE_CHARS),
      importance: Number.isInteger(item.importance)
        ? Math.max(1, Math.min(5, item.importance)) : 3,
    };
    const details = sanitizeMemoryDetails(item.details, item.kind);
    if (details) candidate.details = details;
    // 关系三元组本身已经包含两端和类型；即使兼容模型漏掉 details，
    // 也能在不猜测新事实的前提下形成结构化关系边。
    if (item.kind === 'relationship') {
      candidate.details = sanitizeMemoryDetails({
        target: candidate.object,
        relationType: candidate.predicate,
        ...(candidate.evidence ? { changeReason: candidate.evidence } : {}),
        ...candidate.details,
      }, item.kind);
    }
    return candidate.subject && candidate.predicate && candidate.object
      ? [candidate] : [];
  });
}

export function normalizeStoredMemoryCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !MEMORY_ID_PATTERN.test(value.id)
    || typeof value.sourceFingerprint !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value.sourceFingerprint)
    || typeof value.extractedAt !== 'string' || !Number.isFinite(Date.parse(value.extractedAt))) {
    return null;
  }
  const [candidate] = sanitizeMemoryCandidates([value]);
  const details = normalizeStoredMemoryDetails(value.details, candidate?.kind);
  if (details === null) return null;
  return candidate ? {
    id: value.id,
    ...candidate,
    ...(details ? { details } : {}),
    sourceFingerprint: value.sourceFingerprint,
    extractedAt: value.extractedAt,
  } : null;
}

export function isMemoryKind(value) { return MEMORY_KIND_SET.has(value); }
export function isMemoryFactStatus(value) { return MEMORY_FACT_STATUS_SET.has(value); }
