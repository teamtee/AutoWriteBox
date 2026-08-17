import { createHash, randomUUID } from 'node:crypto';
import { normalizeLlmConfig } from '../llm-config.js';
import {
  MAX_CHAPTER_WORD_TARGET, MAX_CONFIG_API_KEY_CHARS,
  DEFAULT_MODEL_CONTEXT_CHARS, MAX_CONFIG_BASE_URL_CHARS, MAX_CONFIG_MODEL_CHARS,
  MAX_MODEL_CONTEXT_CHARS, MIN_CHAPTER_WORD_TARGET, MIN_MODEL_CONTEXT_CHARS,
} from '../limits.js';

export const API_KEY_MASK = 'sk-****';
export const DEFAULT_CONFIG = Object.freeze({
  baseUrl: '', model: '', apiKey: '', chapterWordTarget: MIN_CHAPTER_WORD_TARGET,
  requestTimeoutMs: 300_000, modelContextChars: DEFAULT_MODEL_CONTEXT_CHARS,
});
const CONFIG_FIELDS = Object.keys(DEFAULT_CONFIG);
const CONFIG_FIELD_SET = new Set(CONFIG_FIELDS);
const CONFIG_LOCK_KEY = 'config:config-json';
const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function normalizeConfig(config) {
  const out = { ...DEFAULT_CONFIG };
  const textLimits = {
    baseUrl: MAX_CONFIG_BASE_URL_CHARS,
    model: MAX_CONFIG_MODEL_CHARS,
    apiKey: MAX_CONFIG_API_KEY_CHARS,
  };
  for (const [field, limit] of Object.entries(textLimits)) {
    if (typeof config?.[field] === 'string' && config[field].length <= limit) {
      out[field] = config[field];
    }
  }
  if (Number.isInteger(config?.chapterWordTarget)
    && config.chapterWordTarget > 0
    && config.chapterWordTarget <= MAX_CHAPTER_WORD_TARGET) {
    // 旧配置可能低于体量下限。这里只上提到下限并继续加载，
    // 不把已存在的配置判为损坏；新的保存请求仍然必须显式达标。
    out.chapterWordTarget = Math.max(config.chapterWordTarget, MIN_CHAPTER_WORD_TARGET);
  }
  if (Number.isInteger(config?.requestTimeoutMs)
    && config.requestTimeoutMs >= 1_000
    && config.requestTimeoutMs <= 3_600_000) {
    out.requestTimeoutMs = config.requestTimeoutMs;
  }
  if (Number.isInteger(config?.modelContextChars)
    && config.modelContextChars >= MIN_MODEL_CONTEXT_CHARS
    && config.modelContextChars <= MAX_MODEL_CONTEXT_CHARS) {
    out.modelContextChars = config.modelContextChars;
  }
  return out;
}

export function isValidStoredConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
  const textLimits = {
    baseUrl: MAX_CONFIG_BASE_URL_CHARS,
    model: MAX_CONFIG_MODEL_CHARS,
    apiKey: MAX_CONFIG_API_KEY_CHARS,
  };
  for (const [field, limit] of Object.entries(textLimits)) {
    if (Object.hasOwn(config, field)
      && (typeof config[field] !== 'string' || config[field].length > limit)) {
      return false;
    }
  }
  if (Object.hasOwn(config, 'chapterWordTarget')
    && (!Number.isInteger(config.chapterWordTarget)
      || config.chapterWordTarget <= 0
      || config.chapterWordTarget > MAX_CHAPTER_WORD_TARGET)) {
    return false;
  }
  if (Object.hasOwn(config, 'requestTimeoutMs')
    && (!Number.isInteger(config.requestTimeoutMs)
      || config.requestTimeoutMs < 1_000
      || config.requestTimeoutMs > 3_600_000)) {
    return false;
  }
  if (Object.hasOwn(config, 'modelContextChars')
    && (!Number.isInteger(config.modelContextChars)
      || config.modelContextChars < MIN_MODEL_CONTEXT_CHARS
      || config.modelContextChars > MAX_MODEL_CONTEXT_CHARS)) {
    return false;
  }
  try {
    normalizeLlmConfig(normalizeConfig(config), { allowIncomplete: true });
    return true;
  } catch {
    return false;
  }
}

