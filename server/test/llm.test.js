import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEChunk, extractDigest } from '../llm.js';

test('parseSSEChunk 抽取 delta 并保留残尾', () => {
  const buf =
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"世';  // 残缺
  const { deltas, rest } = parseSSEChunk(buf);
  assert.deepEqual(deltas, ['你', '好']);
  assert.match(rest, /世/);
});

test('parseSSEChunk 忽略 [DONE]', () => {
  const { deltas } = parseSSEChunk('data: [DONE]\n\n');
  assert.deepEqual(deltas, []);
});

test('extractDigest 直接解析合法 JSON', () => {
  const d = extractDigest('{"summary":"S","progress":"P","newCharacters":[]}');
  assert.equal(d.summary, 'S');
  assert.equal(d.progress, 'P');
});

test('extractDigest 从夹带文字中截取', () => {
  const d = extractDigest('好的，结果如下：{"summary":"S","progress":"P","newCharacters":[{"name":"张三","role":"路人","desc":"x"}]}。完毕');
  assert.equal(d.newCharacters.length, 1);
  assert.equal(d.newCharacters[0].name, '张三');
});

test('extractDigest 无法解析时返回空结构', () => {
  const d = extractDigest('抱歉我不会');
  assert.deepEqual(d, { summary: '', progress: '', newCharacters: [] });
});
