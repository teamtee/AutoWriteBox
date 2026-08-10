import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  MAX_BOOK_SECTIONS, MAX_SECTION_CHAPTERS, MAX_TOTAL_BACKUP_CHAPTERS,
} from './limits.js';

const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_BYTE = /[0-9eE+.-]/;
const VALID_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_JSON_DEPTH = 128;
const MAX_KEY_BYTES = 4096;
// chapterSummaries 是按章节 ID 建键的对象，合法导出可达到单部章节上限。
// 单对象不能使用更小的任意常数，否则大型作品会出现“能写、不能恢复”。
const MAX_OBJECT_KEYS = MAX_SECTION_CHAPTERS;
// 重复键检测需要让当前所有未闭合对象各自保留一个 Set。限制活跃键总量，
// 防止恶意深层对象同时撑满每层上限；同时为合法的万章摘要对象和其父级留余量。
const MAX_ACTIVE_OBJECT_KEYS = MAX_SECTION_CHAPTERS + MAX_JSON_DEPTH * 64;
const MAX_INDEX_CHUNK_BYTES = 1024 * 1024;

function invalidJson() { throw new Error('BACKUP_INVALID_JSON'); }
function invalidBackup() { throw new Error('BACKUP_INVALID'); }

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('CLIENT_ABORTED');
}

async function openBackupFile(absPath) {
  let handle;
  try {
    handle = await open(
      absPath,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
    if (!(await handle.stat()).isFile()) invalidBackup();
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === 'ELOOP') invalidBackup();
    throw error;
  }
}

function isHex(byte) {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x46)
    || (byte >= 0x61 && byte <= 0x66);
}

function byteChar(byte) { return String.fromCharCode(byte); }

function textStats(value) {
  let characterCount = 0;
  for (const character of value) {
    if (/\S/u.test(character)) characterCount += 1;
  }
  return {
    hasContent: characterCount > 0,
    characterCount,
    fingerprint: createHash('sha256').update(value, 'utf8').digest('base64url'),
  };
}

