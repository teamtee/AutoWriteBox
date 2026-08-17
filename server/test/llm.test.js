import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverLlmModels, parseSSEChunk, extractDigest, extractChapterReview, extractGeneratedTitles, extractSectionsPlan, extractWritingAssetAnalysis, nonStreamChat, sanitizeChapterReview, sanitizeGeneratedTitle, sanitizeWritingAssetAnalysis, streamChat, validateLlmConfig } from '../llm.js';
import {
  LLM_OUTPUT_JOIN_CHUNK_CHARS,
  MAX_DIGEST_CHARACTERS, MAX_DIGEST_PROGRESS_CHARS, MAX_DIGEST_SUMMARY_CHARS,
  MAX_LLM_INPUT_CHARS, MAX_LLM_OUTPUT_CHARS, MAX_LLM_STREAM_BUFFER_CHARS,
  MAX_LLM_STREAM_BYTES, MAX_LLM_MODELS_RESPONSE_BYTES, MAX_PLANNED_SECTIONS,
  MAX_REVIEW_CHECK_DETAIL_CHARS, MAX_REVIEW_INSTRUCTION_CHARS,
  MAX_SECTION_PLAN_FIELD_CHARS,
} from '../limits.js';

test('模型发现只请求已配置主机并清洗、去重模型 ID', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://models.example/v1/models');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Authorization, 'Bearer sk-secret');
      return new Response(JSON.stringify({ data: [
        { id: 'model-a' }, { id: ' model-b ' }, { id: 'model-a' },
        { id: 'bad\nmodel' }, { missing: true },
      ] }), { status: 200 });
    };

    const result = await discoverLlmModels({
      config: {
        baseUrl: 'https://models.example/v1', model: 'model-a', apiKey: 'sk-secret',
      },
    });
    assert.deepEqual(result, { models: ['model-a', 'model-b'], truncated: false });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('模型发现拒绝跳转、异常结构和超大响应', async () => {
  const realFetch = globalThis.fetch;
  const config = { baseUrl: 'https://models.example/v1', model: 'model-a' };
  try {
    globalThis.fetch = async () => new Response(null, {
      status: 302, headers: { Location: 'https://other.example/models' },
    });
    await assert.rejects(() => discoverLlmModels({ config }), /LLM_REDIRECT_NOT_ALLOWED/);

    globalThis.fetch = async () => new Response('{"models":[]}', { status: 200 });
    await assert.rejects(() => discoverLlmModels({ config }), /LLM_MODELS_RESPONSE_INVALID/);

    globalThis.fetch = async () => new Response(
      'x'.repeat(MAX_LLM_MODELS_RESPONSE_BYTES + 1), { status: 200 },
    );
    await assert.rejects(() => discoverLlmModels({ config }), /LLM_MODELS_RESPONSE_TOO_LARGE/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('模型发现的鉴权失败不回显 API Key', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: 'bad key sk-discovery-secret' },
    }), { status: 401 });
    await assert.rejects(() => discoverLlmModels({
      config: {
        baseUrl: 'https://models.example/v1', model: 'model-a',
        apiKey: 'sk-discovery-secret',
      },
    }), (error) => error.message === 'LLM_HTTP_401');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('独立标题模型结果会清理章部序号并拒绝无效结构', () => {
  assert.deepEqual(extractGeneratedTitles(
    '说明\n{"chapterTitle":"第12章：雨夜来客","sectionTitle":"第二部·暗潮"}',
  ), { chapterTitle: '雨夜来客', sectionTitle: '暗潮' });
  assert.equal(extractGeneratedTitles('{"chapterTitle":3}'), null);
});

test('parseSSEChunk 抽取 delta 并保留残尾', () => {
  const buf =
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"世';  // 残缺
  const { deltas, rest } = parseSSEChunk(buf);
  assert.deepEqual(deltas, ['你', '好']);
  assert.match(rest, /世/);
});

test('parseSSEChunk 识别 [DONE] 终止标记', () => {
  const { deltas, finished } = parseSSEChunk('data: [DONE]\n\n');
  assert.deepEqual(deltas, []);
  assert.equal(finished, true);
});

test('parseSSEChunk 识别 finish_reason 并拒绝完整的畸形事件', () => {
  const stopped = parseSSEChunk('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  assert.equal(stopped.finished, true);
  assert.equal(stopped.finishReason, 'stop');
  const malformed = parseSSEChunk('data: {bad json}\n\n');
  assert.deepEqual(malformed.errors, ['LLM_SSE_INVALID_JSON']);
});

test('parseSSEChunk 以首个终止帧为边界，不被后续 stop 或正文覆盖', () => {
  const parsed = parseSSEChunk(
    'data: {"choices":[{"delta":{"content":"已截断尾段"},"finish_reason":"length"}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"不应接受的正文"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n',
  );

  assert.deepEqual(parsed.deltas, ['已截断尾段']);
  assert.equal(parsed.finished, true);
  assert.equal(parsed.finishReason, 'length');
});

test('parseSSEChunk 拒绝会污染正文或绕过输出计数的异常事件字段', () => {
  for (const payload of [
    '[]',
    '{"choices":{}}',
    '{"choices":["bad-choice"]}',
    '{"choices":[{"delta":"bad-delta"}]}',
    '{"choices":[{"delta":{"content":{"text":"伪正文"}}}]}',
    '{"choices":[{"delta":{"content":7}}]}',
    '{"choices":[{"delta":{},"finish_reason":7}]}',
  ]) {
    const parsed = parseSSEChunk(`data: ${payload}\n\n`);
    assert.deepEqual(parsed.deltas, []);
    assert.deepEqual(parsed.errors, ['LLM_SSE_INVALID_EVENT']);
    assert.equal(parsed.finished, false);
  }
});

test('streamChat 不把非字符串 content 强制转换并保存为正文', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":{"text":"伪正文"}}}]}\n\n'
        + 'data: [DONE]\n\n',
      { status: 200 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_STREAM_ERROR: LLM_SSE_INVALID_EVENT/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 拒绝会被默认解码器静默替换的非法 UTF-8', async () => {
  const realFetch = globalThis.fetch;
  try {
    const bytes = Buffer.from(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '可信正文' } }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    const textOffset = bytes.indexOf(Buffer.from('可信正文'));
    assert.ok(textOffset >= 0);
    bytes[textOffset] = 0xff;
    globalThis.fetch = async () => new Response(bytes, { status: 200 });

    let output = '';
    await assert.rejects(async () => {
      for await (const delta of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm' },
        system: 's', messages: [],
      })) output += delta;
    }, /LLM_STREAM_ERROR: LLM_SSE_INVALID_UTF8/);
    assert.equal(output, '');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 严格解码时仍支持多字节字符跨网络分片', async () => {
  const realFetch = globalThis.fetch;
  try {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"可信正文"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    );
    let offset = 0;
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 1));
        offset += 1;
      },
    }), { status: 200 });

    let output = '';
    for await (const delta of streamChat({
      config: { baseUrl: 'https://example.test', model: 'm' },
      system: 's', messages: [],
    })) output += delta;
    assert.equal(output, '可信正文');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('nonStreamChat 合并大量微小 delta 时跨分片保持完整顺序', async () => {
  const realFetch = globalThis.fetch;
  try {
    const generated = '字'.repeat(LLM_OUTPUT_JOIN_CHUNK_CHARS + 3);
    const frames = Array.from(generated, (character) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: character } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
    globalThis.fetch = async () => new Response(frames, { status: 200 });

    const output = await nonStreamChat({
      config: { baseUrl: 'https://example.test', model: 'm' },
      system: 's',
      messages: [],
    });

    assert.equal(output, generated);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('parseSSEChunk 兼容 CRLF 分隔符', () => {
  const { deltas, rest } = parseSSEChunk(
    'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"尾',
  );
  assert.deepEqual(deltas, ['你好']);
  assert.match(rest, /尾/);
});

test('parseSSEChunk 提取 HTTP 200 流内错误', () => {
  const { errors } = parseSSEChunk('data: {"error":{"message":"quota exceeded"}}\n\n');
  assert.deepEqual(errors, ['quota exceeded']);
});

test('parseSSEChunk 在首个错误帧停止，不累计后续攻击帧或正文', () => {
  const upstreamError = parseSSEChunk(
    'data: {"error":{"message":"quota exceeded"}}\n\n'
      + 'data: {broken}\n\n'
      + 'data: {"choices":[{"delta":{"content":"不应接受"}}]}\n\n',
  );
  assert.deepEqual(upstreamError.errors, ['quota exceeded']);
  assert.deepEqual(upstreamError.deltas, []);

  const malformed = parseSSEChunk(
    'data: {broken}\n\n'
      + 'data: {also broken}\n\n'
      + 'data: {"choices":[{"delta":{"content":"不应接受"}}]}\n\n',
  );
  assert.deepEqual(malformed.errors, ['LLM_SSE_INVALID_JSON']);
  assert.deepEqual(malformed.deltas, []);
});

test('streamChat 将流内错误转为异常', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      'data: {"error":{"message":"quota exceeded"}}\n\n',
      { status: 200 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_STREAM_ERROR.*quota exceeded/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 提取受限的 HTTP 错误详情但不回显鉴权响应', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: 'quota exceeded' } }),
      { status: 429 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_HTTP_429: quota exceeded/);

    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: 'Incorrect key sk-secret' } }),
      { status: 401 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'sk-secret' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, (error) => error.message === 'LLM_HTTP_401');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 读取 HTTP 错误详情失败时取消未读响应并释放 reader', async () => {
  const realFetch = globalThis.fetch;
  let cancelled = false;
  let released = false;
  try {
    globalThis.fetch = async () => ({
      status: 429,
      ok: false,
      body: {
        getReader: () => ({
          read: async () => { throw new Error('UPSTREAM_ERROR_BODY_FAILED'); },
          cancel: async () => { cancelled = true; },
          releaseLock: () => { released = true; },
        }),
      },
    });

    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /UPSTREAM_ERROR_BODY_FAILED/);
    assert.equal(cancelled, true);
    assert.equal(released, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 对任意状态和流内错误统一脱敏 API Key', async () => {
  const realFetch = globalThis.fetch;
  const consume = async () => {
    for await (const _ of streamChat({
      config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'sk-secret-value' },
      system: 's', messages: [],
    })) { /* no-op */ }
  };
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: 'bad Authorization: Bearer sk-secret-value' } }),
      { status: 400 },
    );
    await assert.rejects(consume, (error) => {
      assert.doesNotMatch(error.message, /sk-secret-value/);
      assert.match(error.message, /REDACTED/);
      return true;
    });

    globalThis.fetch = async () => new Response(
      'data: {"error":{"message":"upstream echoed sk-secret-value"}}\n\n',
      { status: 200 },
    );
    await assert.rejects(consume, (error) => {
      assert.doesNotMatch(error.message, /sk-secret-value/);
      assert.match(error.message, /REDACTED/);
      return true;
    });

    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: 'token=x' } }),
      { status: 429 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'x' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, (error) => {
      assert.doesNotMatch(error.message, /token=x/);
      assert.match(error.message, /REDACTED/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 在网络请求前校验 Base URL 和模型名', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls += 1; return new Response(); };
    for (const [config, expected] of [
      [{ baseUrl: '', model: 'm' }, /LLM_BASE_URL_REQUIRED/],
      [{ baseUrl: 'https://example.test/v1', model: '   ' }, /LLM_MODEL_REQUIRED/],
      [{ baseUrl: 'https://example.test/v1\n', model: 'm' }, /LLM_BASE_URL_INVALID/],
      [{ baseUrl: 'https://example.test/v1', model: 'model\nname' }, /LLM_MODEL_INVALID/],
      [{ baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'sk-good\r\nX-Test: injected' }, /LLM_API_KEY_INVALID/],
      [{ baseUrl: 'ftp://example.test/v1', model: 'm' }, /LLM_BASE_URL_INVALID/],
      [{ baseUrl: 'https://example.test/v1?token=x', model: 'm' }, /LLM_BASE_URL_INVALID/],
      [{ baseUrl: 'https://example.test/v1?', model: 'm' }, /LLM_BASE_URL_INVALID/],
      [{ baseUrl: 'https://example.test/v1#', model: 'm' }, /LLM_BASE_URL_INVALID/],
      [{ baseUrl: 'https://user:password@example.test/v1', model: 'm' }, /LLM_BASE_URL_INVALID/],
      [{ baseUrl: 'http://example.test/v1', model: 'm', apiKey: 'sk-secret' }, /LLM_INSECURE_API_KEY_TRANSPORT/],
    ]) {
      await assert.rejects(async () => {
        for await (const _ of streamChat({ config, system: 's', messages: [] })) { /* no-op */ }
      }, expected);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('validateLlmConfig 只允许带 Key 的明文 HTTP 连接严格回环主机', () => {
  for (const baseUrl of [
    'http://localhost:11434/v1',
    'http://localhost.:11434/v1',
    'http://127.1:11434/v1',
    'http://2130706433:11434/v1',
    'http://[::1]:11434/v1',
  ]) {
    assert.doesNotThrow(() => validateLlmConfig({ baseUrl, model: 'm', apiKey: 'sk-local' }));
  }
  assert.doesNotThrow(() => validateLlmConfig({
    baseUrl: 'http://lan-model.example/v1', model: 'm', apiKey: '',
  }));
  assert.doesNotThrow(() => validateLlmConfig({
    baseUrl: 'https://remote-model.example/v1', model: 'm', apiKey: 'sk-secure',
  }));
  assert.throws(() => validateLlmConfig({
    baseUrl: 'http://192.168.1.20:11434/v1', model: 'm', apiKey: 'sk-plaintext',
  }), /LLM_INSECURE_API_KEY_TRANSPORT/);
  assert.equal(validateLlmConfig({
    baseUrl: ' HTTPS://Example.Test:443/v1/ ', model: ' m ', apiKey: '',
  }).baseUrl, 'https://example.test/v1');
});

test('streamChat 在网络请求前拒绝超大上下文', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls += 1; return new Response(); };
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm' },
        system: 'x'.repeat(MAX_LLM_INPUT_CHARS + 1),
        messages: [],
      })) { /* no-op */ }
    }, /LLM_INPUT_TOO_LARGE/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 不把密钥和作品上下文跟随重定向发往其它地址', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  let capturedInit;
  try {
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      capturedInit = init;
      return new Response('', {
        status: 307,
        headers: { Location: 'https://redirected.example/v1/chat/completions' },
      });
    };
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://configured.example/v1', model: 'm', apiKey: 'sk-secret' },
        system: '私密作品设定', messages: [],
      })) { /* no-op */ }
    }, /LLM_REDIRECT_NOT_ALLOWED/);
    assert.equal(calls, 1);
    assert.equal(capturedInit.redirect, 'manual');
    assert.match(capturedInit.headers.Authorization, /sk-secret/);
    assert.match(capturedInit.body, /私密作品设定/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 最多允许两个并发模型请求', async () => {
  const realFetch = globalThis.fetch;
  const controllers = [];
  let twoStartedResolve;
  const twoStarted = new Promise((resolve) => { twoStartedResolve = resolve; });
  const consume = async () => {
    for await (const _ of streamChat({
      config: { baseUrl: 'https://example.test', model: 'm' },
      system: 's', messages: [],
    })) { /* no-op */ }
  };
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controllers.push(controller);
        if (controllers.length === 2) twoStartedResolve();
      },
    }), { status: 200 });
    const first = consume();
    const second = consume();
    await twoStarted;

    await assert.rejects(consume(), /LLM_BUSY/);

    const completed = new TextEncoder().encode('data: [DONE]\n\n');
    for (const controller of controllers) {
      controller.enqueue(completed);
      controller.close();
    }
    await Promise.all([first, second]);
  } finally {
    for (const controller of controllers) {
      try { controller.close(); } catch { /* already closed */ }
    }
    globalThis.fetch = realFetch;
  }
});

