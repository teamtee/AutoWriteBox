import { MAX_PROMISE_LEDGER_ENTRIES } from '../limits.js';
import {
  normalizePromiseEntryInput, normalizePromiseLedger,
  promiseLedgerRevision, promiseLedgerView, requirePromiseLedgerId,
} from '../promise-ledger-schema.js';

const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function entryContent(entry) {
  return normalizePromiseEntryInput(entry);
}

function confirmedEvidenceEvents(entry) {
  return entry.progress.filter((event) => event.source).map((event) => JSON.stringify(event));
}

export function createPromiseLedgerStore({
  bookJsonLockKey, readBook, safeId, throwIfAborted, withStoreLock, writeBookUnlocked,
}) {
  async function readPromiseLedger(bookId, { signal } = {}) {
    const book = await readBook(safeId(bookId), { signal });
    return promiseLedgerView(book.settings.promiseLedger);
  }

  async function savePromiseLedgerEntry(bookId, value, {
    expectedRevision, signal,
  } = {}) {
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_PROMISE_LEDGER_REVISION');
    }
    const input = normalizePromiseEntryInput(value);
    const safeBookId = safeId(bookId);
    return withStoreLock(bookJsonLockKey(safeBookId), async () => {
      const book = await readBook(safeBookId, { signal });
      const ledger = normalizePromiseLedger(book.settings.promiseLedger);
      if (promiseLedgerRevision(ledger) !== expectedRevision) {
        throw new Error('PROMISE_LEDGER_CONFLICT');
      }
      const index = ledger.entries.findIndex((entry) => entry.id === input.id);
      if (index < 0 && ledger.entries.length >= MAX_PROMISE_LEDGER_ENTRIES) {
        throw new Error('PROMISE_LEDGER_LIMIT');
      }
      // 带正文来源的节拍只能由“审稿候选→作者确认”流水线产生；普通账本
      // 表单既不能伪造，也不能编辑或删除这些证据记录。
      const storedEvidence = index >= 0
        ? confirmedEvidenceEvents(ledger.entries[index]) : [];
      const inputEvidence = confirmedEvidenceEvents(input);
      if ((index < 0 && inputEvidence.length)
        || (index >= 0
          && JSON.stringify(inputEvidence) !== JSON.stringify(storedEvidence))) {
        throw new Error('PROMISE_EVIDENCE_IMMUTABLE');
      }
      if (index >= 0 && JSON.stringify(entryContent(ledger.entries[index]))
        === JSON.stringify(input)) {
        return { entry: ledger.entries[index], revision: expectedRevision };
      }
      const now = new Date().toISOString();
      const entry = {
        ...input,
        createdAt: index >= 0 ? ledger.entries[index].createdAt : now,
        updatedAt: now,
      };
      if (index >= 0) ledger.entries[index] = entry;
      else ledger.entries.push(entry);
      throwIfAborted(signal);
      book.settings.promiseLedger = ledger;
      await writeBookUnlocked(safeBookId, book);
      return { entry, revision: promiseLedgerRevision(ledger) };
    }, { signal });
  }

  async function deletePromiseLedgerEntry(bookId, entryId, {
    expectedRevision, signal,
  } = {}) {
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_PROMISE_LEDGER_REVISION');
    }
    const safeEntryId = requirePromiseLedgerId(entryId);
    const safeBookId = safeId(bookId);
    return withStoreLock(bookJsonLockKey(safeBookId), async () => {
      const book = await readBook(safeBookId, { signal });
      const ledger = normalizePromiseLedger(book.settings.promiseLedger);
      if (promiseLedgerRevision(ledger) !== expectedRevision) {
        throw new Error('PROMISE_LEDGER_CONFLICT');
      }
      const index = ledger.entries.findIndex((entry) => entry.id === safeEntryId);
      if (index < 0) throw new Error('PROMISE_ENTRY_NOT_FOUND');
      if (confirmedEvidenceEvents(ledger.entries[index]).length) {
        throw new Error('PROMISE_EVIDENCE_IMMUTABLE');
      }
      ledger.entries.splice(index, 1);
      throwIfAborted(signal);
      book.settings.promiseLedger = ledger;
      await writeBookUnlocked(safeBookId, book);
      return { deletedId: safeEntryId, revision: promiseLedgerRevision(ledger) };
    }, { signal });
  }

  return { deletePromiseLedgerEntry, readPromiseLedger, savePromiseLedgerEntry };
}