function createBackupIndexParser() {
  const root = { type: 'root', state: 'value', context: { kind: 'root' } };
  const stack = [root];
  const index = { top: {}, bundles: [] };
  let totalChapters = 0;
  let activeObjectKeys = 0;

  const current = () => stack[stack.length - 1];
  const ensureBundle = (bundleIndex) => {
    if (bundleIndex >= MAX_BOOK_SECTIONS) invalidBackup();
    if (!index.bundles[bundleIndex]) {
      index.bundles[bundleIndex] = { type: null, section: null, chaptersType: null, chapters: [] };
    }
    return index.bundles[bundleIndex];
  };

  function reserveValue(parent) {
    if (parent.type === 'root') {
      if (parent.state !== 'value') invalidJson();
      parent.state = 'inProgress';
      return {};
    }
    if (parent.type === 'object') {
      if (parent.state !== 'value' || typeof parent.key !== 'string') invalidJson();
      const location = { key: parent.key };
      parent.state = 'inProgress';
      return location;
    }
    if (parent.type === 'array') {
      if (parent.state !== 'firstValueOrEnd' && parent.state !== 'value') invalidJson();
      const location = { index: parent.count };
      parent.state = 'inProgress';
      return location;
    }
    return invalidJson();
  }

  function noteValueType(parent, location, valueType) {
    const context = parent.context;
    if (context.kind === 'top') {
      if (location.key === 'format' && valueType !== 'string') invalidBackup();
      if (location.key === 'version' && valueType !== 'number') invalidBackup();
      if (location.key === 'book' && valueType !== 'object') invalidBackup();
      if (location.key === 'sections') {
        if (valueType !== 'array') invalidBackup();
        index.sectionsType = valueType;
      }
    } else if (context.kind === 'sections') {
      const bundle = ensureBundle(location.index);
      bundle.type = valueType;
      if (valueType !== 'object') invalidBackup();
    } else if (context.kind === 'bundle') {
      const bundle = ensureBundle(context.bundleIndex);
      if (location.key === 'section' && valueType !== 'object') invalidBackup();
      if (location.key === 'chapters') {
        bundle.chaptersType = valueType;
        if (valueType !== 'array') invalidBackup();
      }
    } else if (context.kind === 'chapters') {
      if (location.index >= MAX_SECTION_CHAPTERS) invalidBackup();
      totalChapters += 1;
      if (totalChapters > MAX_TOTAL_BACKUP_CHAPTERS || valueType !== 'object') invalidBackup();
    }
  }

  function captureFor(parent, location) {
    const context = parent.context;
    if (context.kind === 'top' && ['format', 'version', 'book'].includes(location.key)) {
      return { kind: 'top', key: location.key };
    }
    if (context.kind === 'bundle' && location.key === 'section') {
      return { kind: 'section', bundleIndex: context.bundleIndex };
    }
    if (context.kind === 'chapters') {
      return { kind: 'chapter', bundleIndex: context.bundleIndex, chapterIndex: location.index };
    }
    return null;
  }

  function contextFor(parent, location, valueType) {
    if (parent.type === 'root' && valueType === 'object') return { kind: 'top' };
    if (parent.context.kind === 'top' && location.key === 'sections' && valueType === 'array') {
      return { kind: 'sections' };
    }
    if (parent.context.kind === 'sections' && valueType === 'object') {
      return { kind: 'bundle', bundleIndex: location.index };
    }
    if (parent.context.kind === 'bundle' && location.key === 'chapters' && valueType === 'array') {
      return { kind: 'chapters', bundleIndex: parent.context.bundleIndex };
    }
    return { kind: 'generic' };
  }

  function beginValue(valueType, start) {
    const parent = current();
    const location = reserveValue(parent);
    noteValueType(parent, location, valueType);
    return {
      parent,
      location,
      start,
      capture: captureFor(parent, location),
      context: contextFor(parent, location, valueType),
    };
  }

  function recordCapture(capture, start, end, type) {
    if (!capture) return;
    const span = { start, end, type };
    if (capture.kind === 'top') index.top[capture.key] = span;
    else if (capture.kind === 'section') ensureBundle(capture.bundleIndex).section = span;
    else if (capture.kind === 'chapter') {
      ensureBundle(capture.bundleIndex).chapters[capture.chapterIndex] = span;
    }
  }

  function completeValue(active, end, valueType) {
    recordCapture(active.capture, active.start, end, valueType);
    const parent = active.parent;
    if (parent.type === 'root') {
      if (parent.state !== 'inProgress') invalidJson();
      parent.state = 'done';
      return;
    }
    if (parent.state !== 'inProgress') invalidJson();
    if (parent.type === 'object') {
      parent.key = undefined;
      parent.state = 'commaOrEnd';
    } else {
      parent.count += 1;
      parent.state = 'commaOrEnd';
    }
  }

  function beginContainer(type, start) {
    const active = beginValue(type, start);
    if (stack.length >= MAX_JSON_DEPTH) invalidBackup();
    stack.push(type === 'object'
      ? {
        type, state: 'firstKeyOrEnd', context: active.context, active, start,
        keys: new Set(), key: undefined,
      }
      : { type, state: 'firstValueOrEnd', context: active.context, active, start, count: 0 });
  }

  function endContainer(type, end) {
    const frame = current();
    if (frame.type !== type) invalidJson();
    if (type === 'object') {
      if (frame.state !== 'firstKeyOrEnd' && frame.state !== 'commaOrEnd') invalidJson();
    } else if (frame.state !== 'firstValueOrEnd' && frame.state !== 'commaOrEnd') invalidJson();
    if (type === 'object') activeObjectKeys -= frame.keys.size;
    stack.pop();
    completeValue(frame.active, end, type);
  }

  function setObjectKey(key) {
    const frame = current();
    if (frame.type !== 'object'
      || (frame.state !== 'firstKeyOrEnd' && frame.state !== 'key')) invalidJson();
    if (frame.keys.has(key)) invalidJson();
    if (frame.keys.size >= MAX_OBJECT_KEYS) invalidBackup();
    if (activeObjectKeys >= MAX_ACTIVE_OBJECT_KEYS) invalidBackup();
    frame.keys.add(key);
    activeObjectKeys += 1;
    frame.key = key;
    frame.state = 'colon';
  }

  function colon() {
    const frame = current();
    if (frame.type !== 'object' || frame.state !== 'colon') invalidJson();
    frame.state = 'value';
  }

  function comma() {
    const frame = current();
    if (frame.state !== 'commaOrEnd') invalidJson();
    frame.state = frame.type === 'object' ? 'key' : 'value';
  }

  function expectsKey() {
    const frame = current();
    return frame.type === 'object'
      && (frame.state === 'firstKeyOrEnd' || frame.state === 'key');
  }

  function finish() {
    if (stack.length !== 1 || root.state !== 'done') invalidJson();
    if (!index.top.format || !index.top.version || !index.top.book || index.sectionsType !== 'array') {
      invalidBackup();
    }
    for (const bundle of index.bundles) {
      if (!bundle || bundle.type !== 'object' || !bundle.section
        || bundle.chaptersType !== 'array' || bundle.chapters.some((span) => !span)) {
        invalidBackup();
      }
    }
    return index;
  }

  return {
    beginValue,
    beginContainer,
    endContainer,
    setObjectKey,
    colon,
    comma,
    expectsKey,
    completeValue,
    current,
    finish,
  };
}

