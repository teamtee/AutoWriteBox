import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PromiseLedgerEntry } from '../types';
import {
  emptyPromiseEntryInput, PromiseLedgerList, promiseEntryInput,
  promiseEntryInputEquals, promiseEntryIsOverdue,
} from './PromiseLedgerCard';

const ledgerEntry: PromiseLedgerEntry = {
  id: `promise_${'a'.repeat(32)}`,
  kind: 'mystery',
  status: 'open',
  importance: 5,
  promise: '主角必须查清师父为何隐瞒灭门真相',
  introducedChapter: 2,
  expectedStartChapter: 8,
  expectedEndChapter: 10,
  progress: [{
    id: `progress_${'b'.repeat(32)}`,
    chapter: 9,
    note: '取得师父留下的密信',
  }],
  resolution: '',
  resolvedChapter: null,
  nextPromise: '',
  notes: '不能用失忆解释',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

describe('PromiseLedgerCard helpers and list', () => {
  it('distinguishes an overdue reader debt and renders its progress evidence', () => {
    expect(promiseEntryIsOverdue(ledgerEntry, 10)).toBe(true);
    expect(promiseEntryIsOverdue({ ...ledgerEntry, status: 'planned' }, 20)).toBe(false);
    const html = renderToStaticMarkup(<PromiseLedgerList
      entries={[ledgerEntry]}
      completedChapterCount={12}
      disabled={false}
      deletingId={null}
      confirmDeleteId={null}
      onEdit={vi.fn()}
      onDelete={vi.fn()} />);
    expect(html).toContain('已建立·待兑现');
    expect(html).toContain('逾期');
    expect(html).toContain('已逾期 3 章');
    expect(html).toContain('取得师父留下的密信');
    expect(html).toContain('不能用失忆解释');
  });

  it('builds a planned draft and compares only editable fields, not timestamps', () => {
    const draft = emptyPromiseEntryInput(`promise_${'c'.repeat(32)}`, 7);
    expect(draft.status).toBe('planned');
    expect(draft.expectedStartChapter).toBe(7);
    expect(promiseEntryInputEquals(promiseEntryInput(ledgerEntry), {
      ...promiseEntryInput(ledgerEntry),
    })).toBe(true);
    expect(promiseEntryInputEquals(promiseEntryInput(ledgerEntry), {
      ...promiseEntryInput(ledgerEntry), promise: '另一个承诺',
    })).toBe(false);
  });

  it('renders API evidence beats as auditable history that cannot be deleted', () => {
    const evidenced: PromiseLedgerEntry = {
      ...ledgerEntry,
      progress: [{
        ...ledgerEntry.progress[0], beat: 'reinterpret',
        readerBefore: '读者以为密信来自城内', readerAfter: '读者怀疑密信经过旧城',
        actionConsequence: '主角改去旧城', worldLink: 'none',
        worldEffect: '不关联本章世界层级推进', evidence: '密信封口有旧城泥沙',
        source: { sectionId: 'section', chapterId: 'chapter', bodyFingerprint: 'B'.repeat(43) },
        status: 'active', confirmedAt: '2026-08-12T00:00:00.000Z',
      }],
    };
    const html = renderToStaticMarkup(<PromiseLedgerList
      entries={[evidenced]} completedChapterCount={12} disabled={false}
      deletingId={null} confirmDeleteId={null} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(html).toContain('变义');
    expect(html).toContain('正文证据：密信封口有旧城泥沙');
    expect(html).toContain('正文证据不可删');
  });
});
