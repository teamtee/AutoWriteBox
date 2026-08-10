import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  beginBookDeletion, Bookshelf, hasRenameDraft, isPendingBookDeletionCurrent,
  renameInputLabel, shouldConfirmRenameDiscard,
} from './Bookshelf';

const callbacks = {
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onRestore: vi.fn(),
  onExport: vi.fn(),
  onExportText: vi.fn(),
  onImport: vi.fn(),
  onRefresh: vi.fn(),
  onDeepDiagnostics: vi.fn(),
  onOpenSettings: vi.fn(),
};

describe('Bookshelf deletion anchor', () => {
  it('freezes the version visible on the first confirmation click', () => {
    const pending = beginBookDeletion({
      id: 'book-1', updatedAt: '2026-08-06T00:00:00.000Z',
    });
    const refreshed = {
      id: 'book-1', updatedAt: '2026-08-06T00:00:01.000Z',
    };

    expect(pending).toEqual({
      id: refreshed.id,
      expectedUpdatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(pending.expectedUpdatedAt).not.toBe(refreshed.updatedAt);
  });

  it('invalidates confirmation when the book disappears or its anchor changes', () => {
    const pending = beginBookDeletion({
      id: 'book-1', updatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(isPendingBookDeletionCurrent([{
      id: 'book-1', updatedAt: '2026-08-06T00:00:00.000Z',
    }], pending)).toBe(true);
    expect(isPendingBookDeletionCurrent([], pending)).toBe(false);
    expect(isPendingBookDeletionCurrent([{
      id: 'book-1', updatedAt: '2026-08-06T00:00:01.000Z',
    }], pending)).toBe(false);
  });
});

describe('Bookshelf storage diagnostics', () => {
  it('shows actionable details without offering automatic deletion or repair', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 1,
        issues: [{ code: 'BOOK_METADATA_INVALID', bookId: 'book_bad' }],
      }} />,
    );

    expect(html).toContain('检测到 1 处本地数据异常');
    expect(html).toContain('book_bad');
    expect(html).toContain('书籍元数据 JSON 损坏');
    expect(html).toContain('复制 data/ 目录备份');
    expect(html).not.toContain('自动修复');
  });

  it('explains when an oversized local file was skipped for memory safety', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'deep',
        scannedBooks: 1,
        issues: [{ code: 'CHAPTER_FILE_TOO_LARGE', bookId: 'book_1', sectionId: 'section-01', chapterId: 'chapter-01' }],
      }} />,
    );

    expect(html).toContain('章节文件异常过大，已停止读取');
    expect(html).toContain('book_1 / section-01 / chapter-01');
  });

  it('shows the exact retained atomic-write temp file without offering automatic cleanup', () => {
    const path = 'chapter-01.json.123.1700000000000.00000000-0000-4000-8000-000000000001.tmp';
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 1,
        issues: [{
          code: 'ATOMIC_WRITE_TEMP_PENDING', bookId: 'book_1',
          sectionId: 'section-01', path,
        }],
      }} />,
    );

    expect(html).toContain('异常退出遗留的原子写入临时文件');
    expect(html).toContain(`book_1 / section-01 / ${path}`);
    expect(html).toContain('先复制 data/ 目录备份');
    expect(html).not.toContain('自动清理');
  });

  it('shows a retained config temp file at the data root', () => {
    const path = 'config.json.123.1700000000000.00000000-0000-4000-8000-000000000001.tmp';
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 0,
        issues: [{ code: 'ATOMIC_WRITE_TEMP_PENDING', bookId: 'data', path }],
      }} />,
    );

    expect(html).toContain(`data / ${path}`);
    expect(html).toContain('异常退出遗留的原子写入临时文件');
  });

  it('explains config corruption without rendering any config value', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 0,
        issues: [{ code: 'CONFIG_DATA_INVALID', bookId: 'data/config.json' }],
      }} />,
    );

    expect(html).toContain('data/config.json');
    expect(html).toContain('API 配置字段类型、大小或地址安全性异常');
    expect(html).not.toContain('apiKey');
  });

  it('explains writing asset corruption without rendering stored sample text', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 0,
        issues: [{
          code: 'WRITING_ASSETS_DATA_INVALID', bookId: 'data/writing-assets.json',
        }],
      }} />,
    );

    expect(html).toContain('data/writing-assets.json');
    expect(html).toContain('创作资产库字段、数量或来源信息异常');
    expect(html).not.toContain('preview');
  });

  it('warns when directory enumeration was incomplete', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 1,
        issues: [
          { code: 'BOOKS_DIRECTORY_UNREADABLE', bookId: 'data/books' },
          { code: 'BOOK_DIRECTORY_UNREADABLE', bookId: 'book_1' },
          {
            code: 'SECTION_DIRECTORY_UNREADABLE',
            bookId: 'book_1', sectionId: 'section-01',
          },
        ],
      }} />,
    );

    expect(html).toContain('作品根目录无法枚举');
    expect(html).toContain('data/books');
    expect(html).toContain('作品目录无法完整枚举');
    expect(html).toContain('分部目录无法完整枚举');
    expect(html).toContain('book_1 / section-01');
  });

  it('explains that conflicting transaction targets were preserved for manual inspection', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 1,
        issues: [
          { code: 'BOOK_STRUCTURE_TRANSACTION_TARGET_CONFLICT', bookId: 'book_1' },
          {
            code: 'SECTION_STRUCTURE_TRANSACTION_TARGET_CONFLICT',
            bookId: 'book_1', sectionId: 'section-01',
          },
        ],
      }} />,
    );

    expect(html).toContain('分部事务与同名目标内容冲突，应用未自动接入或覆盖');
    expect(html).toContain('章节事务与同名目标内容冲突，应用未自动接入或覆盖');
    expect(html).toContain('book_1 / section-01');
  });

  it('explains when a chapter digest aggregation transaction needs recovery', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'quick',
        scannedBooks: 1,
        issues: [{
          code: 'CHAPTER_DIGEST_TRANSACTION_PENDING',
          bookId: 'book_1',
          sectionId: 'section-01',
        }],
      }} />,
    );

    expect(html).toContain('尚未完成的章节摘要聚合事务');
    expect(html).toContain('book_1 / section-01');
  });

  it('explains when a retained digest transaction conflicts with current content', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'deep',
        scannedBooks: 1,
        issues: [{
          code: 'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT',
          bookId: 'book_1',
          sectionId: 'section-01',
          chapterId: 'chapter-02',
        }],
      }} />,
    );

    expect(html).toContain('章节摘要聚合事务与当前正文或章节索引冲突，应用未自动覆盖');
    expect(html).toContain('book_1 / section-01 / chapter-02');
    expect(html).not.toContain('：CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT');
  });

  it('warns that a truncated diagnostic is incomplete', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} diagnostics={{
        ok: false,
        mode: 'deep',
        scannedBooks: 1,
        totalBooks: 1,
        truncated: true,
        issueLimit: 500,
        issues: Array.from({ length: 500 }, (_, index) => ({
          code: 'CHAPTER_FILE_MISSING',
          bookId: 'book_1',
          sectionId: 'section-01',
          chapterId: `chapter-${index}`,
        })),
      }} />,
    );

    expect(html).toContain('已显示前 500 处');
    expect(html).toContain('检查已在 500 条明细后提前停止');
    expect(html).toContain('不代表全部问题');
  });

  it('shows deleted books with an explicit restore action', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} deletedBooks={[{
        trashId: 'trash-1',
        bookId: 'book-1',
        title: '可恢复小说',
        deletedAt: '2026-08-05T00:00:00.000Z',
      }]} />,
    );

    expect(html).toContain('回收站（1）');
    expect(html).toContain('可恢复小说');
    expect(html).toContain('恢复');
  });

  it('explains deferred full validation for a large trash copy', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} deletedBooks={[{
        trashId: 'trash-large',
        bookId: 'book-large',
        title: '长篇副本',
        deletedAt: '2026-08-05T00:00:00.000Z',
        validationDeferred: true,
      }]} />,
    );

    expect(html).toContain('大型副本已通过流式结构检查');
    expect(html).toContain('恢复后会先完整校验');
    expect(html).toContain('失败时仍保留原副本');
    expect(html).toMatch(/<button class="hbtn mini"[^>]*>恢复<\/button>/);
  });

  it('keeps a damaged trash entry visible without offering unsafe automatic restore', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} deletedBooks={[{
        trashId: 'book_bad__deleted_1_deadbeef',
        bookId: 'book_bad',
        title: '',
        deletedAt: '2026-08-05T00:00:00.000Z',
        invalid: true,
        issueCode: 'TRASH_BOOK_METADATA_INVALID',
      }]} />,
    );

    expect(html).toContain('book_bad');
    expect(html).toContain('主数据缺失或损坏');
    expect(html).toContain('data/trash/books/book_bad__deleted_1_deadbeef');
    expect(html).toMatch(/<button class="hbtn mini" disabled=""[^>]*>无法自动恢复<\/button>/);
  });

  it('shows an unrecognized trash directory and its exact disk location', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} deletedBooks={[{
        trashId: '人工改名的回收站副本',
        bookId: '',
        title: '',
        deletedAt: '',
        invalid: true,
        issueCode: 'TRASH_DIRECTORY_NAME_INVALID',
      }]} />,
    );

    expect(html).toContain('无法识别的作品');
    expect(html).toContain('删除时间未知');
    expect(html).toContain('应用未读取其内容');
    expect(html).toContain('data/trash/books/人工改名的回收站副本');
    expect(html).toMatch(/<button class="hbtn mini" disabled=""[^>]*>无法自动恢复<\/button>/);
  });

  it('keeps a trash copy visible but disables restore when the active ID already exists', () => {
    const html = renderToStaticMarkup(
      <Bookshelf books={[]} {...callbacks} deletedBooks={[{
        trashId: 'book_1__deleted_1_deadbeef',
        bookId: 'book_1',
        title: '已恢复作品的残留副本',
        deletedAt: '2026-08-05T00:00:00.000Z',
        restoreBlockedByActiveBook: true,
      }]} />,
    );

    expect(html).toContain('书架已有同 ID 作品');
    expect(html).toContain('应用不会自动覆盖或删除');
    expect(html).toMatch(/<button class="hbtn mini" disabled=""[^>]*>书架已有作品<\/button>/);
  });

  it('offers import on the shelf and export on each active book', () => {
    const html = renderToStaticMarkup(
      <Bookshelf {...callbacks} books={[{
        id: 'book_1',
        title: '备份小说',
        updatedAt: '2026-08-05T00:00:00.000Z',
        sectionCount: 2,
        chapterCount: 8,
      }]} />,
    );

    expect(html).toContain('导入备份');
    expect(html).toContain('⇩ 备份');
    expect(html).toContain('TXT 正文');
    expect(html).toContain('深度检查');
    expect(html).toContain('.json,application/json');
    expect(html).toMatch(/<input[^>]*hidden=""[^>]*type="file"/);
    expect(html).toMatch(/class="spine spine-tone-\d+"/);
    expect(html).not.toContain('style=');
    expect(html).toContain('<button type="button" class="shelf-name">备份小说</button>');
  });

  it('locks shelf mutations and navigation while a persisted shelf action is running', () => {
    const html = renderToStaticMarkup(
      <Bookshelf {...callbacks} busy books={[{
        id: 'book_1',
        title: '忙碌作品',
        updatedAt: '2026-08-05T00:00:00.000Z',
        sectionCount: 1,
        chapterCount: 1,
      }]} deletedBooks={[{
        trashId: 'trash-1', bookId: 'book-old', title: '待恢复',
        deletedAt: '2026-08-05T00:00:00.000Z',
      }]} />,
    );

    expect(html).toMatch(/<button class="shelf-card new sketch" disabled="">/);
    expect(html).toMatch(/<button class="hbtn mini" disabled="">恢复<\/button>/);
    expect(html).toMatch(/<button class="hbtn" disabled="">⚙️ API 设置<\/button>/);
    expect(html).toContain('<button type="button" class="shelf-name" disabled="">忙碌作品</button>');
  });

  it('keeps auxiliary load failures visible and disables stale trash restore', () => {
    const html = renderToStaticMarkup(
      <Bookshelf {...callbacks} books={[]} diagnosticsLoadError="CHECK_FAILED"
        trashLoadError="TRASH_FAILED" deletedBooks={[{
          trashId: 'trash-1', bookId: 'book-old', title: '上次读取的副本',
          deletedAt: '2026-08-05T00:00:00.000Z',
        }]} />,
    );

    expect(html).toContain('书架状态未完全读取');
    expect(html).toContain('当前结果可能已过期');
    expect(html).toContain('重新读取书架');
    expect(html).toMatch(/<button class="hbtn mini" disabled=""[^>]*>\u6062\u590d<\/button>/);
    expect(html).not.toContain('CHECK_FAILED');
    expect(html).not.toContain('TRASH_FAILED');
  });
});

describe('Bookshelf rename draft protection', () => {
  it('only treats a meaningfully changed normalized title as dirty', () => {
    expect(hasRenameDraft('原书名', '原书名')).toBe(false);
    expect(hasRenameDraft('  原书名  ', '原书名')).toBe(false);
    expect(hasRenameDraft('原书名', '  原书名  ')).toBe(false);
    expect(hasRenameDraft('新书名', '原书名')).toBe(true);
    expect(hasRenameDraft('', '原书名')).toBe(true);
  });

  it('requires a second cancel only when the rename is dirty', () => {
    expect(shouldConfirmRenameDiscard(true, false)).toBe(true);
    expect(shouldConfirmRenameDiscard(true, true)).toBe(false);
    expect(shouldConfirmRenameDiscard(false, false)).toBe(false);
  });

  it('gives the rename editor a stable accessible name', () => {
    expect(renameInputLabel('原书名')).toBe('重命名作品：原书名');
    expect(renameInputLabel('  ')).toBe('重命名作品：未命名');
  });
});
