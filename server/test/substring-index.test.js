import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubstringLookup } from '../substring-index.js';

test('短文本查询保持 String.includes 的完整语义', () => {
  const text = '序章😀夜雨\u0000终章';
  const lookup = createSubstringLookup(text);
  for (const pattern of ['', '序章', '😀', '夜雨\u0000', '终章', '不存在']) {
    assert.equal(lookup(pattern), text.includes(pattern), pattern);
  }
});

test('强制后缀索引时对 UTF-16 边界和随机子串保持精确', () => {
  let seed = 7;
  const chars = [];
  for (let index = 0; index < 2_000; index += 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    chars.push(String.fromCharCode(seed % 0x1_0000));
  }
  const text = `开头😀${chars.join('')}\ud800结尾`;
  const lookup = createSubstringLookup(text, { indexThreshold: 0 });
  const patterns = ['开头', '😀', '\ud800', '结尾', '绝对不存在'];
  for (let index = 0; index < 200; index += 1) {
    const start = (index * 97) % text.length;
    patterns.push(text.slice(start, Math.min(text.length, start + (index % 30))));
  }
  for (const pattern of patterns) {
    assert.equal(lookup(pattern), text.includes(pattern), JSON.stringify(pattern));
  }
});

test('子串索引拒绝非字符串输入并容忍非法性能参数', () => {
  assert.throws(() => createSubstringLookup(null), /TEXT_MUST_BE_STRING/);
  const lookup = createSubstringLookup('正文', {
    estimatedPatternCount: -1,
    indexThreshold: Number.NaN,
  });
  assert.throws(() => lookup(null), /PATTERN_MUST_BE_STRING/);
  assert.equal(lookup('正文'), true);
});
