import { createHash } from 'node:crypto';
import {
  MAX_CHARACTER_CRAFT_CONTEXT_CHARS, MAX_CHARACTER_CRAFT_ENTRIES,
  MAX_CHARACTER_CRAFT_EVENT_CHARS, MAX_CHARACTER_CRAFT_FIELD_CHARS,
  MAX_CHARACTER_CRAFT_NAME_CHARS, MAX_CHARACTER_CRAFT_NOTES_CHARS,
  MAX_RELATIONSHIP_CRAFT_ENTRIES, MAX_RELATIONSHIP_TEMPERATURE_EVENTS,
  MAX_TOTAL_BOOK_CHAPTERS,
} from './limits.js';
import { createSubstringLookup } from './substring-index.js';

export const CHARACTER_GUIDE_ID_PATTERN = /^charcraft_[0-9a-f]{32}$/;
export const RELATIONSHIP_GUIDE_ID_PATTERN = /^relcraft_[0-9a-f]{32}$/;
export const TEMPERATURE_EVENT_ID_PATTERN = /^relchange_[0-9a-f]{32}$/;

function fail(code) { throw new Error(code); }

function cleanText(value, maxLength, errorCode, sizeErrorCode, { required = false } = {}) {
  if (value === undefined) value = '';
  if (typeof value !== 'string') fail(errorCode);
  const text = value.trim();
  if (value.length > maxLength * 2 || Array.from(text).length > maxLength) fail(sizeErrorCode);
  if (required && !text) fail(errorCode);
  return text;
}

function chapterNumber(value, errorCode) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOTAL_BOOK_CHAPTERS) fail(errorCode);
  return value;
}

function importance(value, errorCode) {
  if (!Number.isInteger(value) || value < 1 || value > 5) fail(errorCode);
  return value;
}

function temperature(value, errorCode) {
  if (!Number.isInteger(value) || value < -5 || value > 5) fail(errorCode);
  return value;
}

function timestamp(value, errorCode) {
  if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value))) {
    fail(errorCode);
  }
  return value;
}

export function emptyCharacterCraft() { return { characters: [], relationships: [] }; }

export function normalizeCharacterGuideInput(value, {
  errorCode = 'BAD_CHARACTER_GUIDE', sizeErrorCode = 'CHARACTER_CRAFT_TOO_LARGE',
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !CHARACTER_GUIDE_ID_PATTERN.test(value.id)) {
    fail(errorCode);
  }
  const guide = {
    id: value.id,
    name: cleanText(
      value.name, MAX_CHARACTER_CRAFT_NAME_CHARS, errorCode, sizeErrorCode, { required: true },
    ),
    importance: importance(value.importance, errorCode),
    asOfChapter: chapterNumber(value.asOfChapter, errorCode),
    currentDesire: cleanText(
      value.currentDesire, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode,
    ),
    fear: cleanText(value.fear, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode),
    secret: cleanText(value.secret, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode),
    pressureResponse: cleanText(
      value.pressureResponse, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode,
    ),
    speechPattern: cleanText(
      value.speechPattern, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode,
    ),
    speechAvoid: cleanText(
      value.speechAvoid, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode,
    ),
    notes: cleanText(
      value.notes, MAX_CHARACTER_CRAFT_NOTES_CHARS, errorCode, sizeErrorCode,
    ),
  };
  if (![guide.currentDesire, guide.fear, guide.secret, guide.pressureResponse,
    guide.speechPattern, guide.speechAvoid, guide.notes].some(Boolean)) fail(errorCode);
  return guide;
}

function normalizeTemperatureChanges(value, errorCode, sizeErrorCode) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(errorCode);
  if (value.length > MAX_RELATIONSHIP_TEMPERATURE_EVENTS) fail(sizeErrorCode);
  const ids = new Set();
  return value.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.id !== 'string' || !TEMPERATURE_EVENT_ID_PATTERN.test(event.id)
      || ids.has(event.id)) fail(errorCode);
    ids.add(event.id);
    return {
      id: event.id,
      chapter: chapterNumber(event.chapter, errorCode),
      temperature: temperature(event.temperature, errorCode),
      reason: cleanText(
        event.reason, MAX_CHARACTER_CRAFT_EVENT_CHARS, errorCode, sizeErrorCode,
        { required: true },
      ),
    };
  }).map((event) => {
    if (event.chapter === null) fail(errorCode);
    return event;
  });
}

