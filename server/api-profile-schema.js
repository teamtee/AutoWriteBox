import {
  MAX_API_BOOK_BINDINGS, MAX_API_PROFILES, MAX_API_PROFILE_MODELS, MAX_API_PROFILE_NAME_CHARS,
  DEFAULT_MODEL_CONTEXT_CHARS, MAX_API_PROFILE_NOTE_CHARS, MAX_CONFIG_MODEL_CHARS,
  MAX_MODEL_CONTEXT_CHARS, MIN_MODEL_CONTEXT_CHARS,
} from './limits.js';
import { normalizeLlmConfig } from './llm-config.js';

export const API_PROFILE_ID_PATTERN = /^profile_[0-9a-f]{32}$/;
export const API_MODEL_TASKS = Object.freeze([
  'chapter', 'outline', 'digest', 'review', 'title',
]);
const API_MODEL_TASK_SET = new Set(API_MODEL_TASKS);
const API_BOOK_BINDING_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function emptyApiTaskRoutes() {
  return Object.fromEntries(API_MODEL_TASKS.map((task) => [task, null]));
}

function cleanText(value, limit) {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, limit).join('') : '';
}

export function normalizeApiProfileModels(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_API_PROFILE_MODELS) {
    throw new Error('BAD_API_PROFILE_MODELS');
  }
  const models = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length > MAX_CONFIG_MODEL_CHARS) {
      throw new Error('BAD_API_PROFILE_MODELS');
    }
    const model = normalizeLlmConfig({
      baseUrl: 'https://profile-validation.invalid/v1', model: raw, apiKey: '',
    }).model;
    if (!seen.has(model)) models.push(model);
    seen.add(model);
  }
  if (!models.length) throw new Error('BAD_API_PROFILE_MODELS');
  return models;
}

export function normalizeApiModelContextChars(value, models, {
  stored = false,
} = {}) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    if (stored) return null;
    throw new Error('BAD_MODEL_CONTEXT_CHARS');
  }
  const raw = value ?? {};
  if (Object.keys(raw).some((model) => !models.includes(model))) {
    if (stored) return null;
    throw new Error('BAD_MODEL_CONTEXT_CHARS');
  }
  const normalized = {};
  for (const model of models) {
    const chars = raw[model] ?? DEFAULT_MODEL_CONTEXT_CHARS;
    if (!Number.isInteger(chars)
      || chars < MIN_MODEL_CONTEXT_CHARS || chars > MAX_MODEL_CONTEXT_CHARS) {
      if (stored) return null;
      throw new Error('BAD_MODEL_CONTEXT_CHARS');
    }
    normalized[model] = chars;
  }
  return normalized;
}

export function normalizeApiProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !API_PROFILE_ID_PATTERN.test(value.id)) return null;
  const name = cleanText(value.name, MAX_API_PROFILE_NAME_CHARS);
  const note = cleanText(value.note, MAX_API_PROFILE_NOTE_CHARS);
  if (!name) return null;
  let models;
  let modelContextChars;
  let connection;
  try {
    models = normalizeApiProfileModels(value.models);
    modelContextChars = normalizeApiModelContextChars(
      value.modelContextChars, models, { stored: true },
    );
    if (!modelContextChars) return null;
    const selectedModel = typeof value.selectedModel === 'string'
      ? value.selectedModel.trim() : '';
    if (!models.includes(selectedModel)) return null;
    connection = normalizeLlmConfig({
      baseUrl: value.baseUrl, model: selectedModel, apiKey: value.apiKey,
    });
  } catch { return null; }
  const createdAt = typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : '';
  const updatedAt = typeof value.updatedAt === 'string'
    && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : '';
  if (!createdAt || !updatedAt) return null;
  return {
    id: value.id, name, note, baseUrl: connection.baseUrl, apiKey: connection.apiKey,
    models, modelContextChars, selectedModel: connection.model, createdAt, updatedAt,
  };
}