function createTopLevelProjectionParser(specification) {
  const fields = new Map(Object.entries(specification));
  const root = { type: 'root', state: 'value', context: { kind: 'root' } };
  const stack = [root];
  const values = {};
  const versionedTextStates = new Map();
  const publishedChapterStates = new Map();
  let activeObjectKeys = 0;

  const current = () => stack[stack.length - 1];

  function reserveValue(parent) {
    if (parent.type === 'root') {
      if (parent.state !== 'value') invalidJson();
      parent.state = 'inProgress';
      return {};
    }
    if (parent.type === 'object') {
      if (parent.state !== 'value' || typeof parent.key !== 'string') invalidJson();
      const location = { key: parent.key };
      parent.state = 'inProgress';
      return location;
    }
    if (parent.type === 'array') {
      if (parent.state !== 'firstValueOrEnd' && parent.state !== 'value') invalidJson();
      const location = { index: parent.count };
      parent.state = 'inProgress';
      return location;
    }
    return invalidJson();
  }

  function projectionFor(parent, location, valueType) {
    if (parent.type === 'root') {
      if (valueType !== 'object') invalidBackup();
      return { context: { kind: 'top' }, capture: null };
    }
    if (parent.context.kind === 'top' && fields.has(location.key)) {
      const field = fields.get(location.key);
      if (field.type === 'string') {
        if (valueType !== 'string') invalidBackup();
        return {
          context: { kind: 'generic' },
          capture: {
            kind: 'field', key: location.key,
            maxBytes: field.maxBytes, maxChars: field.maxChars,
          },
        };
      }
      if (field.type === 'stringArray') {
        if (valueType !== 'array') invalidBackup();
        values[location.key] = [];
        return {
          context: {
            kind: 'projectionArray', key: location.key,
            maxItems: field.maxItems, itemMaxBytes: field.itemMaxBytes,
            itemMaxChars: field.itemMaxChars,
          },
          capture: null,
        };
      }
      if (field.type === 'versionedTextPresence' || field.type === 'versionedTextStats') {
        if (valueType !== 'object') invalidBackup();
        const state = {
          mode: field.type === 'versionedTextStats' ? 'stats' : 'presence',
          items: undefined,
          cursor: undefined,
        };
        versionedTextStates.set(location.key, state);
        return {
          context: {
            kind: 'versionedText', key: location.key,
            maxItems: field.maxItems, itemMaxBytes: field.itemMaxBytes,
            itemMaxChars: field.itemMaxChars,
          },
          capture: null,
        };
      }
      if (field.type === 'publishedChapterSummary') {
        if (valueType !== 'object') invalidBackup();
        publishedChapterStates.set(location.key, {});
        return {
          context: {
            kind: 'publishedChapter', key: location.key,
            contentMaxBytes: field.contentMaxBytes,
            contentMaxChars: field.contentMaxChars,
            fingerprintMaxBytes: field.fingerprintMaxBytes,
            publishedAtMaxBytes: field.publishedAtMaxBytes,
          },
          capture: null,
        };
      }
      throw new TypeError(`Unsupported JSON projection type: ${field.type}`);
    }
    if (parent.context.kind === 'projectionArray') {
      if (location.index >= parent.context.maxItems || valueType !== 'string') invalidBackup();
      return {
        context: { kind: 'generic' },
        capture: {
          kind: 'arrayItem', key: parent.context.key,
          index: location.index, maxBytes: parent.context.itemMaxBytes,
          maxChars: parent.context.itemMaxChars,
        },
      };
    }
    if (parent.context.kind === 'versionedText') {
      if (location.key === 'versions') {
        if (valueType !== 'array') invalidBackup();
        const state = versionedTextStates.get(parent.context.key);
        state.items = [];
        return {
          context: {
            kind: 'versionedTextArray', key: parent.context.key,
            maxItems: parent.context.maxItems,
            itemMaxBytes: parent.context.itemMaxBytes,
            itemMaxChars: parent.context.itemMaxChars,
          },
          capture: null,
        };
      }
      if (location.key === 'cursor') {
        if (valueType !== 'number') invalidBackup();
        return {
          context: { kind: 'generic' },
          capture: { kind: 'versionedCursor', key: parent.context.key },
        };
      }
    }
    if (parent.context.kind === 'publishedChapter') {
      if (location.key === 'content') {
        if (valueType !== 'string') invalidBackup();
        return {
          context: { kind: 'generic' },
          capture: {
            kind: 'publishedContent', key: parent.context.key,
            maxBytes: parent.context.contentMaxBytes,
            maxChars: parent.context.contentMaxChars,
          },
        };
      }
      if (location.key === 'bodyFingerprint') {
        if (valueType !== 'string') invalidBackup();
        return {
          context: { kind: 'generic' },
          capture: {
            kind: 'publishedFingerprint', key: parent.context.key,
            maxBytes: parent.context.fingerprintMaxBytes,
          },
        };
      }
      if (location.key === 'publishedAt') {
        if (valueType !== 'string') invalidBackup();
        return {
          context: { kind: 'generic' },
          capture: {
            kind: 'publishedAt', key: parent.context.key,
            maxBytes: parent.context.publishedAtMaxBytes,
          },
        };
      }
      if (location.key === 'publicationNumber') {
        if (valueType !== 'number') invalidBackup();
        return {
          context: { kind: 'generic' },
          capture: { kind: 'publicationNumber', key: parent.context.key },
        };
      }
    }
    if (parent.context.kind === 'versionedTextArray') {
      if (location.index >= parent.context.maxItems || valueType !== 'string') invalidBackup();
      return {
        context: { kind: 'generic' },
        capture: {
          kind: 'versionedTextItem', key: parent.context.key,
          index: location.index, maxBytes: parent.context.itemMaxBytes,
          maxChars: parent.context.itemMaxChars,
        },
      };
    }
    return { context: { kind: 'generic' }, capture: null };
  }

  function beginValue(valueType, start) {
    const parent = current();
    const location = reserveValue(parent);
    const projection = projectionFor(parent, location, valueType);
    return {
      parent,
      location,
      start,
      capture: projection.capture,
      context: projection.context,
    };
  }

  function recordDecodedValue(active, value) {
    const capture = active?.capture;
    if (!capture) return;
    if (Number.isInteger(capture.maxChars)
      && typeof value === 'string'
      && value.length > capture.maxChars) invalidBackup();
    if (capture.kind === 'field') values[capture.key] = value;
    else if (capture.kind === 'arrayItem') values[capture.key][capture.index] = value;
    else if (capture.kind === 'versionedTextItem') {
      const state = versionedTextStates.get(capture.key);
      state.items[capture.index] = state.mode === 'stats' ? textStats(value) : /\S/u.test(value);
    } else if (capture.kind === 'versionedCursor') {
      versionedTextStates.get(capture.key).cursor = value;
    } else if (capture.kind === 'publishedContent') {
      publishedChapterStates.get(capture.key).content = textStats(value);
    } else if (capture.kind === 'publishedFingerprint') {
      publishedChapterStates.get(capture.key).bodyFingerprint = value;
    } else if (capture.kind === 'publishedAt') {
      publishedChapterStates.get(capture.key).publishedAt = value;
    } else if (capture.kind === 'publicationNumber') {
      publishedChapterStates.get(capture.key).publicationNumber = value;
    }
  }

  function completeValue(active, _end, _valueType) {
    const parent = active.parent;
    if (parent.type === 'root') {
      if (parent.state !== 'inProgress') invalidJson();
      parent.state = 'done';
      return;
    }
    if (parent.state !== 'inProgress') invalidJson();
    if (parent.type === 'object') {
      parent.key = undefined;
      parent.state = 'commaOrEnd';
    } else {
      parent.count += 1;
      parent.state = 'commaOrEnd';
    }
  }

  function beginContainer(type, start) {
    const active = beginValue(type, start);
    if (stack.length >= MAX_JSON_DEPTH) invalidBackup();
    stack.push(type === 'object'
      ? {
        type, state: 'firstKeyOrEnd', context: active.context, active, start,
        keys: new Set(), key: undefined,
      }
      : { type, state: 'firstValueOrEnd', context: active.context, active, start, count: 0 });
  }

  function endContainer(type, end) {
    const frame = current();
    if (frame.type !== type) invalidJson();
    if (type === 'object') {
      if (frame.state !== 'firstKeyOrEnd' && frame.state !== 'commaOrEnd') invalidJson();
    } else if (frame.state !== 'firstValueOrEnd' && frame.state !== 'commaOrEnd') invalidJson();
    if (type === 'object') {
      activeObjectKeys -= frame.keys.size;
      if (frame.context.kind === 'versionedText') {
        const state = versionedTextStates.get(frame.context.key);
        if (!Array.isArray(state?.items)
          || state.items.length < 1
          || state.items.length > frame.context.maxItems
          || !Number.isInteger(state.cursor)
          || state.cursor < 0
          || state.cursor >= state.items.length) invalidBackup();
        values[frame.context.key] = state.items[state.cursor];
      } else if (frame.context.kind === 'publishedChapter') {
        const state = publishedChapterStates.get(frame.context.key);
        if (!state?.content
          || typeof state.bodyFingerprint !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/.test(state.bodyFingerprint)
          || state.content.fingerprint !== state.bodyFingerprint
          || typeof state.publishedAt !== 'string'
          || !Number.isFinite(Date.parse(state.publishedAt))
          || !Number.isSafeInteger(state.publicationNumber)
          || state.publicationNumber < 1) invalidBackup();
        values[frame.context.key] = {
          bodyFingerprint: state.bodyFingerprint,
          publishedAt: state.publishedAt,
          publicationNumber: state.publicationNumber,
          characterCount: state.content.characterCount,
        };
      }
    }
    stack.pop();
    completeValue(frame.active, end, type);
  }

  function setObjectKey(key) {
    const frame = current();
    if (frame.type !== 'object'
      || (frame.state !== 'firstKeyOrEnd' && frame.state !== 'key')) invalidJson();
    if (frame.keys.has(key)) invalidJson();
    if (frame.keys.size >= MAX_OBJECT_KEYS) invalidBackup();
    if (activeObjectKeys >= MAX_ACTIVE_OBJECT_KEYS) invalidBackup();
    frame.keys.add(key);
    activeObjectKeys += 1;
    frame.key = key;
    frame.state = 'colon';
  }

  function colon() {
    const frame = current();
    if (frame.type !== 'object' || frame.state !== 'colon') invalidJson();
    frame.state = 'value';
  }

  function comma() {
    const frame = current();
    if (frame.state !== 'commaOrEnd') invalidJson();
    frame.state = frame.type === 'object' ? 'key' : 'value';
  }

  function expectsKey() {
    const frame = current();
    return frame.type === 'object'
      && (frame.state === 'firstKeyOrEnd' || frame.state === 'key');
  }

  function finish() {
    if (stack.length !== 1 || root.state !== 'done') invalidJson();
    return values;
  }

  return {
    beginValue,
    beginContainer,
    endContainer,
    setObjectKey,
    colon,
    comma,
    expectsKey,
    completeValue,
    recordDecodedValue,
    current,
    finish,
  };
}

