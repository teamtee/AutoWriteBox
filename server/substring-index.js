export const DEFAULT_SUBSTRING_INDEX_THRESHOLD = 8_000_000;

// 为固定文本构建 UTF-16 后缀数组。与 String.includes 一样按 code unit
// 比较，因此 emoji、未配对代理项和普通 BMP 字符都保持完全一致的语义。
function createIndexedSubstringLookup(text) {
  const size = text.length + 1;
  const codes = new Uint32Array(size);
  for (let index = 0; index < text.length; index += 1) {
    // 0 留给唯一结尾哨兵，原始 UTF-16 code unit 整体平移一位。
    codes[index] = text.charCodeAt(index) + 1;
  }

  let suffixes = new Int32Array(size);
  let classes = new Int32Array(size);
  const shifted = new Int32Array(size);
  let nextClasses = new Int32Array(size);
  const counts = new Int32Array(Math.max(65_537, size));
  for (let index = 0; index < size; index += 1) counts[codes[index]] += 1;
  for (let index = 1; index < 65_537; index += 1) counts[index] += counts[index - 1];
  for (let index = size - 1; index >= 0; index -= 1) {
    suffixes[--counts[codes[index]]] = index;
  }

  let classCount = 1;
  classes[suffixes[0]] = 0;
  for (let index = 1; index < size; index += 1) {
    if (codes[suffixes[index]] !== codes[suffixes[index - 1]]) classCount += 1;
    classes[suffixes[index]] = classCount - 1;
  }

  for (let shift = 1; shift < size; shift *= 2) {
    for (let index = 0; index < size; index += 1) {
      let position = suffixes[index] - shift;
      if (position < 0) position += size;
      shifted[index] = position;
    }
    counts.fill(0, 0, classCount);
    for (let index = 0; index < size; index += 1) counts[classes[shifted[index]]] += 1;
    for (let index = 1; index < classCount; index += 1) counts[index] += counts[index - 1];
    for (let index = size - 1; index >= 0; index -= 1) {
      const position = shifted[index];
      suffixes[--counts[classes[position]]] = position;
    }

    let nextClassCount = 1;
    nextClasses[suffixes[0]] = 0;
    for (let index = 1; index < size; index += 1) {
      const current = suffixes[index];
      const previous = suffixes[index - 1];
      const currentTail = (current + shift) % size;
      const previousTail = (previous + shift) % size;
      if (classes[current] !== classes[previous]
        || classes[currentTail] !== classes[previousTail]) nextClassCount += 1;
      nextClasses[current] = nextClassCount - 1;
    }
    [classes, nextClasses] = [nextClasses, classes];
    classCount = nextClassCount;
    if (classCount === size) break;
  }

  // 唯一哨兵后缀必定排在首位；只保留真实文本后缀用于二分。
  suffixes = suffixes.subarray(1);
  const compareSuffix = (position, pattern) => {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (position + offset >= text.length) return -1;
      const difference = text.charCodeAt(position + offset) - pattern.charCodeAt(offset);
      if (difference) return difference;
    }
    return 0;
  };
  return (pattern) => {
    if (!pattern) return true;
    let low = 0;
    let high = suffixes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareSuffix(suffixes[middle], pattern) < 0) low = middle + 1;
      else high = middle;
    }
    return low < suffixes.length && compareSuffix(suffixes[low], pattern) === 0;
  };
}

// 少量查询继续使用原生 includes，避免为短文本支付建索引成本；当预计工作量
// 超过阈值时切换到精确后缀索引，阻止“查询数 × 文本长度”的性能退化。
export function createSubstringLookup(text, {
  estimatedPatternCount = 1,
  indexThreshold = DEFAULT_SUBSTRING_INDEX_THRESHOLD,
} = {}) {
  if (typeof text !== 'string') throw new TypeError('TEXT_MUST_BE_STRING');
  const estimated = Number.isSafeInteger(estimatedPatternCount) && estimatedPatternCount > 0
    ? estimatedPatternCount : 1;
  const threshold = Number.isFinite(indexThreshold) && indexThreshold >= 0
    ? indexThreshold : DEFAULT_SUBSTRING_INDEX_THRESHOLD;
  const lookup = text.length * estimated < threshold
    ? (pattern) => text.includes(pattern)
    : createIndexedSubstringLookup(text);
  return (pattern) => {
    if (typeof pattern !== 'string') throw new TypeError('PATTERN_MUST_BE_STRING');
    return lookup(pattern);
  };
}