export function createConfigStore(context) {
  const revisionSalt = randomUUID();
  const configPath = () => context.resolvePath('config.json');

  const configRevision = (config) => createHash('sha256')
    .update(revisionSalt, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(normalizeConfig(config)), 'utf8')
    .digest('base64url');

  const expectedConfigRevisionMatches = (config, expectedRevision) => {
    if (expectedRevision === undefined) return true;
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_CONFIG_REVISION');
    }
    return configRevision(config) === expectedRevision;
  };

  const readConfig = async ({ signal } = {}) => {
    try {
      return normalizeConfig(await context.readStoredJson(
        configPath(), { mode: 0o600, signal },
      ));
    } catch (error) {
      context.throwIfAborted(signal);
      if (error?.code !== 'ENOENT') throw error;
      return { ...DEFAULT_CONFIG };
    }
  };

  const withConfigLock = (task, { signal } = {}) =>
    context.withStoreLock(CONFIG_LOCK_KEY, task, { signal });

  const writeConfig = async (patch, { expectedRevision } = {}) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('BAD_CONFIG_PATCH');
    }
    for (const field of Object.keys(patch)) {
      if (!CONFIG_FIELD_SET.has(field)) throw new Error('BAD_CONFIG_FIELD');
    }
    return withConfigLock(async () => {
      const current = await readConfig();
      const revisionMatches = expectedConfigRevisionMatches(current, expectedRevision);
      const textLimits = {
        baseUrl: MAX_CONFIG_BASE_URL_CHARS,
        model: MAX_CONFIG_MODEL_CHARS,
        apiKey: MAX_CONFIG_API_KEY_CHARS,
      };
      for (const [field, limit] of Object.entries(textLimits)) {
        if (patch[field] !== undefined && typeof patch[field] !== 'string') {
          throw new Error('BAD_CONFIG_TEXT_FIELD');
        }
        if (typeof patch[field] === 'string' && patch[field].length > limit) {
          throw new Error('CONFIG_TEXT_TOO_LARGE');
        }
      }
      if (patch.chapterWordTarget !== undefined) {
        const target = patch.chapterWordTarget;
        if (!Number.isInteger(target)
          || target < MIN_CHAPTER_WORD_TARGET
          || target > MAX_CHAPTER_WORD_TARGET) {
          throw new Error('BAD_CHAPTER_WORD_TARGET');
        }
      }
      if (patch.requestTimeoutMs !== undefined) {
        const timeout = patch.requestTimeoutMs;
        if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 3_600_000) {
          throw new Error('BAD_REQUEST_TIMEOUT');
        }
      }
      if (patch.modelContextChars !== undefined
        && (!Number.isInteger(patch.modelContextChars)
          || patch.modelContextChars < MIN_MODEL_CONTEXT_CHARS
          || patch.modelContextChars > MAX_MODEL_CONTEXT_CHARS)) {
        throw new Error('BAD_MODEL_CONTEXT_CHARS');
      }
      let next = { ...current, ...patch };
      const keepsStoredKey = patch.apiKey === undefined
        || (typeof patch.apiKey === 'string' && patch.apiKey.trim() === API_KEY_MASK);
      if (keepsStoredKey) next.apiKey = current.apiKey;
      next = normalizeLlmConfig(next, { allowIncomplete: true });
      if (!revisionMatches) {
        // 成功响应丢失后，相同旧修订号重放同一最终配置可幂等确认。
        if (CONFIG_FIELDS.every((field) => next[field] === current[field])) return current;
        throw new Error('CONFIG_CONFLICT');
      }
      const baseUrlChanged = patch.baseUrl !== undefined && next.baseUrl !== current.baseUrl;
      if (baseUrlChanged && current.apiKey && keepsStoredKey) {
        throw new Error('API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
      }
      await context.ensureDataRoot();
      await context.atomicWriteJson(configPath(), next, { mode: 0o600 });
      return next;
    });
  };

  return Object.freeze({
    configRevision,
    readConfig,
    writeConfig,
    withConfigLock,
  });
}
