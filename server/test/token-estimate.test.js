import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTextTokenEstimator, estimateChatInputTokens, estimateTextTokens,
} from '../token-estimate.js';

test('token 估算区分中文、英文连续串和空白', () => {
  assert.equal(estimateTextTokens('中文测试'), 4);
  assert.equal(estimateTextTokens('abcdefgh'), 2);
  assert.equal(estimateTextTokens('a b'), 3);
  assert.equal(estimateTextTokens(''), 0);
  assert.ok(estimateTextTokens('修复 API 返回 JSON。') >= 7);
});

test('流式英文片段跨 delta 保留连续串，不按每个字符重复计费', () => {
  const estimator = createTextTokenEstimator();
  for (const part of ['a', 'b', 'cd', 'efgh']) estimator.add(part);
  assert.equal(estimator.estimate(), 2);
});

test('聊天输入估算包含 system、消息正文和协议开销', () => {
  const estimate = estimateChatInputTokens('系统', [
    { role: 'user', content: 'abcdefgh' },
    { role: 'assistant', content: '中文' },
  ]);
  assert.equal(estimate, 16);
});
