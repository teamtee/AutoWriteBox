import { stringifyJsonChunks } from './json-stream.js';

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

function clientAbortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED');
}

function assertWritable(response, signal) {
  if (signal?.aborted || response.destroyed || response.writableEnded) {
    throw clientAbortError(signal);
  }
}

function waitForDrain(response, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(clientAbortError(signal));
    const onError = (error) => finish(error);
    const onAbort = () => finish(clientAbortError(signal));
    const onTimeout = () => {
      const error = new Error('RESPONSE_BACKPRESSURE_TIMEOUT');
      finish(error);
      response.destroy?.();
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted || response.destroyed || response.writableEnded) onAbort();
    else if (!response.writableNeedDrain) finish();
    else {
      // 背压超时负责结算当前调用返回的 Promise，不能 unref；否则在没有
      // 其它活跃句柄时，Node 20 会直接结束事件循环并留下永久待决操作。
      timer = setTimeout(onTimeout, timeoutMs);
    }
  });
}

// Express 的 res.json 会先生成完整响应字符串。作品树和章节历史可合法达到
// 数十 MiB；这里逐片序列化并遵守 socket 背压，客户端断开时立即停止。
export async function sendJsonStream(response, value, {
  signal,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
} = {}) {
  // 轻量路由单测可继续使用只实现 json() 的响应替身。
  if (typeof response.write !== 'function') return response.json(value);
  assertWritable(response, signal);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const boundedDrainTimeoutMs = Number.isSafeInteger(drainTimeoutMs) && drainTimeoutMs > 0
    ? drainTimeoutMs
    : DEFAULT_DRAIN_TIMEOUT_MS;
  for (const chunk of stringifyJsonChunks(value)) {
    assertWritable(response, signal);
    if (!response.write(chunk, 'utf8')) {
      await waitForDrain(response, signal, boundedDrainTimeoutMs);
    }
  }
  assertWritable(response, signal);
  response.end();
  return response;
}
