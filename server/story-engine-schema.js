import { createHash } from 'node:crypto';
import { MAX_STORY_ENGINE_FIELD_CHARS } from './limits.js';

export const STORY_ENGINE_FIELDS = Object.freeze([
  'readerExperience', 'protagonistAction', 'progression', 'cost', 'escalation',
]);

export function emptyStoryEngine() {
  return {
    readerExperience: '', protagonistAction: '', progression: '', cost: '', escalation: '',
  };
}

export function normalizeStoryEngine(value, {
  errorCode = 'BAD_STORY_ENGINE',
  sizeErrorCode = 'STORY_ENGINE_TOO_LARGE',
} = {}) {
  if (value === undefined) return emptyStoryEngine();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  const normalized = emptyStoryEngine();
  for (const field of STORY_ENGINE_FIELDS) {
    const raw = value[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') throw new Error(errorCode);
    const text = raw.trim();
    if (text.length > MAX_STORY_ENGINE_FIELD_CHARS * 2
      || Array.from(text).length > MAX_STORY_ENGINE_FIELD_CHARS) {
      throw new Error(sizeErrorCode);
    }
    normalized[field] = text;
  }
  return normalized;
}

export function storyEngineRevision(value) {
  const engine = normalizeStoryEngine(value);
  return createHash('sha256').update(JSON.stringify(engine)).digest('base64url');
}

export function storyEngineView(value) {
  const engine = normalizeStoryEngine(value);
  return {
    ...engine,
    revision: storyEngineRevision(engine),
    isEmpty: STORY_ENGINE_FIELDS.every((field) => !engine[field]),
  };
}
