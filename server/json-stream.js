const DEFAULT_STRING_CHUNK_CHARS = 64 * 1024;

function escapedCodeUnit(code) {
  if (code === 0x08) return '\\b';
  if (code === 0x09) return '\\t';
  if (code === 0x0a) return '\\n';
  if (code === 0x0c) return '\\f';
  if (code === 0x0d) return '\\r';
  if (code === 0x22) return '\\"';
  if (code === 0x5c) return '\\\\';
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return null;
}

function* stringifyString(value, maxChunkChars) {
  yield '"';
  let chunk = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let token;
    if (code >= 0xd800 && code <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      token = value.slice(index, index + 2);
      index += 1;
    } else {
      token = escapedCodeUnit(code) ?? value[index];
    }
    if (chunk.length && chunk.length + token.length > maxChunkChars) {
      yield chunk;
      chunk = '';
    }
    chunk += token;
  }
  if (chunk) yield chunk;
  yield '"';
}

function isOmittedJsonValue(value) {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function prepareJsonValue(value, key) {
  if (value !== null && (typeof value === 'object' || typeof value === 'bigint')) {
    const toJSON = value?.toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value, key);
  }
  // JSON.stringify 会先把 Number/String/Boolean/BigInt 包装对象还原为基本值。
  // Symbol 包装对象仍按普通对象处理，不能一并 valueOf。
  if (value instanceof Number || value instanceof String || value instanceof Boolean
    || Object.prototype.toString.call(value) === '[object BigInt]') {
    value = value.valueOf();
  }
  return value;
}

// 面向已经规范化的存储对象，按 JSON.stringify 的属性顺序与字符串转义规则
// 逐片输出。单个长文本不会再额外复制成同等大小的完整 JSON 字符串。
export function* stringifyJsonChunks(value, {
  maxStringChunkChars = DEFAULT_STRING_CHUNK_CHARS,
} = {}) {
  const chunkLimit = Number.isInteger(maxStringChunkChars) && maxStringChunkChars > 0
    ? maxStringChunkChars
    : DEFAULT_STRING_CHUNK_CHARS;
  const ancestors = new Set();

  function* visit(current, arrayItem = false, key = '', prepared = false) {
    if (!prepared) current = prepareJsonValue(current, key);
    if (isOmittedJsonValue(current)) {
      if (arrayItem) yield 'null';
      else throw new TypeError('JSON value is not serializable');
      return;
    }
    if (current === null) {
      yield 'null';
      return;
    }
    if (typeof current === 'string') {
      yield* stringifyString(current, chunkLimit);
      return;
    }
    if (typeof current === 'number') {
      yield Number.isFinite(current) ? JSON.stringify(current) : 'null';
      return;
    }
    if (typeof current === 'boolean') {
      yield current ? 'true' : 'false';
      return;
    }
    if (typeof current === 'bigint') {
      throw new TypeError('Do not know how to serialize a BigInt');
    }
    if (typeof current !== 'object') throw new TypeError('JSON value is not serializable');
    if (ancestors.has(current)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        yield '[';
        for (let index = 0; index < current.length; index += 1) {
          if (index) yield ',';
          yield* visit(current[index], true, String(index));
        }
        yield ']';
        return;
      }
      yield '{';
      let emitted = 0;
      for (const key of Object.keys(current)) {
        // 必须在输出键名前执行 toJSON：其返回 undefined/function/symbol 时，
        // 标准 JSON.stringify 会直接省略整个属性。
        const item = prepareJsonValue(current[key], key);
        if (isOmittedJsonValue(item)) continue;
        if (emitted) yield ',';
        yield* stringifyString(key, chunkLimit);
        yield ':';
        // toJSON 对该属性只调用一次；其返回的新对象不会再执行第二次 toJSON。
        yield* visit(item, false, key, true);
        emitted += 1;
      }
      yield '}';
    } finally {
      ancestors.delete(current);
    }
  }

  yield* visit(value);
}