export function normalizeRelationshipGuideInput(value, {
  errorCode = 'BAD_RELATIONSHIP_GUIDE', sizeErrorCode = 'CHARACTER_CRAFT_TOO_LARGE',
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !RELATIONSHIP_GUIDE_ID_PATTERN.test(value.id)) {
    fail(errorCode);
  }
  const from = cleanText(
    value.from, MAX_CHARACTER_CRAFT_NAME_CHARS, errorCode, sizeErrorCode, { required: true },
  );
  const to = cleanText(
    value.to, MAX_CHARACTER_CRAFT_NAME_CHARS, errorCode, sizeErrorCode, { required: true },
  );
  if (from === to) fail(errorCode);
  const guide = {
    id: value.id, from, to,
    importance: importance(value.importance, errorCode),
    asOfChapter: chapterNumber(value.asOfChapter, errorCode),
    temperature: temperature(value.temperature, errorCode),
    surfaceState: cleanText(
      value.surfaceState, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode,
    ),
    privateTension: cleanText(
      value.privateTension, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode,
    ),
    desiredDirection: cleanText(
      value.desiredDirection, MAX_CHARACTER_CRAFT_FIELD_CHARS, errorCode, sizeErrorCode,
    ),
    changes: normalizeTemperatureChanges(value.changes, errorCode, sizeErrorCode),
    notes: cleanText(
      value.notes, MAX_CHARACTER_CRAFT_NOTES_CHARS, errorCode, sizeErrorCode,
    ),
  };
  for (let index = 1; index < guide.changes.length; index += 1) {
    if (guide.changes[index].chapter < guide.changes[index - 1].chapter) fail(errorCode);
  }
  if (guide.changes.length) {
    const latest = guide.changes.at(-1);
    if (latest.temperature !== guide.temperature
      || (guide.asOfChapter !== null && latest.chapter > guide.asOfChapter)) fail(errorCode);
  }
  if (![guide.surfaceState, guide.privateTension, guide.desiredDirection, guide.notes]
    .some(Boolean) && !guide.changes.length) fail(errorCode);
  return guide;
}

function normalizeStored(input, normalizer, errorCode, sizeErrorCode) {
  const normalized = normalizer(input, { errorCode, sizeErrorCode });
  return {
    ...normalized,
    createdAt: timestamp(input.createdAt, errorCode),
    updatedAt: timestamp(input.updatedAt, errorCode),
  };
}

export function normalizeCharacterCraft(value, {
  errorCode = 'BAD_CHARACTER_CRAFT', sizeErrorCode = 'CHARACTER_CRAFT_TOO_LARGE',
} = {}) {
  if (value === undefined) return emptyCharacterCraft();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.characters) || !Array.isArray(value.relationships)) fail(errorCode);
  if (value.characters.length > MAX_CHARACTER_CRAFT_ENTRIES
    || value.relationships.length > MAX_RELATIONSHIP_CRAFT_ENTRIES) fail(sizeErrorCode);
  const ids = new Set();
  const normalizeList = (items, normalizer) => items.map((item) => {
    const entry = normalizeStored(item, normalizer, errorCode, sizeErrorCode);
    if (ids.has(entry.id)) fail(errorCode);
    ids.add(entry.id);
    return entry;
  });
  return {
    characters: normalizeList(value.characters, normalizeCharacterGuideInput),
    relationships: normalizeList(value.relationships, normalizeRelationshipGuideInput),
  };
}

export function characterCraftRevision(value) {
  const craft = normalizeCharacterCraft(value);
  return createHash('sha256').update(JSON.stringify(craft)).digest('base64url');
}

