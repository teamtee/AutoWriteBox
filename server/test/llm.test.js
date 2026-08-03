import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEChunk, extractDigest, sanitizeGeneratedTitle, streamChat } from '../llm.js';

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

test('streamChat 将 abort signal 传给 fetch', async () => {
  const realFetch = globalThis.fetch;
  const ctrl = new AbortController();
  let capturedSignal;
  try {
    globalThis.fetch = async (url, init) => {
      capturedSignal = init.signal;
      return new Response('data: [DONE]\n\n', { status: 200 });
    };
    for await (const _ of streamChat({
      config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
      system: 's',
      messages: [],
      signal: ctrl.signal,
    })) {
      // no deltas
    }
    assert.equal(capturedSignal, ctrl.signal);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 在响应结束时解析未以空行结尾的最后 SSE 事件', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":"最后一段"}}]}',
      { status: 200 },
    );

    const chunks = [];
    for await (const d of streamChat({
      config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
      system: 's',
      messages: [],
    })) {
      chunks.push(d);
    }

    assert.deepEqual(chunks, ['最后一段']);
  } finally {
    globalThis.fetch = realFetch;
  }
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
  assert.deepEqual(d, {
    chapterTitle: '', sectionTitle: '',
    summary: '', progress: '', newCharacters: [],
  });
});

test('sanitizeGeneratedTitle 清理格式并截断到 10 字', () => {
  assert.equal(sanitizeGeneratedTitle('《雾城来客》'), '雾城来客');
  assert.equal(sanitizeGeneratedTitle('书名：第一章 · 夜雨来客'), '夜雨来客');
  assert.equal(sanitizeGeneratedTitle('书名：第一部：暗潮初现'), '暗潮初现');
  assert.equal(sanitizeGeneratedTitle('章名：第十二章 · 夜雨来客', '章'), '夜雨来客');
  assert.equal(sanitizeGeneratedTitle('部名：第一部：暗潮初现', '部'), '暗潮初现');
  assert.equal(sanitizeGeneratedTitle('第一行标题\n第二行解释'), '第一行标题');
  assert.equal(sanitizeGeneratedTitle('一二三四五六七八九十十一'), '一二三四五六七八九十');
  assert.equal(sanitizeGeneratedTitle('《》'), '');
});

test('sanitizeGeneratedTitle 清理通用序号前缀', () => {
  assert.equal(sanitizeGeneratedTitle('1. 雾城来客'), '雾城来客');
  assert.equal(sanitizeGeneratedTitle('一、雾城来客'), '雾城来客');
  assert.equal(sanitizeGeneratedTitle('（1）雾城来客'), '雾城来客');
});

test('extractDigest 解析并清洗章名部名', () => {
  const d = extractDigest(JSON.stringify({
    chapterTitle: '第3章 · 夜雨来客',
    sectionTitle: '第二部：暗潮初现',
    summary: 'S', progress: 'P', newCharacters: [],
  }));
  assert.equal(d.chapterTitle, '夜雨来客');
  assert.equal(d.sectionTitle, '暗潮初现');
});

test('extractDigest 丢弃类型非法的摘要进度和人物条目', () => {
  const d = extractDigest(JSON.stringify({
    summary: { bad: 'object' },
    progress: ['bad'],
    newCharacters: [
      'bad',
      { name: '张三', role: 1, desc: 'x' },
      { name: '李四', role: '新角色', desc: 'y' },
    ],
  }));

  assert.equal(d.summary, '');
  assert.equal(d.progress, '');
  assert.deepEqual(d.newCharacters, [{ name: '李四', role: '新角色', desc: 'y' }]);
});
