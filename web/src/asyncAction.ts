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
