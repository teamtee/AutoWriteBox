import { describe, expect, it, vi } from 'vitest';
import type { BookSummary } from './types';
import {
  adoptSectionTitles,
  loadShelfBooks,
  runExclusiveStructureMutation,
  runExclusiveSectionAdoption,
  runShelfMutation,
  shouldDisableSidebar,
  shouldShowFirstRun,
} from './App';

const book = (id: string): BookSummary => ({
  id,
  title: `Book ${id}`,
  updatedAt: '2026-08-03T00:00:00.000Z',
  sectionCount: 0,
  chapterCount: 0,
});

describe('shelf loading', () => {
  it('records the load error without replacing the shelf with an empty list', async () => {
    const setBooks = vi.fn();
    let shelfError: string | null = null;

    const result = await loadShelfBooks(
      async () => { throw new Error('SERVER_DOWN'); },
      setBooks,
      (next) => { shelfError = next; },
    );

    expect(result).toBeNull();
    expect(setBooks).not.toHaveBeenCalled();
    expect(shelfError).toBe('SERVER_DOWN');
  });

  it('clears the previous load error after a successful shelf load', async () => {
    const setBooks = vi.fn();
    let shelfError: string | null = 'SERVER_DOWN';
    const books = [book('b1')];

    const result = await loadShelfBooks(
      async () => books,
      setBooks,
      (next) => { shelfError = next; },
    );

    expect(result).toEqual(books);
    expect(setBooks).toHaveBeenCalledWith(books);
    expect(shelfError).toBeNull();
  });

  it('does not show first-run creation when the empty shelf came from a load error', () => {
    expect(shouldShowFirstRun({
      creating: false,
      books: [],
      shelfError: 'SERVER_DOWN',
    })).toBe(false);
  });

  it('still shows first-run creation for a successfully loaded empty shelf', () => {
    expect(shouldShowFirstRun({
      creating: false,
      books: [],
      shelfError: null,
    })).toBe(true);
  });

  it('does not show mutation success when the follow-up shelf refresh failed', async () => {
    const action = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => null);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    const ok = await runShelfMutation({ action, refresh, onSuccess, onFailure });

    expect(ok).toBe(false);
    expect(action).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('shows mutation success only after the shelf refresh succeeded', async () => {
    const books = [book('b1')];
    const action = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => books);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    const ok = await runShelfMutation({ action, refresh, onSuccess, onFailure });

    expect(ok).toBe(true);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports mutation failure without trying to refresh the shelf', async () => {
    const error = new Error('BAD_TITLE');
    const action = vi.fn(async () => { throw error; });
    const refresh = vi.fn(async () => [book('b1')]);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    const ok = await runShelfMutation({ action, refresh, onSuccess, onFailure });

    expect(ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(error);
  });
});

describe('section adoption', () => {
  it('reloads and finishes the flow when section adoption partially succeeded', async () => {
    const error = new Error('NETWORK_DOWN');
    const addSection = vi.fn(async (title: string) => {
      if (title === '终局') throw error;
    });
    const reload = vi.fn(async () => undefined);
    const onSuccess = vi.fn();
    const onPartialFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮', '终局'],
      addSection,
      reload,
      onSuccess,
      onPartialFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 2, total: 3, ok: false });
    expect(addSection).toHaveBeenNthCalledWith(1, '起源');
    expect(addSection).toHaveBeenNthCalledWith(2, '暗潮');
    expect(addSection).toHaveBeenNthCalledWith(3, '终局');
    expect(reload).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onPartialFailure).toHaveBeenCalledWith(2, 3, error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('keeps the adoption flow open when no section was created', async () => {
    const error = new Error('BOOK_NOT_FOUND');
    const addSection = vi.fn(async () => { throw error; });
    const reload = vi.fn(async () => undefined);
    const onSuccess = vi.fn();
    const onPartialFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮'],
      addSection,
      reload,
      onSuccess,
      onPartialFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 0, total: 2, ok: false });
    expect(reload).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onPartialFailure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(error);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('finishes the flow when sections were created but the refresh failed', async () => {
    const error = new Error('TREE_RELOAD_FAILED');
    const addSection = vi.fn(async () => undefined);
    const reload = vi.fn(async () => { throw error; });
    const onSuccess = vi.fn();
    const onPartialFailure = vi.fn();
    const onRefreshFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮'],
      addSection,
      reload,
      onSuccess,
      onPartialFailure,
      onRefreshFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 2, total: 2, ok: false });
    expect(reload).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onPartialFailure).not.toHaveBeenCalled();
    expect(onRefreshFailure).toHaveBeenCalledWith(2, 2, error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('ignores concurrent adoption while another adoption is running', async () => {
    let locked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => {
      await gate;
      return 'created';
    });
    const setRunning = vi.fn((next: boolean) => { locked = next; });

    const first = runExclusiveSectionAdoption({
      isRunning: () => locked,
      setRunning,
      task,
    });
    const second = await runExclusiveSectionAdoption({
      isRunning: () => locked,
      setRunning,
      task,
    });

    expect(second).toBeNull();
    expect(task).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe('created');
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(locked).toBe(false);
  });
});

describe('book structure mutations', () => {
  it('disables the sidebar while streaming or mutating the book structure', () => {
    expect(shouldDisableSidebar({ streaming: true, structureMutating: false })).toBe(true);
    expect(shouldDisableSidebar({ streaming: false, structureMutating: true })).toBe(true);
    expect(shouldDisableSidebar({ streaming: false, structureMutating: false })).toBe(false);
  });

  it('ignores concurrent structure mutations while one is running', async () => {
    let locked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => {
      await gate;
      return 'section-created';
    });
    const setRunning = vi.fn((next: boolean) => { locked = next; });

    const first = runExclusiveStructureMutation({
      isRunning: () => locked,
      setRunning,
      task,
    });
    const second = await runExclusiveStructureMutation({
      isRunning: () => locked,
      setRunning,
      task,
    });

    expect(second).toBeNull();
    expect(task).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe('section-created');
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(locked).toBe(false);
  });
});