async function indexJsonFromHandle(
  absPath, handle, parser,
  { highWaterMark = 64 * 1024, signal, maxBytes, allowBom = true } = {},
) {
  throwIfAborted(signal);
  let mode = 'normal';
  let active = null;
  let stringKind = null;
  let stringBytes = null;
  let stringEscape = false;
  let unicodeRemaining = 0;
  let numberBytes = null;
  let literal = null;
  let literalIndex = 0;
  let absolute = 0;
  let firstChunk = true;
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  const chunkSize = Math.min(
    MAX_INDEX_CHUNK_BYTES,
    Math.max(4, Number.isInteger(highWaterMark) ? highWaterMark : 64 * 1024),
  );
  for await (const originalChunk of createReadStream(absPath, {
    fd: handle.fd,
    autoClose: false,
    start: 0,
    highWaterMark: chunkSize,
  })) {
    throwIfAborted(signal);
    if (Number.isInteger(maxBytes) && absolute + originalChunk.length > maxBytes) {
      throw new Error('STORAGE_FILE_TOO_LARGE');
    }
    try { utf8Decoder.decode(originalChunk, { stream: true }); }
    catch { invalidJson(); }
    let chunk = originalChunk;
    let chunkOffset = absolute;
    absolute += originalChunk.length;
    if (firstChunk) {
      firstChunk = false;
      if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
        if (!allowBom) invalidJson();
        chunk = chunk.subarray(3);
        chunkOffset += 3;
      }
    }

    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i];
      const position = chunkOffset + i;
      let reprocess = true;
      while (reprocess) {
        reprocess = false;
        if (mode === 'string') {
          if (stringKind === 'key' || stringKind === 'capturedValue') {
            const maxStringBytes = stringKind === 'key'
              ? MAX_KEY_BYTES
              : active.capture.maxBytes;
            if (stringBytes.length >= maxStringBytes) invalidBackup();
            stringBytes.push(byte);
          }
          if (unicodeRemaining) {
            if (!isHex(byte)) invalidJson();
            unicodeRemaining -= 1;
          } else if (stringEscape) {
            if (byte === 0x75) unicodeRemaining = 4;
            else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(byte)) invalidJson();
            stringEscape = false;
          } else if (byte === 0x5c) stringEscape = true;
          else if (byte === 0x22) {
            mode = 'normal';
            if (stringKind === 'key') {
              let key;
              try { key = JSON.parse(Buffer.from(stringBytes).toString('utf8')); }
              catch { return invalidJson(); }
              parser.setObjectKey(key);
            } else {
              if (stringKind === 'capturedValue') {
                let value;
                try { value = JSON.parse(Buffer.from(stringBytes).toString('utf8')); }
                catch { return invalidJson(); }
                parser.recordDecodedValue(active, value);
              }
              parser.completeValue(active, position + 1, 'string');
            }
            active = null;
            stringKind = null;
            stringBytes = null;
          } else if (byte < 0x20) invalidJson();
          continue;
        }

        if (mode === 'number') {
          if (NUMBER_BYTE.test(byteChar(byte))) {
            if (numberBytes.length >= 128) invalidJson();
            numberBytes.push(byte);
            continue;
          }
          const raw = Buffer.from(numberBytes).toString('ascii');
          if (!VALID_NUMBER.test(raw)) invalidJson();
          parser.recordDecodedValue?.(active, Number(raw));
          parser.completeValue(active, position, 'number');
          mode = 'normal';
          active = null;
          numberBytes = null;
          reprocess = true;
          continue;
        }

        if (mode === 'literal') {
          if (byte !== literal[literalIndex]) invalidJson();
          literalIndex += 1;
          if (literalIndex === literal.length) {
            parser.completeValue(active, position + 1, 'literal');
            mode = 'normal';
            active = null;
            literal = null;
            literalIndex = 0;
          }
          continue;
        }

        if (JSON_WHITESPACE.has(byte)) continue;
        if (byte === 0x7b) { parser.beginContainer('object', position); continue; }
        if (byte === 0x5b) { parser.beginContainer('array', position); continue; }
        if (byte === 0x7d) { parser.endContainer('object', position + 1); continue; }
        if (byte === 0x5d) { parser.endContainer('array', position + 1); continue; }
        if (byte === 0x3a) { parser.colon(); continue; }
        if (byte === 0x2c) { parser.comma(); continue; }
        if (byte === 0x22) {
          mode = 'string';
          stringEscape = false;
          unicodeRemaining = 0;
          if (parser.expectsKey()) {
            stringKind = 'key';
            stringBytes = [0x22];
          } else {
            active = parser.beginValue('string', position);
            if (Number.isInteger(active.capture?.maxBytes)) {
              stringKind = 'capturedValue';
              stringBytes = [0x22];
            } else {
              stringKind = 'value';
              stringBytes = null;
            }
          }
          continue;
        }
        if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
          mode = 'number';
          active = parser.beginValue('number', position);
          numberBytes = [byte];
          continue;
        }
        if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
          mode = 'literal';
          active = parser.beginValue('literal', position);
          literal = Buffer.from(byte === 0x74 ? 'true' : byte === 0x66 ? 'false' : 'null');
          literalIndex = 1;
          continue;
        }
        invalidJson();
      }
    }
  }

  throwIfAborted(signal);
  try { utf8Decoder.decode(); }
  catch { invalidJson(); }
  if (mode === 'number') {
    const raw = Buffer.from(numberBytes).toString('ascii');
    if (!VALID_NUMBER.test(raw)) invalidJson();
    parser.recordDecodedValue?.(active, Number(raw));
    parser.completeValue(active, absolute, 'number');
    mode = 'normal';
  }
  if (mode !== 'normal') invalidJson();
  return parser.finish();
}

