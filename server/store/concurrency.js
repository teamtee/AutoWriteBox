const storeLocks = new Map();
const MAX_CONCURRENT_JSON_READS = 2;
const jsonReadWaiters = [];
let activeJsonReads = 0;

function clientAbortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw clientAbortError(signal);
}

// 测试和显式切换数据根时清理作品锁命名空间。调用方必须保证此时没有
// 在途存储操作；这与原 store.js 的 setDataRoot 行为保持一致。
export function resetStoreLocks() {
  storeLocks.clear();
}

export async function withStoreLock(key, fn, { signal } = {}) {
  throwIfAborted(signal);
  let state = storeLocks.get(key);
  if (state) {
    await new Promise((resolveWait, rejectWait) => {
      const waiter = {
        resolve() {
          signal?.removeEventListener?.('abort', onAbort);
          resolveWait();
        },
      };
      const onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        state.waiters.splice(index, 1);
        signal?.removeEventListener?.('abort', onAbort);
        rejectWait(clientAbortError(signal));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      state.waiters.push(waiter);
      // abort 可能发生在入口检查和监听器注册之间。
      if (signal?.aborted) onAbort();
    });
  } else {
    state = { waiters: [] };
    storeLocks.set(key, state);
  }
  try {
    // 若取消与锁交接同时发生，仍需进入 finally 把刚取得的锁传给下一位。
    throwIfAborted(signal);
    return await fn();
  } finally {
    const next = state.waiters.shift();
    if (next) next.resolve();
    else if (storeLocks.get(key) === state) storeLocks.delete(key);
  }
}

export async function mapWithConcurrency(items, limit, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  let hasError = false;
  let firstError;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      // 一个并发分支失败后不再领取新任务，但必须等已在执行的
      // 分支收尾后才向外抛错。否则外层作品锁会在背景读取结束前释放。
      if (hasError) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (hasError) throw firstError;
  return results;
}

export async function withJsonReadSlot(task, { signal } = {}) {
  throwIfAborted(signal);
  if (activeJsonReads >= MAX_CONCURRENT_JSON_READS) {
    await new Promise((resolveWait, rejectWait) => {
      const waiter = {
        resolve() {
          signal?.removeEventListener('abort', onAbort);
          resolveWait();
        },
      };
      const onAbort = () => {
        const index = jsonReadWaiters.indexOf(waiter);
        if (index < 0) return;
        jsonReadWaiters.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        rejectWait(clientAbortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      jsonReadWaiters.push(waiter);
      // abort 可能发生在入口检查和监听器注册之间。
      if (signal?.aborted) onAbort();
    });
  } else {
    activeJsonReads += 1;
  }
  try {
    throwIfAborted(signal);
    return await task();
  } finally {
    const next = jsonReadWaiters.shift();
    if (next) next.resolve();
    else activeJsonReads -= 1;
  }
}
