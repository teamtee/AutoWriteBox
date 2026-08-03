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
