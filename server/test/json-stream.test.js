import test from 'node:test';
import assert from 'node:assert/strict';
import { stringifyJsonChunks } from '../json-stream.js';

test('流式 JSON 序列化与 JSON.stringify 的值、顺序和转义一致', () => {
  const value = {
    text: '引号" 反斜杠\\ 控制\b\t\n\f\r\u0000 中文😀',
    loneSurrogates: '\ud800中\udfff',
    numbers: [0, -0, 1.25, Number.NaN, Number.POSITIVE_INFINITY],
    omitted: undefined,
    array: [undefined, () => {}, Symbol('x'), true, null],
    nested: { z: 1, a: 2 },
  };
  assert.equal(
    [...stringifyJsonChunks(value, { maxStringChunkChars: 3 })].join(''),
    JSON.stringify(value),
  );
});

test('流式 JSON 序列化会切分长字符串并拒绝循环与 BigInt', () => {
  const chunks = [...stringifyJsonChunks({ value: '文字'.repeat(100) }, {
    maxStringChunkChars: 8,
  })];
  assert.equal(chunks.join(''), JSON.stringify({ value: '文字'.repeat(100) }));
  assert.ok(chunks.some((chunk) => chunk === '文字文字文字文字'));

  const circular = {};
  circular.self = circular;
  assert.throws(() => [...stringifyJsonChunks(circular)], /circular/i);
  assert.throws(() => [...stringifyJsonChunks(1n)], /BigInt/);
});

test('流式 JSON 对齐 toJSON 键参数、省略规则和装箱基本类型', () => {
  const createValue = (calls) => ({
    omitted: {
      toJSON(key) { calls.push(key); return undefined; },
    },
    converted: {
      toJSON(key) { calls.push(key); return { from: key }; },
    },
    array: [{
      toJSON(key) { calls.push(key); return undefined; },
    }],
    boxed: [new Number(3), new String('文本'), new Boolean(false)],
    once: {
      toJSON(key) {
        calls.push(key);
        return {
          value: 1,
          toJSON() { throw new Error('RETURNED_TO_JSON_MUST_NOT_RUN'); },
        };
      },
    },
  });
  const expectedCalls = [];
  const actualCalls = [];
  const expected = JSON.stringify(createValue(expectedCalls));
  const actual = [...stringifyJsonChunks(createValue(actualCalls))].join('');

  assert.equal(actual, expected);
  assert.deepEqual(actualCalls, expectedCalls);
  assert.deepEqual(actualCalls, ['omitted', 'converted', '0', 'once']);
});
