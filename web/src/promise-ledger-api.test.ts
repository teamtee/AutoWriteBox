import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClientPromiseId, createClientPromiseProgressId,
  deletePromiseLedgerEntry, getPromiseLedger, readableApiError,
  savePromiseLedgerEntry,
} from './api';
import type { PromiseLedgerEntryInput } from './types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const entry: PromiseLedgerEntryInput = {
  id: `promise_${'a'.repeat(32)}`,
  kind: 'mystery',
  status: 'open',
  importance: 5,
  promise: '查明旧案真凶',
  introducedChapter: 2,
  expectedStartChapter: 8,
  expectedEndChapter: 10,
  progress: [],
  resolution: '',
  resolvedChapter: null,
  nextPromise: '',
  notes: '',
};

describe('promise ledger API', () => {
  it('uses a separately loaded book-level contract with an optimistic revision', async () => {
    globalThis.fetch = vi.fn(async (path) => new Response(JSON.stringify(
      String(path).endsWith('/promise-ledger')
        ? { entries: [], revision: 'R'.repeat(43) }
        : { entry, revision: 'N'.repeat(43), deletedId: entry.id },
    ), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    const controller = new AbortController();
    await getPromiseLedger('book one', controller.signal);
    await savePromiseLedgerEntry('book one', entry, 'R'.repeat(43), controller.signal);
    await deletePromiseLedgerEntry('book one', entry.id, 'N'.repeat(43));

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1, '/api/books/book%20one/promise-ledger', { signal: controller.signal },
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2, '/api/books/book%20one/promise-ledger/entries', expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ entry, expectedRevision: 'R'.repeat(43) }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3, `/api/books/book%20one/promise-ledger/entries/${entry.id}`,
      expect.objectContaining({
        method: 'DELETE', body: JSON.stringify({ expectedRevision: 'N'.repeat(43) }),
      }),
    );
  });

  it('creates schema-compatible client IDs and explains conflicts without silent overwrite', () => {
    expect(createClientPromiseId()).toMatch(/^promise_[0-9a-f]{32}$/);
    expect(createClientPromiseProgressId()).toMatch(/^progress_[0-9a-f]{32}$/);
    expect(readableApiError('PROMISE_LEDGER_CONFLICT')).toContain('未覆盖新版');
    expect(readableApiError('PROMISE_LEDGER_LIMIT')).toContain('1000');
  });
});