export function normalizeApiProfileLibrary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_API_PROFILES
    || (value.activeProfileId !== null && typeof value.activeProfileId !== 'string')) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  const profiles = value.profiles.map(normalizeApiProfile);
  if (profiles.some((profile) => !profile)) throw new Error('STORAGE_DATA_INVALID');
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length
    || (value.activeProfileId !== null && !ids.has(value.activeProfileId))) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  const taskRoutes = normalizeApiTaskRoutes(value.taskRoutes, profiles, { allowMissing: true });
  const bookBindings = normalizeApiBookBindings(
    value.bookBindings, profiles, { allowMissing: true },
  );
  return {
    version: 1, activeProfileId: value.activeProfileId, profiles, taskRoutes, bookBindings,
  };
}

function normalizeApiModelRoute(route, profilesById, errorCode) {
  if (!route || typeof route !== 'object' || Array.isArray(route)
    || typeof route.profileId !== 'string' || typeof route.model !== 'string') {
    throw new Error(errorCode);
  }
  const profile = profilesById.get(route.profileId);
  if (!profile || !profile.models.includes(route.model)) throw new Error(errorCode);
  return { profileId: profile.id, model: route.model };
}

export function normalizeApiTaskRoutes(value, profiles, { allowMissing = false } = {}) {
  if (value === undefined && allowMissing) return emptyApiTaskRoutes();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(allowMissing ? 'STORAGE_DATA_INVALID' : 'BAD_API_TASK_ROUTES');
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const normalized = emptyApiTaskRoutes();
  for (const task of API_MODEL_TASKS) {
    const route = value[task];
    if (route === null || (route === undefined && allowMissing)) continue;
    normalized[task] = normalizeApiModelRoute(
      route, byId, allowMissing ? 'STORAGE_DATA_INVALID' : 'BAD_API_TASK_ROUTES',
    );
  }
  return normalized;
}

export function normalizeApiBookBindings(value, profiles, { allowMissing = false } = {}) {
  if (value === undefined && allowMissing) return [];
  const errorCode = allowMissing ? 'STORAGE_DATA_INVALID' : 'BAD_API_BOOK_BINDING';
  if (!Array.isArray(value) || value.length > MAX_API_BOOK_BINDINGS) {
    throw new Error(errorCode);
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const seenBooks = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.bookId !== 'string'
      || !API_BOOK_BINDING_ID_PATTERN.test(item.bookId)
      || seenBooks.has(item.bookId)) throw new Error(errorCode);
    seenBooks.add(item.bookId);
    return {
      bookId: item.bookId,
      ...normalizeApiModelRoute(item, byId, errorCode),
    };
  });
}

export function normalizeApiBookBindingInput(value, profiles) {
  if (value === null) return null;
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return normalizeApiModelRoute(value, byId, 'BAD_API_BOOK_BINDING');
}

export function isApiModelTask(value) {
  return typeof value === 'string' && API_MODEL_TASK_SET.has(value);
}

export function normalizeApiProfileInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BAD_API_PROFILE');
  }
  if (typeof value.name !== 'string'
    || Array.from(value.name.trim()).length > MAX_API_PROFILE_NAME_CHARS
    || (value.note !== undefined && (typeof value.note !== 'string'
      || Array.from(value.note.trim()).length > MAX_API_PROFILE_NOTE_CHARS))) {
    throw new Error('BAD_API_PROFILE_NAME');
  }
  const name = cleanText(value.name, MAX_API_PROFILE_NAME_CHARS);
  const note = cleanText(value.note, MAX_API_PROFILE_NOTE_CHARS);
  if (!name) throw new Error('BAD_API_PROFILE_NAME');
  const models = normalizeApiProfileModels(value.models);
  const modelContextChars = normalizeApiModelContextChars(value.modelContextChars, models);
  const selectedModel = typeof value.selectedModel === 'string'
    ? value.selectedModel.trim() : '';
  if (!models.includes(selectedModel)) throw new Error('BAD_API_PROFILE_MODEL');
  return { name, note, models, modelContextChars, selectedModel };
}