test('streamChat 支持本地免密服务并清理配置首尾空白', async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl;
  let capturedInit;
  try {
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response('data: [DONE]\n\n', { status: 200 });
    };
    for await (const _ of streamChat({
      config: { baseUrl: '  http://127.0.0.1:11434/v1/  ', model: ' local-model ', apiKey: '   ' },
      system: 's', messages: [],
    })) { /* no-op */ }

    assert.equal(capturedUrl, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(capturedInit.headers.Authorization, undefined);
    assert.equal(JSON.parse(capturedInit.body).model, 'local-model');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 将 abort signal 传给 fetch', async () => {
  const realFetch = globalThis.fetch;
  const ctrl = new AbortController();
  let capturedSignal;
  let fetchStartedResolve;
  const fetchStarted = new Promise((resolve) => { fetchStartedResolve = resolve; });
  try {
    globalThis.fetch = async (url, init) => new Promise((resolve, reject) => {
      capturedSignal = init.signal;
      fetchStartedResolve();
      init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('ABORTED')), { once: true });
    });
    const consuming = (async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
        system: 's', messages: [], signal: ctrl.signal,
      })) { /* no-op */ }
    })();
    await fetchStarted;
    ctrl.abort(new Error('CLIENT_ABORTED'));
    await assert.rejects(consuming, /CLIENT_ABORTED/);
    assert.equal(capturedSignal.aborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 在配置的超时时间后中止上游请求', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('ABORTED')), { once: true });
    });
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k', requestTimeoutMs: 5 },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_TIMEOUT/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 在响应结束时解析未以空行结尾的最后 SSE 事件', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":"最后一段"},"finish_reason":"stop"}]}',
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

