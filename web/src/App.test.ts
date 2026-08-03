import { describe, expect, it, vi } from 'vitest';
import type { BookSummary } from './types';
import { loadShelfBooks, runShelfMutation, shouldShowFirstRun } from './App';

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
