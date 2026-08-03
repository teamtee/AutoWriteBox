import { describe, expect, it, vi } from 'vitest';
import { finishOwnedAction, runExclusiveAction, startExclusiveAction } from './asyncAction';

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

describe('startExclusiveAction', () => {
  it('ignores a second fire-and-forget start until the caller releases the lock', () => {
    let running = false;
    const setRunning = vi.fn((next: boolean) => { running = next; });
    const start = vi.fn();

    const first = startExclusiveAction({
      isRunning: () => running,
      setRunning,
      start,
    });
    const second = startExclusiveAction({
      isRunning: () => running,
      setRunning,
      start,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(start).toHaveBeenCalledOnce();
    expect(running).toBe(true);

    setRunning(false);
    const third = startExclusiveAction({
      isRunning: () => running,
      setRunning,
      start,
    });

    expect(third).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('releases the lock when starting the fire-and-forget task throws synchronously', () => {
    let running = false;
    const setRunning = vi.fn((next: boolean) => { running = next; });

    expect(() => startExclusiveAction({
      isRunning: () => running,
      setRunning,
      start: () => { throw new Error('START_FAILED'); },
    })).toThrow('START_FAILED');

    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(running).toBe(false);
  });
});

describe('finishOwnedAction', () => {
  it('ignores a stale finish callback from a previous fire-and-forget action', () => {
    let running = true;
    const finish = vi.fn(() => { running = false; });

    const finished = finishOwnedAction({
      token: 1,
      currentToken: () => 2,
      finish,
    });

    expect(finished).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(running).toBe(true);
  });

  it('runs finish only for the current fire-and-forget action', () => {
    let running = true;

    const finished = finishOwnedAction({
      token: 2,
      currentToken: () => 2,
      finish: () => { running = false; },
    });

    expect(finished).toBe(true);
    expect(running).toBe(false);
  });
});
