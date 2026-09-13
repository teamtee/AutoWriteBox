import { extractFirstJsonObject } from './llm.js';
import {
  MAX_CHARACTER_CRAFT_FIELD_CHARS, MAX_CHARACTER_CRAFT_NAME_CHARS,
  MAX_CHARACTER_CRAFT_NOTES_CHARS, MAX_PROMISE_NOTES_CHARS,
  MAX_PROMISE_TEXT_CHARS, MAX_TOTAL_BOOK_CHAPTERS,
} from './limits.js';
import { STORY_ENGINE_FIELDS, normalizeStoryEngine } from './story-engine-schema.js';
import { PROMISE_KINDS } from './promise-ledger-schema.js';

const MAX_DRAFT_CHARACTERS = 8;
const MAX_DRAFT_RELATIONSHIPS = 8;
const MAX_DRAFT_PROMISES = 8;
const kindSet = new Set(PROMISE_KINDS);

function clip(value, maxLength) {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, maxLength).join('');
}

function integerInRange(value, min, max, fallback) {
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function chapterInRange(value, fallback) {
  return integerInRange(value, 1, MAX_TOTAL_BOOK_CHAPTERS, fallback);
}

export function extractStoryEngineDraft(text) {
  const parsed = extractFirstJsonObject(text);
  if (!parsed) return null;
  const raw = parsed.storyEngine && typeof parsed.storyEngine === 'object'
    ? parsed.storyEngine : parsed;
  try {
    const engine = normalizeStoryEngine(raw);
    return STORY_ENGINE_FIELDS.every((field) => engine[field]) ? engine : null;
  } catch {
    return null;
  }
}

export function extractCharacterCraftDraft(text, { asOfChapter = 1 } = {}) {
  const parsed = extractFirstJsonObject(text);
  if (!parsed || !Array.isArray(parsed.characters)) return null;
  const chapter = chapterInRange(asOfChapter, 1);
  const characters = [];
  const names = new Set();
  for (const item of parsed.characters.slice(0, MAX_DRAFT_CHARACTERS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = clip(item.name, MAX_CHARACTER_CRAFT_NAME_CHARS);
    if (!name || names.has(name)) continue;
    const guide = {
      name,
      importance: integerInRange(item.importance, 1, 5, 4),
      asOfChapter: chapter,
      currentDesire: clip(item.currentDesire, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      fear: clip(item.fear, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      secret: clip(item.secret, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      pressureResponse: clip(item.pressureResponse, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      speechPattern: clip(item.speechPattern, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      speechAvoid: clip(item.speechAvoid, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      notes: clip(item.notes, MAX_CHARACTER_CRAFT_NOTES_CHARS),
    };
    if (!guide.currentDesire && !guide.fear && !guide.pressureResponse
      && !guide.speechPattern) continue;
    names.add(name);
    characters.push(guide);
  }
  if (!characters.length) return null;
  const relationships = [];
  const seenPairs = new Set();
  for (const item of (Array.isArray(parsed.relationships) ? parsed.relationships : [])
    .slice(0, MAX_DRAFT_RELATIONSHIPS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const from = clip(item.from, MAX_CHARACTER_CRAFT_NAME_CHARS);
    const to = clip(item.to, MAX_CHARACTER_CRAFT_NAME_CHARS);
    if (!from || !to || from === to || !names.has(from) || !names.has(to)) continue;
    const pair = [from, to].sort().join('\0');
    if (seenPairs.has(pair)) continue;
    const relation = {
      from, to,
      importance: integerInRange(item.importance, 1, 5, 3),
      asOfChapter: chapter,
      temperature: integerInRange(item.temperature, -5, 5, 0),
      surfaceState: clip(item.surfaceState, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      privateTension: clip(item.privateTension, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      desiredDirection: clip(item.desiredDirection, MAX_CHARACTER_CRAFT_FIELD_CHARS),
      notes: clip(item.notes, MAX_CHARACTER_CRAFT_NOTES_CHARS),
    };
    if (!relation.surfaceState && !relation.privateTension
      && !relation.desiredDirection) continue;
    seenPairs.add(pair);
    relationships.push(relation);
  }
  return { characters, relationships };
}

export function extractPromiseLedgerDraft(text, { startChapter = 1 } = {}) {
  const parsed = extractFirstJsonObject(text);
  const rows = Array.isArray(parsed?.entries) ? parsed.entries
    : Array.isArray(parsed?.promises) ? parsed.promises : null;
  if (!rows) return null;
  const fallbackStart = Number.isInteger(startChapter)
    ? Math.min(MAX_TOTAL_BOOK_CHAPTERS, Math.max(1, startChapter))
    : 1;
  const entries = [];
  const seen = new Set();
  for (const item of rows.slice(0, MAX_DRAFT_PROMISES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const promise = clip(item.promise, MAX_PROMISE_TEXT_CHARS);
    if (!promise || seen.has(promise)) continue;
    const expectedStartChapter = Math.max(
      fallbackStart, chapterInRange(item.expectedStartChapter, fallbackStart),
    );
    const defaultEndChapter = Math.min(
      MAX_TOTAL_BOOK_CHAPTERS, expectedStartChapter + 2,
    );
    const expectedEndChapter = Math.min(
      MAX_TOTAL_BOOK_CHAPTERS,
      Math.max(
        expectedStartChapter,
        chapterInRange(item.expectedEndChapter, defaultEndChapter),
      ),
    );
    const entry = {
      kind: kindSet.has(item.kind) ? item.kind : 'main',
      importance: integerInRange(item.importance, 1, 5, 3),
      promise,
      expectedStartChapter,
      expectedEndChapter,
      notes: clip(item.notes, MAX_PROMISE_NOTES_CHARS),
    };
    seen.add(promise);
    entries.push(entry);
  }
  return entries.length ? entries : null;
}
