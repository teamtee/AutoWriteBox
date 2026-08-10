import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  adoptIncomingDraft, createBeforeUnloadListener, hasDraftConflict, shouldDisableDraftReplacingAction, shouldSaveDraft,
  syncDraftState, VersionedBox, warnBeforeUnload,
} from './VersionedBox';

const callbacks = {
  onMove: vi.fn(),
  onRewrite: vi.fn(),
  onClear: vi.fn(),
  onSave: vi.fn(),
  onStop: vi.fn(),
};

describe('VersionedBox draft protection', () => {
  it('renders an explicit save action and saved state', () => {
    const html = renderToStaticMarkup(
      <VersionedBox
        {...callbacks}
        title="章节正文"
        versioned={{ versions: ['正文'], cursor: 0 }}
        streaming={false}
        streamingText="" />,
    );

    expect(html).toContain('保存（Ctrl/⌘+S）');
    expect(html).toMatch(/disabled=""[^>]*>💾 保存<\/button>/);
    expect(html).toContain('aria-label="章节正文内容"');
    expect(html).toContain('<h2 class="vbox-title">章节正文</h2>');
    expect(html).toContain('已保存');
  });

  it('can present initial chapter generation without calling it a rewrite', () => {
    const html = renderToStaticMarkup(
      <VersionedBox
        {...callbacks}
        title="第一章"
        versioned={{ versions: [''], cursor: 0 }}
        streaming={false}
        streamingText=""
        rewriteLabel="✍️ 生成本章" />,
    );

    expect(html).toContain('✍️ 生成本章');
    expect(html).not.toContain('🔄 重写');
  });

  it('makes persistent version switching explicit', () => {
    const html = renderToStaticMarkup(
      <VersionedBox
        {...callbacks}
        title="章节正文"
        versioned={{ versions: ['旧正文', '当前正文', '新正文'], cursor: 1 }}
        streaming={false}
        streamingText="" />,
    );

    expect(html).toContain('title="切换到上一版（会立即设为当前版本）"');
    expect(html).toContain('>◀ 上一版</button>');
    expect(html).toContain('title="切换到下一版（会立即设为当前版本）"');
    expect(html).toContain('>下一版 ▶</button>');
    expect(html).toContain('第 2 / 3 版 · 切换后立即生效');
  });

  it('marks beforeunload events so browsers warn about unsaved drafts', () => {
    const event = {
      preventDefault: vi.fn(),
      returnValue: 'unchanged',
    } as unknown as BeforeUnloadEvent;

    warnBeforeUnload(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
  });

  it('creates independent listeners so one component cleanup cannot disable another warning', () => {
    expect(createBeforeUnloadListener()).not.toBe(createBeforeUnloadListener());
  });

  it('adopts refreshed server text only for a clean draft', () => {
    expect(syncDraftState({ draft: '旧正文', base: '旧正文', conflict: false }, '新正文'))
      .toEqual({ draft: '新正文', base: '新正文', conflict: false });
  });

  it('preserves a dirty draft and marks a concurrent server change', () => {
    expect(hasDraftConflict(
      { draft: '本地草稿', base: '旧正文', conflict: false },
      '另一标签页的新正文',
    )).toBe(true);
    const conflicted = syncDraftState(
      { draft: '本地草稿', base: '旧正文', conflict: false },
      '另一标签页的新正文',
    );
    expect(conflicted).toEqual({
      draft: '本地草稿',
      base: '另一标签页的新正文',
      conflict: true,
    });
    expect(syncDraftState(conflicted, '本地草稿')).toEqual({
      draft: '本地草稿',
      base: '本地草稿',
      conflict: false,
    });
  });

  it('requires an explicit save after a concurrent server change', () => {
    expect(shouldSaveDraft({
      disabled: false, dirty: true, conflict: true, explicit: false,
    })).toBe(false);
    expect(shouldSaveDraft({
      disabled: false, dirty: true, conflict: true, explicit: true,
    })).toBe(true);
  });

  it('locks actions that would replace an unsaved draft', () => {
    expect(shouldDisableDraftReplacingAction({ disabled: false, dirty: true })).toBe(true);
    expect(shouldDisableDraftReplacingAction({ disabled: true, dirty: false })).toBe(true);
    expect(shouldDisableDraftReplacingAction({ disabled: false, dirty: false })).toBe(false);
  });

  it('fills a clean draft from an asset but never replaces local edits', () => {
    expect(adoptIncomingDraft(
      { draft: '已保存文风', base: '已保存文风', conflict: false },
      '已保存文风',
      '资产文风指令',
    )).toEqual({ draft: '资产文风指令', base: '已保存文风', conflict: false });
    const dirty = { draft: '我的未保存修改', base: '已保存文风', conflict: false };
    expect(adoptIncomingDraft(dirty, '已保存文风', '资产文风指令')).toBe(dirty);
  });
});