export function characterCraftView(value) {
  const craft = normalizeCharacterCraft(value);
  return { ...craft, revision: characterCraftRevision(craft) };
}

function temperatureLabel(value) {
  if (value <= -4) return '强烈敌对';
  if (value <= -2) return '排斥/不信任';
  if (value === -1) return '轻微疏离';
  if (value === 0) return '中性/未定';
  if (value === 1) return '轻微靠近';
  if (value <= 3) return '信任/亲近';
  return '高度依恋/同盟';
}

function characterRow(guide) {
  const fields = [
    guide.currentDesire && `当前欲望=${guide.currentDesire}`,
    guide.fear && `恐惧=${guide.fear}`,
    guide.secret && `作者掌握的秘密=${guide.secret}`,
    guide.pressureResponse && `受压反应=${guide.pressureResponse}`,
    guide.speechPattern && `说话习惯=${guide.speechPattern}`,
    guide.speechAvoid && `避免的说话方式=${guide.speechAvoid}`,
    guide.notes && `导演备注=${guide.notes}`,
  ].filter(Boolean).join('；');
  return `- [人物][重要度${guide.importance}] ${guide.name}`
    + `${guide.asOfChapter ? `（截至第${guide.asOfChapter}章）` : ''}：${fields}`;
}

function relationshipRow(guide) {
  const recent = guide.changes.slice(-3)
    .map((event) => `第${event.chapter}章→${event.temperature}（${event.reason}）`).join('；');
  const fields = [
    `当前温度=${guide.temperature}（${temperatureLabel(guide.temperature)}）`,
    guide.surfaceState && `表面关系=${guide.surfaceState}`,
    guide.privateTension && `私下张力=${guide.privateTension}`,
    guide.desiredDirection && `下一步关系方向=${guide.desiredDirection}`,
    recent && `最近变化=${recent}`,
    guide.notes && `导演备注=${guide.notes}`,
  ].filter(Boolean).join('；');
  return `- [关系][重要度${guide.importance}] ${guide.from} ↔ ${guide.to}`
    + `${guide.asOfChapter ? `（截至第${guide.asOfChapter}章）` : ''}：${fields}`;
}

export function generationCharacterCraftRows(value, {
  relevantText = '', maxChars = MAX_CHARACTER_CRAFT_CONTEXT_CHARS,
} = {}) {
  const craft = normalizeCharacterCraft(value);
  const limit = Number.isInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_CHARACTER_CRAFT_CONTEXT_CHARS;
  const contains = createSubstringLookup(relevantText, {
    estimatedPatternCount: craft.characters.length + craft.relationships.length * 2,
  });
  const rank = (entry, names) => ({
    entry,
    relevant: Boolean(relevantText) && names.some((name) => contains(name)),
    updatedAt: Date.parse(entry.updatedAt) || 0,
  });
  const ranked = [
    ...craft.characters.map((entry) => ({ ...rank(entry, [entry.name]), row: characterRow(entry) })),
    ...craft.relationships.map((entry) => ({
      ...rank(entry, [entry.from, entry.to]), row: relationshipRow(entry),
    })),
  ].sort((left, right) => Number(right.relevant) - Number(left.relevant)
    || right.entry.importance - left.entry.importance
    || right.updatedAt - left.updatedAt);
  const relevant = ranked.filter((item) => item.relevant);
  // 有明确登场线索时只发送相关人物及其关系，尤其避免把无关人物的作者秘密
  // 塞进当前场景。还没有前情/策划可供匹配时，才回退到最重要的少量导演卡。
  const candidates = relevant.length ? relevant : ranked.slice(0, 5);
  const rows = [];
  let used = 0;
  for (const item of candidates) {
    const cost = item.row.length + (rows.length ? 1 : 0);
    if (used + cost > limit) continue;
    rows.push(item.row);
    used += cost;
  }
  if (rows.length < ranked.length) {
    const omitted = '- …其它不相关或较低优先级人物导演卡未发送…';
    if (used + omitted.length + (rows.length ? 1 : 0) <= limit) rows.push(omitted);
  }
  return rows;
}
