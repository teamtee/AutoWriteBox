import type {
  PromiseLedger, PromiseLedgerEntryInput, PromiseLedgerMutationResult,
} from './types';

type Transport = {
  json: (response: Response) => Promise<unknown>;
  jpost: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
  getWithOptionalSignal: (path: string, signal?: AbortSignal) => Promise<Response>;
};

const clientId = (prefix: string): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
export const createClientPromiseId = () => clientId('promise');
export const createClientPromiseProgressId = () => clientId('progress');

export function createPromiseLedgerApi({ json, jpost, getWithOptionalSignal }: Transport) {
  const root = (bookId: string) =>
    `/api/books/${encodeURIComponent(bookId)}/promise-ledger`;
  return {
    getPromiseLedger: (bookId: string, signal?: AbortSignal): Promise<PromiseLedger> =>
      getWithOptionalSignal(root(bookId), signal).then(json) as Promise<PromiseLedger>,
    savePromiseLedgerEntry: (
      bookId: string, entry: PromiseLedgerEntryInput, expectedRevision: string,
      signal?: AbortSignal,
    ): Promise<PromiseLedgerMutationResult> => jpost(
      `${root(bookId)}/entries`, { entry, expectedRevision }, signal,
    ) as Promise<PromiseLedgerMutationResult>,
    deletePromiseLedgerEntry: (
      bookId: string, entryId: string, expectedRevision: string,
    ): Promise<{ deletedId: string; revision: string }> => fetch(
      `${root(bookId)}/entries/${encodeURIComponent(entryId)}`,
      {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision }),
      },
    ).then(json) as Promise<{ deletedId: string; revision: string }>,
  };
}
