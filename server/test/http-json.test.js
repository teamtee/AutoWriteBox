import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendJsonStream } from '../http-json.js';

function fakeStreamingResponse({ blockFirstWrite = false } = {}) {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
    headers: {},
    chunks: [],
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) {
      this.chunks.push(chunk);
      if (blockFirstWrite && this.chunks.length === 1) {
        this.writableNeedDrain = true;
        queueMicrotask(() => {
          this.writableNeedDrain = false;
          this.emit('drain');
        });
        return false;
      }
      return true;
    },
    end() { this.writableEnded = true; },
  });
  return response;
}

test('大型 JSON 响应按片段写入并等待背压后结束', async () => {
  const response = fakeStreamingResponse({ blockFirstWrite: true });
  const value = { title: '流式响应', history: ['正文'.repeat(100_000)], ok: true };

  await sendJsonStream(response, value);

  assert.equal(response.chunks.join(''), JSON.stringify(value));
  assert.equal(response.writableEnded, true);
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(response.chunks.length > 3);
});

test('等待背压时客户端取消会停止响应且不调用 end', async () => {
  const controller = new AbortController();
  const response = fakeStreamingResponse();
  response.write = function write(chunk) {
    this.chunks.push(chunk);
    this.writableNeedDrain = true;
    return false;
  };
  const sending = sendJsonStream(response, { text: '不会写完' }, {
    signal: controller.signal,
  });
  controller.abort(new Error('CLIENT_ABORTED'));

  await assert.rejects(() => sending, /CLIENT_ABORTED/);
  assert.equal(response.writableEnded, false);
});

test('客户端保持连接但不读取时背压等待会超时并销毁响应', async () => {
  const response = fakeStreamingResponse();
  response.write = function write(chunk) {
    this.chunks.push(chunk);
    this.writableNeedDrain = true;
    return false;
  };
  response.destroy = function destroy() { this.destroyed = true; };

  await assert.rejects(
    () => sendJsonStream(response, { text: '不会无限等待' }, { drainTimeoutMs: 5 }),
    /RESPONSE_BACKPRESSURE_TIMEOUT/,
  );
  assert.equal(response.destroyed, true);
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(response.listenerCount('error'), 0);
  assert.equal(response.writableEnded, false);
});

test('没有流接口的响应替身回退到 json()', async () => {
  const response = {
    json(value) { this.value = value; return this; },
  };
  const value = { ok: true };
  assert.equal(await sendJsonStream(response, value), response);
  assert.deepEqual(response.value, value);
});
