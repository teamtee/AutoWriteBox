import { createHash } from 'node:crypto';
import { stringifyJsonChunks } from '../json-stream.js';
import {
  MAX_VERSION_HISTORY_ITEMS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';

export function emptyVersioned() {
  return { versions: [''], cursor: 0 };
}

export function currentText(versioned) {
  return versioned && Array.isArray(versioned.versions)
    ? (versioned.versions[versioned.cursor] ?? '')
    : '';
}

export function contentFingerprint(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('base64url');
}

// 大型对象使用与落盘一致的分块序列化，避免为了修订号再创建完整 JSON 副本。
export function jsonFingerprint(value) {
  const hash = createHash('sha256');
  for (const chunk of stringifyJsonChunks(value)) hash.update(chunk, 'utf8');
  return hash.digest('base64url');
}

export function isValidVersioned(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.versions)
    && value.versions.length >= 1
    && value.versions.length <= MAX_VERSION_HISTORY_ITEMS
    && value.versions.every((text) =>
      typeof text === 'string' && text.length <= MAX_VERSION_TEXT_CHARS)
    && Number.isInteger(value.cursor)
    && value.cursor >= 0
    && value.cursor < value.versions.length;
}

export function versionRevision(versioned) {
  if (!isValidVersioned(versioned)) throw new Error('STORAGE_DATA_INVALID');
  return jsonFingerprint({
    versions: versioned.versions,
    cursor: versioned.cursor,
  });
}

export function assertExpectedVersionRevision(versioned, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (typeof expectedRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_VERSION_REVISION');
  }
  if (versionRevision(versioned) !== expectedRevision) throw new Error('VERSION_CONFLICT');
}

export function commitVersion(versioned, text) {
  versioned.versions.push(text ?? '');
  while (versioned.versions.length > MAX_VERSION_HISTORY_ITEMS) {
    versioned.versions.shift();
  }
  versioned.cursor = versioned.versions.length - 1;
  return versioned;
}

export function moveCursor(versioned, delta) {
  const next = versioned.cursor + delta;
  if (next < 0 || next >= versioned.versions.length) return false;
  versioned.cursor = next;
  return true;
}

// 老结构 → 新结构：新结构原样 / 字符串→单版 / {content,history}→合并 / 其它→空。
export function migrateVersioned(old) {
  if (old && Array.isArray(old.versions)) {
    // 早期迁移会把已达 20 条上限的 history 再加上当前 content，写成
    // 21 版且 cursor=20。只修复这一种由旧版应用产生的已知溢出。
    if (old.versions.length === MAX_VERSION_HISTORY_ITEMS + 1
      && old.cursor === MAX_VERSION_HISTORY_ITEMS
      && old.versions.every((text) => typeof text === 'string')) {
      return {
        versions: old.versions.slice(-MAX_VERSION_HISTORY_ITEMS),
        cursor: MAX_VERSION_HISTORY_ITEMS - 1,
      };
    }
    return old;
  }
  if (typeof old === 'string') return { versions: [old], cursor: 0 };
  if (old && (typeof old.content === 'string' || Array.isArray(old.history))) {
    const history = Array.isArray(old.history) ? old.history : [];
    const versions = [...history, old.content ?? ''].slice(-MAX_VERSION_HISTORY_ITEMS);
    return { versions, cursor: versions.length - 1 };
  }
  return emptyVersioned();
}

export function pushHistory(object, field) {
  if (field === 'content') {
    object.history = object.history || [];
    object.history.push(object.content);
    if (object.history.length > MAX_VERSION_HISTORY_ITEMS) object.history.shift();
  } else {
    object[field].history = object[field].history || [];
    object[field].history.push(object[field].content);
    if (object[field].history.length > MAX_VERSION_HISTORY_ITEMS) object[field].history.shift();
  }
  return object;
}

export function rollback(object, field) {
  if (field === 'content') {
    if (!object.history || object.history.length === 0) return false;
    object.content = object.history.pop();
    return true;
  }
  if (!object[field].history || object[field].history.length === 0) return false;
  object[field].content = object[field].history.pop();
  return true;
}
