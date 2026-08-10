import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  FirstRun, hasCreationPremiseDraft, shouldConfirmCreationDiscard,
} from './FirstRun';
import { ToastProvider } from './Toast';

describe('FirstRun backup entry', () => {
  it('allows restoring a backup before creating the first book', () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <FirstRun premise="" onPremiseChange={vi.fn()} onCreated={vi.fn()}
          onImportBackup={vi.fn()} onOpenSettings={vi.fn()} />
      </ToastProvider>,
    );

    expect(html).toContain('导入小说备份');
    expect(html).toMatch(/<input[^>]*hidden=""[^>]*type="file"/);
  });
});

describe('FirstRun premise draft protection', () => {
  it('recognizes meaningful creation drafts and requires explicit discard', () => {
    expect(hasCreationPremiseDraft('   ')).toBe(false);
    expect(hasCreationPremiseDraft('一个完整的故事设想')).toBe(true);
    expect(shouldConfirmCreationDiscard(true, false)).toBe(true);
    expect(shouldConfirmCreationDiscard(true, true)).toBe(false);
    expect(shouldConfirmCreationDiscard(false, false)).toBe(false);
  });

  it('renders a shelf return action only when creation can be cancelled', () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <FirstRun premise="保留故事设想" onPremiseChange={vi.fn()} onCreated={vi.fn()}
          onImportBackup={vi.fn()} onOpenSettings={vi.fn()} onCancel={vi.fn()} />
      </ToastProvider>,
    );

    expect(html).toContain('保留故事设想');
    expect(html).toContain('aria-label="故事设想"');
    expect(html).toContain('返回书架');
  });
});