test('streamChat 收到 DONE 后不等待上游关闭连接并主动取消响应体', async () => {
  const realFetch = globalThis.fetch;
  const external = new AbortController();
  let bodyCancelled = false;
  let timeout;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"完整正文"}}]}\n\n'
            + 'data: [DONE]\n\n',
        ));
        // 故意不 close：协议已完成，但部分兼容服务会继续保持 HTTP 连接。
      },
      cancel() { bodyCancelled = true; },
    }), { status: 200 });
    const consume = async () => {
      let text = '';
      for await (const delta of streamChat({
        config: {
          baseUrl: 'https://example.test', model: 'm', requestTimeoutMs: 1000,
        },
        system: 's', messages: [], signal: external.signal,
      })) text += delta;
      return text;
    };
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('TEST_STREAM_DID_NOT_FINISH')), 100);
    });

    assert.equal(await Promise.race([consume(), timedOut]), '完整正文');
    assert.equal(bodyCancelled, true);
  } finally {
    clearTimeout(timeout);
    external.abort();
    globalThis.fetch = realFetch;
  }
});

test('streamChat 部分输出后无终止标记时拒绝当作成功', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":"半章内容"}}]}\n\n',
      { status: 200 },
    );
    const chunks = [];
    await assert.rejects(async () => {
      for await (const d of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
        system: 's', messages: [],
      })) chunks.push(d);
    }, /LLM_STREAM_INCOMPLETE/);
    assert.deepEqual(chunks, ['半章内容']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat finish_reason=length 时拒绝保存截断输出', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":"被截断"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
      'data: [DONE]\n\n',
      { status: 200 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_FINISH_LENGTH/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 拒绝超过安全上限的模型输出', async () => {
  const realFetch = globalThis.fetch;
  try {
    const oversized = 'x'.repeat(MAX_LLM_OUTPUT_CHARS + 1);
    globalThis.fetch = async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: oversized } }] })}\n\n` +
      'data: [DONE]\n\n',
      { status: 200 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_RESPONSE_TOO_LARGE/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 拒绝无分隔符且持续增长的上游流缓冲', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      'x'.repeat(MAX_LLM_STREAM_BUFFER_CHARS + 1),
      { status: 200 },
    );
    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', apiKey: 'k' },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_STREAM_BUFFER_TOO_LARGE/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamChat 拒绝由无限小帧绕过缓冲上限的超大累计传输', async () => {
  const realFetch = globalThis.fetch;
  const chunkBytes = 1024 * 1024;
  const comment = new TextEncoder().encode(`:${'x'.repeat(chunkBytes - 3)}\n\n`);
  let sentBytes = 0;
  let cancelled = false;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(comment);
        sentBytes += comment.byteLength;
      },
      cancel() { cancelled = true; },
    }), { status: 200 });

    await assert.rejects(async () => {
      for await (const _ of streamChat({
        config: { baseUrl: 'https://example.test', model: 'm', requestTimeoutMs: 5000 },
        system: 's', messages: [],
      })) { /* no-op */ }
    }, /LLM_STREAM_TOO_LARGE/);
    assert.ok(sentBytes > MAX_LLM_STREAM_BYTES);
    assert.ok(comment.byteLength < MAX_LLM_STREAM_BUFFER_CHARS);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('extractDigest 兼容旧 newCharacters 字段', () => {
  const d = extractDigest('{"summary":"S","progress":"P","newCharacters":[]}');
  assert.equal(d.summary, 'S');
  assert.equal(d.progress, 'P');
  assert.equal(d.digestParsed, true);
  assert.equal(d.digestCharactersParsed, true);
});

test('extractDigest 解析当前 characters 人物快照字段', () => {
  const d = extractDigest(JSON.stringify({
    summary: 'S',
    progress: 'P',
    characters: [{ name: '陈默', role: '主角', desc: '本章末负伤' }],
  }));

  assert.deepEqual(d.newCharacters, [
    { name: '陈默', role: '主角', desc: '本章末负伤' },
  ]);
  assert.equal(d.digestParsed, true);
  assert.equal(d.digestCharactersParsed, true);
});

test('extractDigest 提取只锚定正文末态的跨章交接快照', () => {
  const d = extractDigest(JSON.stringify({
    summary: '主角逃到码头', progress: '沿水路追查', characters: [],
    handoff: {
      viewpoint: '林越', time: '暴雨当夜', location: '码头号棚',
      ongoingAction: '正把账册递给旧敌', immediatePressure: '追兵已封锁出口',
      characterState: '林越左臂受伤，旧敌尚未表态', resourceState: '账册在林越手中',
      knowledgeBoundary: '林越只知账册被篡改，不知操作者',
      unresolvedCausality: '交出账册将决定旧敌是否帮他破围',
    },
  }));
  assert.equal(d.digestHandoffParsed, true);
  assert.equal(d.handoff.location, '码头号棚');
  assert.equal(d.handoff.resourceState, '账册在林越手中');
});

test('extractDigest 旧模型缺交接快照时保持兼容，非法快照不污染其它摘要', () => {
  const legacy = extractDigest('{"summary":"S","progress":"P","characters":[]}');
  assert.equal(legacy.digestHandoffParsed, false);
  assert.equal(legacy.handoff.location, '');
  const malformed = extractDigest(JSON.stringify({
    summary: 'S', progress: 'P', characters: [], handoff: { location: 42 },
  }));
  assert.equal(malformed.summary, 'S');
  assert.equal(malformed.digestHandoffParsed, false);
  assert.equal(malformed.handoff.location, '');
});

test('extractDigest 合法 JSON 缺少人物字段时标记为不完整', () => {
  const d = extractDigest('{"summary":"S","progress":"P"}');
  assert.deepEqual(d.newCharacters, []);
  assert.equal(d.digestParsed, true);
  assert.equal(d.digestCharactersParsed, false);
});

test('extractDigest 从夹带文字中截取', () => {
  const d = extractDigest('好的，结果如下：{"summary":"S","progress":"P","newCharacters":[{"name":"张三","role":"路人","desc":"x"}]}。完毕');
  assert.equal(d.newCharacters.length, 1);
  assert.equal(d.newCharacters[0].name, '张三');
});

test('extractDigest 跳过前后无效大括号并提取首个合法对象', () => {
  const valid = JSON.stringify({ summary: 'S', progress: 'P', newCharacters: [] });
  const d = extractDigest(`格式示例 {summary: "..."}，实际结果：${valid}，补充 {done}`);
  assert.equal(d.summary, 'S');
  assert.equal(d.progress, 'P');
});

test('extractDigest 无法解析时返回空结构', () => {
  const d = extractDigest('抱歉我不会');
  assert.deepEqual(d, {
    chapterTitle: '', sectionTitle: '',
    summary: '', progress: '', handoff: {
      viewpoint: '', time: '', location: '', ongoingAction: '', immediatePressure: '',
      characterState: '', resourceState: '', knowledgeBoundary: '', unresolvedCausality: '',
    }, newCharacters: [], memoryCandidates: [],
  });
  assert.equal(d.digestParsed, false);
  assert.equal(d.digestCharactersParsed, false);
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

const reviewCheckIds = [
  'goldenChapter', 'premisePromise', 'chapterGoal', 'obstacleEscalation',
  'characterChoice', 'sceneExecution', 'effectiveIncrement', 'payoff', 'endingHook',
  'tensionDynamics', 'foreshadowingExecution', 'worldExpansion', 'proseHumanity',
  'expressionBalance', 'repetitionRisk', 'longArcProgress', 'styleConsistency',
  'packagingPromise',
  'contentRisk',
];
const reviewCheckPayload = (overrides = {}) => reviewCheckIds.map((id) => ({
  id,
  status: id === 'repetitionRisk' ? 'risk' : 'pass',
  detail: `${id} 的正文依据`,
  ...(overrides[id] ?? {}),
}));
const rhythmFingerprint = {
  pressurePattern: 'false-relief', resolutionMethod: 'wit', payoffScale: 'chapter',
  hookMechanism: 'new-information', costType: 'identity',
};

test('extractChapterReview 直接解析合法 JSON', () => {
  const r = extractChapterReview('{"score":78,"verdict":"冲突成立","issues":[{"title":"冲突弱","detail":"缺少导火索"}],"suggestions":[{"label":"强化冲突","instruction":"加导火索"}]}');
  assert.equal(r.score, 78);
  assert.equal(r.verdict, '冲突成立');
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].title, '冲突弱');
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].label, '强化冲突');
});

test('extractChapterReview 有策划时要求逐项差异并只带入未决项', () => {
  const chapterPlan = {
    goal: '拿回账本', obstacle: '', choice: '', payoff: '揭露内鬼',
    hook: '', notes: '', scenes: [],
  };
  const payload = {
    score: 72, verdict: '目标部分落地',
    issues: [{ title: '兑现延后', detail: '内鬼尚未揭示' }],
    suggestions: [{ label: '补兑现', instruction: '在结尾给出内鬼证据' }],
    planComparison: {
      overall: 'partial', summary: '账本已拿回，内鬼仍未揭示。',
      items: [
        { target: 'goal', outcome: 'fulfilled', evidence: '主角从仓库拿回账本。' },
        { target: 'payoff', outcome: 'missed', evidence: '正文只写到一枚模糊印章。' },
      ],
      carryovers: [{
        sourceTarget: 'payoff', text: '核对印章并锁定内鬼',
        reason: '本章已建立证据但未完成揭示。', suggestedField: 'goal',
      }],
    },
  };
  const parsed = extractChapterReview(JSON.stringify(payload), { chapterPlan });
  assert.equal(parsed.planComparison.items.length, 2);
  assert.equal(parsed.planComparison.carryovers[0].suggestedField, 'goal');
  assert.equal(extractChapterReview(JSON.stringify({
    ...payload, planComparison: undefined,
  }), { chapterPlan }), null);
  assert.equal(extractChapterReview(JSON.stringify({
    ...payload,
    planComparison: { ...payload.planComparison, items: payload.planComparison.items.slice(1) },
  }), { chapterPlan }), null);
});

test('extractChapterReview 清洗并保留完整网文章法检查表', () => {
  const r = extractChapterReview(JSON.stringify({
    score: 78,
    verdict: '冲突成立',
    webFictionSignals: {
      chapterFunction: '阶段兑现', conflictType: '身份对抗', emotionTone: '紧张',
      payoffType: '真相揭示', dominantMode: '行动', rhythmFingerprint,
    },
    webFictionChecks: reviewCheckPayload({
      goldenChapter: { status: 'na', detail: '非全书前三章' },
      endingHook: { status: 'risk', detail: '结尾只是生硬断句' },
    }),
    issues: [{ title: '冲突弱', detail: '缺少导火索' }],
    suggestions: [{ label: '强化冲突', instruction: '加导火索' }],
  }));

  assert.equal(r.webFictionChecks.length, 19);
  assert.deepEqual(r.webFictionChecks[0], {
    id: 'goldenChapter', status: 'na', detail: '非全书前三章',
  });
  assert.equal(r.webFictionChecks[8].id, 'endingHook');
  assert.equal(r.webFictionChecks[8].status, 'risk');
  assert.equal(r.webFictionChecks[9].id, 'tensionDynamics');
  assert.equal(r.webFictionSignals.payoffType, '真相揭示');
});

test('extractChapterReview 要求节奏信号字段完整并限制长度', () => {
  const base = {
    score: 78, verdict: '可改', webFictionChecks: reviewCheckPayload(),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  };
  assert.equal(extractChapterReview(JSON.stringify({
    ...base,
    webFictionSignals: {
      chapterFunction: '推进', conflictType: '争执', emotionTone: '紧张',
      payoffType: '信息',
    },
  })), null);
  const parsed = extractChapterReview(JSON.stringify({
    ...base,
    webFictionSignals: {
      chapterFunction: '推'.repeat(100), conflictType: '争执', emotionTone: '紧张',
      payoffType: '信息', dominantMode: '对话', rhythmFingerprint,
    },
  }));
  assert.equal(parsed.webFictionSignals.chapterFunction.length, 40);
  assert.equal(parsed.webFictionSignals.rhythmFingerprint.hookMechanism, 'new-information');
  assert.equal(extractChapterReview(JSON.stringify({
    ...base,
    webFictionSignals: {
      chapterFunction: '推进', conflictType: '争执', emotionTone: '紧张',
      payoffType: '信息', dominantMode: '对话',
      rhythmFingerprint: { ...rhythmFingerprint, costType: 'free-lunch' },
    },
  })), null);
});

test('extractChapterReview 核对写前节奏意图与正文实际指纹', () => {
  const chapterPlan = {
    rhythmIntentVersion: 1,
    rhythmIntent: rhythmFingerprint,
  };
  const base = {
    score: 80, verdict: '节奏意图落地',
    issues: [{ title: '局部拖沓', detail: '中段说明略长' }],
    suggestions: [{ label: '压缩说明', instruction: '压缩中段重复解释' }],
    webFictionSignals: {
      chapterFunction: '兑现', conflictType: '身份对抗', emotionTone: '紧张',
      payoffType: '揭示', dominantMode: '行动', rhythmFingerprint,
    },
    planComparison: {
      overall: 'aligned', summary: '写前节奏意图按计划落地。',
      items: [{
        target: 'rhythmIntent', outcome: 'fulfilled', evidence: '假放行后身份核验反噬。',
      }], carryovers: [],
    },
  };
  assert.ok(extractChapterReview(JSON.stringify(base), { chapterPlan }));
  assert.equal(extractChapterReview(JSON.stringify({
    ...base,
    planComparison: {
      ...base.planComparison,
      items: [{ ...base.planComparison.items[0], outcome: 'adapted' }],
    },
  }), { chapterPlan }), null);
  assert.ok(extractChapterReview(JSON.stringify({
    ...base,
    webFictionSignals: {
      ...base.webFictionSignals,
      rhythmFingerprint: { ...rhythmFingerprint, resolutionMethod: 'cooperation' },
    },
    planComparison: {
      overall: 'adapted', summary: '人物临场协作形成合理改写。',
      items: [{
        target: 'rhythmIntent', outcome: 'adapted', evidence: '主角与旧友临时协作破局。',
      }], carryovers: [],
    },
  }), { chapterPlan }));
});

test('extractChapterReview 拒绝缺项、重复 id 或非法状态的检查表', () => {
  const base = {
    score: 78, verdict: '可改',
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  };
  assert.equal(extractChapterReview(JSON.stringify({
    ...base, webFictionChecks: reviewCheckPayload().slice(0, 9),
  })), null);
  const duplicate = reviewCheckPayload();
  duplicate[9] = { ...duplicate[9], id: 'endingHook' };
  assert.equal(extractChapterReview(JSON.stringify({
    ...base, webFictionChecks: duplicate,
  })), null);
  assert.equal(extractChapterReview(JSON.stringify({
    ...base,
    webFictionChecks: reviewCheckPayload({ payoff: { status: 'maybe' } }),
  })), null);
});

test('extractChapterReview 截断检查依据且兼容没有检查表的旧审稿', () => {
  const withChecks = extractChapterReview(JSON.stringify({
    score: 78, verdict: '可改',
    webFictionChecks: reviewCheckPayload({
      payoff: { detail: '长'.repeat(MAX_REVIEW_CHECK_DETAIL_CHARS + 50) },
    }),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(
    withChecks.webFictionChecks.find((item) => item.id === 'payoff').detail.length,
    MAX_REVIEW_CHECK_DETAIL_CHARS,
  );

  const legacy = extractChapterReview(JSON.stringify({
    score: 78, verdict: '旧格式仍可读',
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(Object.hasOwn(legacy, 'webFictionChecks'), false);

  const prePromptChecks = extractChapterReview(JSON.stringify({
    score: 78, verdict: '旧十五项检查仍可读',
    webFictionChecks: reviewCheckPayload().filter(
      (item) => ![
        'tensionDynamics', 'foreshadowingExecution', 'worldExpansion', 'proseHumanity',
      ].includes(item.id),
    ),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(prePromptChecks.webFictionChecks.length, 15);

  const oldQualityIds = [
    'tensionDynamics', 'foreshadowingExecution', 'worldExpansion', 'proseHumanity',
  ];
  const preSceneChecks = extractChapterReview(JSON.stringify({
    score: 78, verdict: '旧十四项检查仍可读',
    webFictionChecks: reviewCheckPayload().filter(
      (item) => ![...oldQualityIds, 'sceneExecution'].includes(item.id),
    ),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(preSceneChecks.webFictionChecks.length, 14);

  const previousChecks = extractChapterReview(JSON.stringify({
    score: 78, verdict: '旧十三项检查仍可读',
    webFictionChecks: reviewCheckPayload().filter(
      (item) => ![...oldQualityIds, 'sceneExecution', 'contentRisk'].includes(item.id),
    ),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(previousChecks.webFictionChecks.length, 13);

  const prePackagingChecks = extractChapterReview(JSON.stringify({
    score: 78, verdict: '旧十二项检查仍可读',
    webFictionChecks: reviewCheckPayload().filter(
      (item) => ![
        ...oldQualityIds, 'sceneExecution', 'contentRisk', 'packagingPromise',
      ].includes(item.id),
    ),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(prePackagingChecks.webFictionChecks.length, 12);

  const preStyleChecks = extractChapterReview(JSON.stringify({
    score: 78, verdict: '旧十一项检查仍可读',
    webFictionChecks: reviewCheckPayload().filter(
      (item) => ![
        ...oldQualityIds, 'sceneExecution', 'contentRisk', 'packagingPromise',
        'styleConsistency',
      ].includes(item.id),
    ),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(preStyleChecks.webFictionChecks.length, 11);

  const legacyChecks = extractChapterReview(JSON.stringify({
    score: 78, verdict: '旧十项检查仍可读',
    webFictionChecks: reviewCheckPayload().filter(
      (item) => ![
        ...oldQualityIds, 'sceneExecution', 'contentRisk', 'packagingPromise',
        'longArcProgress', 'styleConsistency',
      ].includes(item.id),
    ),
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: '具体修改' }],
  }));
  assert.equal(legacyChecks.webFictionChecks.length, 10);
});

test('extractChapterReview 从夹带文字中截取 JSON', () => {
  const r = extractChapterReview('好的，审稿如下：{"score":85,"verdict":"节奏紧凑","issues":[{"title":"对话略多","detail":"中段对话偏多"}],"suggestions":[{"label":"精简对话","instruction":"压缩中段对话"}]}。完毕');
  assert.equal(r.score, 85);
  assert.equal(r.verdict, '节奏紧凑');
});

test('extractChapterReview 忽略字符串内大括号和转义引号', () => {
  const valid = JSON.stringify({
    score: 85,
    verdict: '人物说“用 {钥匙} 打开 \\"门\\"”',
    issues: [{ title: '伏笔弱', detail: '钥匙 {来历} 没交代' }],
    suggestions: [{ label: '补伏笔', instruction: '提前写出“钥匙”的来历' }],
  });
  const r = extractChapterReview(`说明 {not-json}；审稿：${valid}；尾注 {done}`);
  assert.equal(r.score, 85);
  assert.match(r.verdict, /\{钥匙\}/);
  assert.match(r.issues[0].detail, /\{来历\}/);
});

test('extractChapterReview 无法解析时返回 null', () => {
  const r = extractChapterReview('抱歉我不会审稿');
  assert.equal(r, null);
});

test('sanitizeChapterReview 对非对象输入安全返回 null', () => {
  assert.equal(sanitizeChapterReview(null), null);
  assert.equal(sanitizeChapterReview([]), null);
  assert.equal(sanitizeChapterReview('bad'), null);
});

test('extractChapterReview score 越界 clamp', () => {
  const r = extractChapterReview('{"score":150,"verdict":"过","issues":[{"title":"t","detail":"d"}],"suggestions":[{"label":"l","instruction":"i"}]}');
  assert.equal(r.score, 100);
  const r2 = extractChapterReview('{"score":-10,"verdict":"过","issues":[{"title":"t","detail":"d"}],"suggestions":[{"label":"l","instruction":"i"}]}');
  assert.equal(r2.score, 0);
});

test('extractChapterReview 缺少 issues 或 suggestions 视为失败', () => {
  const r = extractChapterReview('{"score":78,"verdict":"过","issues":[],"suggestions":[{"label":"l","instruction":"i"}]}');
  assert.equal(r, null);
  const r2 = extractChapterReview('{"score":78,"verdict":"过","issues":[{"title":"t","detail":"d"}],"suggestions":[]}');
  assert.equal(r2, null);
});

test('extractChapterReview 丢弃空白条目并要求有效 verdict', () => {
  const blankIssue = extractChapterReview(JSON.stringify({
    score: 78,
    verdict: '有效判断',
    issues: [{ title: '   ', detail: '   ' }],
    suggestions: [{ label: '修改', instruction: '补强冲突' }],
  }));
  assert.equal(blankIssue, null);

  const blankSuggestion = extractChapterReview(JSON.stringify({
    score: 78,
    verdict: '有效判断',
    issues: [{ title: '问题', detail: '具体说明' }],
    suggestions: [{ label: '   ', instruction: '   ' }],
  }));
  assert.equal(blankSuggestion, null);

  const blankVerdict = extractChapterReview(JSON.stringify({
    score: 78,
    verdict: '   ',
    issues: [{ title: '问题', detail: '具体说明' }],
    suggestions: [{ label: '修改', instruction: '补强冲突' }],
  }));
  assert.equal(blankVerdict, null);
});

test('extractChapterReview 超长文案被截断', () => {
  const r = extractChapterReview(`{"score":60,"verdict":"这是一段超过四十字的非常长的一句话判断用来测试截断功能","issues":[{"title":"这是一个超过十五字的问题标题","detail":"这是一段超过八十字的详细说明，需要被截断到八十字以内，否则会撑爆UI布局，这是一个非常长的测试文本AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}],"suggestions":[{"label":"这是一个超过八字的标签","instruction":"指令保留原样"}]}`);
  assert.equal(r.verdict.length <= 40, true);
  assert.equal(r.issues[0].title.length <= 15, true);
  assert.equal(r.issues[0].detail.length <= 80, true);
  assert.equal(r.suggestions[0].label.length <= 8, true);
  assert.equal(r.suggestions[0].instruction.length <= MAX_REVIEW_INSTRUCTION_CHARS, true);
});

test('extractChapterReview 限制可再次发给模型的修改指令', () => {
  const r = extractChapterReview(JSON.stringify({
    score: 70,
    verdict: '可改',
    issues: [{ title: '问题', detail: '说明' }],
    suggestions: [{ label: '修改', instruction: 'x'.repeat(MAX_REVIEW_INSTRUCTION_CHARS + 500) }],
  }));
  assert.equal(r.suggestions[0].instruction.length, MAX_REVIEW_INSTRUCTION_CHARS);
});

test('extractChapterReview 最多保留 5 条 issues 和 3 条 suggestions', () => {
  const issues = Array.from({length:10}, (_,i) => ({title: 't' + i, detail: 'd' + i}));
  const suggestions = Array.from({length:10}, (_,i) => ({label: 'l' + i, instruction: 'i' + i}));
  const r = extractChapterReview(JSON.stringify({score:70,verdict:'过',issues,suggestions}));
  assert.equal(r.issues.length, 5);
  assert.equal(r.suggestions.length, 3);
});

test('extractChapterReview score 非数字时返回 null', () => {
  const r = extractChapterReview('{"score":"bad","verdict":"过","issues":[{"title":"t","detail":"d"}],"suggestions":[{"label":"l","instruction":"i"}]}');
  // score is string, not number, so sanitize returns null
  assert.equal(r, null);
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

test('extractDigest 限制摘要、进度和新人物的数量与字段长度', () => {
  const d = extractDigest(JSON.stringify({
    summary: 's'.repeat(MAX_DIGEST_SUMMARY_CHARS + 100),
    progress: 'p'.repeat(MAX_DIGEST_PROGRESS_CHARS + 100),
    newCharacters: Array.from({ length: MAX_DIGEST_CHARACTERS + 10 }, (_, index) => ({
      name: `人物${index}`.padEnd(100, 'n'), role: 'r'.repeat(200), desc: 'd'.repeat(1000),
    })),
  }));
  assert.equal(d.summary.length, MAX_DIGEST_SUMMARY_CHARS);
  assert.equal(d.progress.length, MAX_DIGEST_PROGRESS_CHARS);
  assert.equal(d.newCharacters.length, MAX_DIGEST_CHARACTERS);
  assert.ok(d.newCharacters.every((item) => item.name.length <= 50 && item.role.length <= 100 && item.desc.length <= 500));
});

test('extractSectionsPlan 解析合法 JSON', () => {
  const r = extractSectionsPlan('{"sections":[{"title":"起源","summary":"主角出身"},{"title":"冒险","summary":"踏上旅途"}]}');
  assert.ok(r);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, '起源');
  assert.equal(r[0].summary, '主角出身');
  assert.equal(r[1].title, '冒险');
});

test('extractSectionsPlan 保留分部承诺、目标、阻力、高潮、兑现和状态变化', () => {
  const r = extractSectionsPlan(JSON.stringify({ sections: [{
    title: '暗潮', summary: '进入地下城', promise: '揭示城市暗面',
    goal: '找到证人', obstacle: '守夜人追杀', progress: '锁定幕后组织',
    climax: '钟楼对决', payoff: '救回证人', stateChange: '主角身份暴露',
  }, {
    title: '破晓', summary: '反攻总部', promise: '正面对决',
    goal: '摧毁组织', obstacle: '盟友背叛', progress: '揭开终局入口',
    climax: '总部决战', payoff: '清算首领', stateChange: '旧秩序瓦解',
  }] }));
  assert.equal(r[0].promise, '揭示城市暗面');
  assert.equal(r[0].goal, '找到证人');
  assert.equal(r[0].obstacle, '守夜人追杀');
  assert.equal(r[0].progress, '锁定幕后组织');
  assert.equal(r[0].climax, '钟楼对决');
  assert.equal(r[0].payoff, '救回证人');
  assert.equal(r[0].stateChange, '主角身份暴露');
});

test('extractSectionsPlan 对旧 summary 结果补兼容结构并限制字段长度', () => {
  const r = extractSectionsPlan(JSON.stringify({ sections: [{
    title: '起源', summary: '走向一', promise: '长'.repeat(MAX_SECTION_PLAN_FIELD_CHARS + 50),
  }, { title: '终局', summary: '走向二' }] }));
  assert.equal(r[0].promise.length, MAX_SECTION_PLAN_FIELD_CHARS);
  assert.equal(r[0].goal, '走向一');
  assert.equal(r[1].payoff, '待进一步明确');
  assert.equal(r[1].stateChange, '走向二');
});

test('extractSectionsPlan 从夹带文字中截取', () => {
  const r = extractSectionsPlan('好的，规划如下：{"sections":[{"title":"暗潮","summary":"第一部"},{"title":"风云","summary":"第二部"},{"title":"终章","summary":"第三部"}]}。完毕');
  assert.ok(r);
  assert.equal(r.length, 3);
});

test('extractSectionsPlan 最多保留安全上限数量的分部', () => {
  const sections = Array.from({ length: MAX_PLANNED_SECTIONS + 20 }, (_, index) => ({
    title: `分部${index}`, summary: '走向',
  }));
  const parsed = extractSectionsPlan(JSON.stringify({ sections }));
  assert.equal(parsed.length, MAX_PLANNED_SECTIONS);
});

test('extractDigest 对大量未闭合大括号保持有界扫描', () => {
  const d = extractDigest('{'.repeat(MAX_LLM_OUTPUT_CHARS));
  assert.deepEqual(d, {
    chapterTitle: '', sectionTitle: '', summary: '', progress: '',
    handoff: {
      viewpoint: '', time: '', location: '', ongoingAction: '', immediatePressure: '',
      characterState: '', resourceState: '', knowledgeBoundary: '', unresolvedCausality: '',
    }, newCharacters: [], memoryCandidates: [],
  });
});

test('extractDigest 清洗长期记忆候选并区分字段缺失', () => {
  const parsed = extractDigest(JSON.stringify({
    summary: '摘要', progress: '进度', characters: [],
    memoryCandidates: [
      {
        kind: 'ability', subject: '林越', predicate: '能力限制',
        object: '每天只能使用一次', evidence: '使用后明确失去力量', importance: 8,
        details: {
          eventType: 'used', limitation: '每天一次', time: '雨夜',
          strength: 'strong', participants: ['不属于能力字段'],
        },
      },
      {
        kind: 'relationship', subject: '林越', predicate: '盟友',
        object: '苏棠', evidence: '二人共同立誓', importance: 4,
      },
      { kind: 'invented', subject: '非法', predicate: '字段', object: '丢弃' },
    ],
  }));
  assert.deepEqual(parsed.memoryCandidates, [{
    kind: 'ability', subject: '林越', predicate: '能力限制',
    object: '每天只能使用一次', evidence: '使用后明确失去力量', importance: 5,
    details: { eventType: 'used', limitation: '每天一次', time: '雨夜' },
  }, {
    kind: 'relationship', subject: '林越', predicate: '盟友', object: '苏棠',
    evidence: '二人共同立誓', importance: 4,
    details: { target: '苏棠', relationType: '盟友', changeReason: '二人共同立誓' },
  }]);
  assert.equal(parsed.digestMemoryCandidatesParsed, true);
  const legacy = extractDigest('{"summary":"摘要","progress":"进度","characters":[]}');
  assert.deepEqual(legacy.memoryCandidates, []);
  assert.equal(legacy.digestMemoryCandidatesParsed, false);
});

test('extractDigest 白名单化势力、伏笔和知识边界专用字段', () => {
  const candidate = (kind, subject, details) => ({
    kind, subject, predicate: '当前记录', object: '正文已明确',
    evidence: '本章直接呈现', importance: 4, details,
  });
  const parsed = extractDigest(JSON.stringify({
    summary: '摘要', progress: '进度', characters: [],
    memoryCandidates: [
      candidate('faction', '巡夜司', {
        participants: ['林越', '苏棠'], role: '林越任队长', alignment: '守序',
        goal: '封锁裂隙', relations: '与城防军合作', territory: '北港',
      }),
      candidate('foreshadowing', '断剑来历', {
        foreshadowStatus: 'planted', readerKnowledge: '剑柄有王室纹章',
        plannedPayoff: '揭示师父身份', dueChapter: '80', owner: '越权字段应丢弃',
      }),
      candidate('knowledge', '密道存在', {
        knowledgeOwner: 'character', knower: '苏棠', information: '密道通向王宫',
        learnedAt: '第十二章', visibility: 'secret',
      }),
    ],
  }));
  assert.deepEqual(parsed.memoryCandidates.map((item) => item.details), [{
    participants: ['林越', '苏棠'], role: '林越任队长', alignment: '守序',
    goal: '封锁裂隙', relations: '与城防军合作', territory: '北港',
  }, {
    foreshadowStatus: 'planted', readerKnowledge: '剑柄有王室纹章',
    plannedPayoff: '揭示师父身份', dueChapter: '80',
  }, {
    knowledgeOwner: 'character', knower: '苏棠', information: '密道通向王宫',
    learnedAt: '第十二章',
  }]);
});

test('extractSectionsPlan 在未闭合前缀之后仍能恢复合法 JSON', () => {
  const valid = JSON.stringify({
    sections: [
      { title: '暗潮', summary: '第一部' },
      { title: '风云', summary: '第二部' },
    ],
  });
  const r = extractSectionsPlan(`前缀 {未闭合，实际规划：${valid}，尾注 {备注}`);
  assert.ok(r);
  assert.deepEqual(r.map((section) => section.title), ['暗潮', '风云']);
});

test('extractSectionsPlan 少于 2 个部返回 null', () => {
  assert.equal(extractSectionsPlan('{"sections":[{"title":"仅一部","summary":"x"}]}'), null);
  assert.equal(extractSectionsPlan('{"sections":[]}'), null);
});

test('extractSectionsPlan 无法解析时返回 null', () => {
  assert.equal(extractSectionsPlan('抱歉我不会'), null);
  assert.equal(extractSectionsPlan('{"bad":"data"}'), null);
});

test('extractSectionsPlan 清洗 title 格式', () => {
  const r = extractSectionsPlan('{"sections":[{"title":"《第一章·起源》","summary":"a"},{"title":"第二部：暗潮初现","summary":"b"}]}');
  assert.ok(r);
  assert.equal(r[0].title, '起源');
  assert.equal(r[1].title, '暗潮初现');
});

test('extractWritingAssetAnalysis 从夹带说明中提取并白名单化资产', () => {
  const parsed = extractWritingAssetAnalysis(`结果如下：${JSON.stringify({
    style: {
      summary: '紧凑', prompt: '使用具体动作推进', avoid: ['空泛总结'], ignored: 'x',
    },
    story: {
      summary: '目标受阻后作出选择', evidenceLevel: 'medium',
      reusableTechniques: ['选择同时带来代价'], uncertainties: ['缺少长线样本'],
    },
    ignored: 'x',
  })}。`);
  assert.equal(parsed.style.summary, '紧凑');
  assert.equal(parsed.style.prompt, '使用具体动作推进');
  assert.equal(parsed.story.evidenceLevel, 'medium');
  assert.equal(Object.hasOwn(parsed, 'ignored'), false);
  assert.equal(Object.hasOwn(parsed.style, 'ignored'), false);
});

test('sanitizeWritingAssetAnalysis 拒绝缺少核心字段并限制未知证据等级', () => {
  assert.equal(sanitizeWritingAssetAnalysis(null), null);
  assert.equal(sanitizeWritingAssetAnalysis({ style: {}, story: {} }), null);
  const parsed = sanitizeWritingAssetAnalysis({
    style: { summary: '风格', prompt: '执行指令' },
    story: { summary: '结构', evidenceLevel: 'certain' },
  });
  assert.equal(parsed.story.evidenceLevel, 'low');
});
