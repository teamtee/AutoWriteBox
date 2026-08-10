export async function runExclusiveAction<T>({
  isRunning,
  setRunning,
  task,
}: {
  isRunning: () => boolean;
  setRunning: (running: boolean) => void;
  task: () => Promise<T>;
}) {
  if (isRunning()) return null;
  setRunning(true);
  try {
    return await task();
  } finally {
    setRunning(false);
  }
}

export function startExclusiveAction({
  isRunning,
  setRunning,
  start,
}: {
  isRunning: () => boolean;
  setRunning: (running: boolean) => void;
  start: () => void;
}) {
  if (isRunning()) return false;
  setRunning(true);
  try {
    start();
    return true;
  } catch (e) {
    setRunning(false);
    throw e;
  }
}

export function finishOwnedAction({
  token,
  currentToken,
  finish,
}: {
  token: number;
  currentToken: () => number;
  finish: () => void;
}) {
  if (token !== currentToken()) return false;
  finish();
  return true;
}

export function createLatestRequestGate() {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    owns(token: number) {
      return token === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}

export function createLatestAbortGate() {
  const gate = createLatestRequestGate();
  let controller: AbortController | null = null;
  return {
    begin() {
      // 先转移所有权再触发 abort，确保旧请求的拒绝回调即使立即执行也只会被视为过期。
      const token = gate.begin();
      controller?.abort();
      controller = new AbortController();
      return { token, signal: controller.signal };
    },
    owns(token: number) {
      return gate.owns(token);
    },
    invalidate() {
      gate.invalidate();
      controller?.abort();
      controller = null;
    },
  };
}