async function indexBookBackupJsonFromHandle(absPath, handle, options = {}) {
  return indexJsonFromHandle(absPath, handle, createBackupIndexParser(), options);
}

export async function projectTopLevelJsonFromHandle(
  absPath, handle, specification, options = {},
) {
  return indexJsonFromHandle(
    absPath, handle, createTopLevelProjectionParser(specification), options,
  );
}

export async function indexBookBackupJson(absPath, options) {
  const handle = await openBackupFile(absPath);
  try {
    return await indexBookBackupJsonFromHandle(absPath, handle, options);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readExact(handle, start, length, signal) {
  throwIfAborted(signal);
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    throwIfAborted(signal);
    const bytesToRead = Math.min(MAX_INDEX_CHUNK_BYTES, length - offset);
    const { bytesRead } = await handle.read(buffer, offset, bytesToRead, start + offset);
    if (!bytesRead) throw new Error('BACKUP_INVALID_JSON');
    offset += bytesRead;
  }
  return buffer;
}

export async function openIndexedBookBackup(absPath, options) {
  const handle = await openBackupFile(absPath);
  try {
    const index = await indexBookBackupJsonFromHandle(absPath, handle, options);
    return {
      index,
      async read(span, { maxBytes } = {}) {
        try {
          throwIfAborted(options?.signal);
          const length = span.end - span.start;
          if (Number.isSafeInteger(maxBytes) && maxBytes >= 0 && length > maxBytes) {
            throw new Error('BACKUP_INVALID');
          }
          return JSON.parse((await readExact(
            handle, span.start, length, options?.signal,
          )).toString('utf8'));
        } catch (err) {
          if (options?.signal?.aborted) throw err;
          if (err?.message === 'BACKUP_INVALID_JSON' || err?.message === 'BACKUP_INVALID') {
            throw err;
          }
          throw new Error('BACKUP_INVALID_JSON');
        }
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
