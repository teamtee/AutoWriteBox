import { describe, expect, it, vi } from 'vitest';
import { runExclusiveAction } from './asyncAction';

describe('runExclusiveAction', () => {
  it('ignores a second invocation while the first task is still running', async () => {
    let running = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => {
      await gate;
      return 'created';
    });
    const setRunning = vi.fn((next: boolean) => { running = next; });

    const first = runExclusiveAction({
      isRunning: () => running,
      setRunning,
      task,
    });
    const second = await runExclusiveAction({
      isRunning: () => running,
      setRunning,
      task,
    });

    expect(second).toBeNull();
    expect(task).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe('created');
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(running).toBe(false);
  });

  it('releases the lock when the task fails', async () => {
    let running = false;
    const error = new Error('CREATE_FAILED');
    const setRunning = vi.fn((next: boolean) => { running = next; });

    await expect(runExclusiveAction({
      isRunning: () => running,
      setRunning,
      task: async () => { throw error; },
    })).rejects.toThrow('CREATE_FAILED');

    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(running).toBe(false);
  });
});
