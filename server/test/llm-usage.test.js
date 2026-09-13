import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../index.js';
import { parseSSEChunk, streamChat } from '../llm.js';
import {
  llmUsageSnapshot, recordLlmUsage, resetLlmUsageForTests,
} from '../llm-usage.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetLlmUsageForTests();
});

test('用量聚合只保存任务元数据，不保存提示词或密钥', () => {
  resetLlmUsageForTests();
  recordLlmUsage({
    task: 'chapter-generate', model: 'writer-model', status: 'success',
    inputChars: 1200, outputChars: 3000, durationMs: 450,
  });
  recordLlmUsage({
    task: 'chapter-review', model: 'review-model', status: 'failed',
    errorCode: 'LLM_HTTP_429: secret detail', inputChars: 800, durationMs: 20,
  });
  const snapshot = llmUsageSnapshot();
  assert.deepEqual(snapshot.totals, {
    calls: 2, succeeded: 1, failed: 1, cancelled: 0,
    inputChars: 2000, outputChars: 3000,
    estimatedInputTokens: 0, estimatedOutputTokens: 0,
    providerInputTokens: 0, providerOutputTokens: 0, providerUsageCalls: 0,
    billingInputTokens: 0, billingOutputTokens: 0, durationMs: 470,
  });
  assert.equal(snapshot.recent[1].errorCode, 'LLM_HTTP_429');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret detail|API Key|正文原文/u);
});

test('同名模型在不同服务地址下分别聚合，避免价格和用量混算', () => {
  resetLlmUsageForTests();
  recordLlmUsage({
    task: 'chapter-generate', provider: 'https://a.example/v1', model: 'same-model',
    status: 'success', estimatedInputTokens: 10,
  });
  recordLlmUsage({
    task: 'chapter-generate', provider: 'https://b.example/v1', model: 'same-model',
    status: 'success', estimatedInputTokens: 20,
  });
  const snapshot = llmUsageSnapshot();
  assert.equal(snapshot.models.length, 2);
  assert.deepEqual(snapshot.models.map((entry) => entry.provider).sort(), [
    'https://a.example/v1', 'https://b.example/v1',
  ]);
  assert.notEqual(snapshot.models[0].key, snapshot.models[1].key);
});

test('同一网络块中 finish_reason 后的 usage 尾帧可读取但正文不可追加', () => {
  const parsed = parseSSEChunk(
    'data: {"choices":[{"delta":{"content":"正文"},"finish_reason":"stop"}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n'
      + 'data: {"choices":[{"delta":{"content":"不应追加"}}]}\n\n',
  );
  assert.deepEqual(parsed.deltas, ['正文']);
  assert.deepEqual(parsed.usage, { inputTokens: 9, outputTokens: 3 });
});

test('streamChat 成功后记录实际输入输出字符和任务名', async () => {
  resetLlmUsageForTests();
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  let output = '';
  for await (const delta of streamChat({
    config: { baseUrl: 'https://model.test/v1', model: 'writer' },
    system: '系统', messages: [{ role: 'user', content: '任务' }],
    task: 'chapter-generate',
  })) output += delta;
  assert.equal(output, '正文');
  const snapshot = llmUsageSnapshot();
  assert.equal(snapshot.totals.calls, 1);
  assert.equal(snapshot.totals.succeeded, 1);
  assert.equal(snapshot.totals.inputChars, 4);
  assert.equal(snapshot.totals.outputChars, 2);
  assert.equal(snapshot.totals.estimatedInputTokens, 10);
  assert.equal(snapshot.totals.estimatedOutputTokens, 2);
  assert.equal(snapshot.totals.providerInputTokens, 7);
  assert.equal(snapshot.totals.providerOutputTokens, 2);
  assert.equal(snapshot.totals.providerUsageCalls, 1);
  assert.equal(snapshot.totals.billingInputTokens, 7);
  assert.equal(snapshot.totals.billingOutputTokens, 2);
  assert.equal(snapshot.models[0].provider, 'https://model.test/v1');
  assert.equal(snapshot.models[0].model, 'writer');
  assert.equal(snapshot.models[0].billingInputTokens, 7);
  assert.equal(snapshot.recent[0].task, 'chapter-generate');
});

test('本地 API 暴露有界用量快照', async () => {
  resetLlmUsageForTests();
  recordLlmUsage({ task: 'stage-summary', model: 'digest', status: 'success' });
  const { base, server } = await startTestServer(createApp());
  try {
    const response = await fetch(`${base}/api/llm-usage`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totals.calls, 1);
    assert.equal(body.recent[0].task, 'stage-summary');
    assert.match(body.note, /本地近似/u);
    assert.match(body.note, /不等于实际费用/u);
  } finally {
    await stopTestServer(server);
  }
});
