import { useEffect, useRef, useState } from 'react';
import { runExclusiveAction } from '../asyncAction';
import type { BookSummary, DeletedBook, StorageDiagnostics, StorageIssue } from '../types';
import { bookSpineTone } from '../versioned';
import { useBeforeUnloadWarning } from './VersionedBox';

const issueLabels: Record<string, string> = {
  DATA_DIRECTORY_UNREADABLE: '数据根目录无法枚举，当前检查无法确认配置与作品数据',
  DATA_DIRECTORY_LIMIT_EXCEEDED: '数据根目录子项数量异常过多，已停止枚举',
  DATA_DIRECTORY_UNSAFE: '数据根目录是符号链接，已停止扫描以防越界访问',
  DATA_DIRECTORY_INVALID: '数据根路径不是可用的普通目录',
  CONFIG_METADATA_INVALID: 'API 配置文件 JSON 损坏',
  CONFIG_METADATA_TOO_LARGE: 'API 配置文件异常过大，已停止读取',
  CONFIG_METADATA_UNREADABLE: 'API 配置文件无法读取',
  CONFIG_METADATA_UNSAFE: 'API 配置路径包含不安全链接',
  CONFIG_METADATA_INVALID_SHAPE: 'API 配置路径不是普通文件',
  CONFIG_DATA_INVALID: 'API 配置字段类型、大小或地址安全性异常',
  WRITING_ASSETS_METADATA_INVALID: '创作资产库 JSON 损坏',
  WRITING_ASSETS_METADATA_TOO_LARGE: '创作资产库异常过大，已停止读取',
  WRITING_ASSETS_METADATA_UNREADABLE: '创作资产库无法读取',
  WRITING_ASSETS_METADATA_UNSAFE: '创作资产库路径包含不安全链接',
  WRITING_ASSETS_METADATA_INVALID_SHAPE: '创作资产库路径不是普通文件',
  WRITING_ASSETS_DATA_INVALID: '创作资产库字段、数量或来源信息异常',
  BOOKS_DIRECTORY_UNREADABLE: '作品根目录无法枚举，当前检查无法确认有哪些作品',
  BOOKS_DIRECTORY_LIMIT_EXCEEDED: '作品根目录子项数量异常过多，已停止枚举',
  BOOKS_DIRECTORY_UNSAFE: '作品根目录是符号链接，已停止扫描以防越界访问',
  BOOKS_DIRECTORY_INVALID: '作品根路径不是可用的普通目录',
  BOOK_DIRECTORY_ID_INVALID: '发现名称非法的作品目录',
  BOOK_DIRECTORY_UNSAFE: '发现不安全的作品目录链接',
  BOOK_DIRECTORY_UNREADABLE: '作品目录无法完整枚举，可能仍有未显示的孤立分部',
  BOOK_DIRECTORY_LIMIT_EXCEEDED: '作品目录子项数量异常过多，已停止枚举',
  BOOK_METADATA_MISSING: '书籍元数据缺失',
  BOOK_METADATA_INVALID: '书籍元数据 JSON 损坏',
  BOOK_METADATA_TOO_LARGE: '书籍元数据文件异常过大，已停止读取',
  BOOK_METADATA_UNREADABLE: '书籍元数据无法读取',
  BOOK_METADATA_UNSAFE: '书籍元数据路径包含不安全链接',
  BOOK_METADATA_INVALID_SHAPE: '书籍元数据结构异常',
  BOOK_ID_MISMATCH: '书籍目录与内部 ID 不一致',
  BOOK_SECTIONS_INVALID: '分部索引结构异常',
  BOOK_SECTIONS_LIMIT_EXCEEDED: '分部索引数量超过安全上限',
  BOOK_CHAPTERS_LIMIT_EXCEEDED: '整书章节索引总数超过安全上限',
  BOOK_DATA_INVALID: '书籍内容或元数据超出安全边界',
  BOOK_STRUCTURE_TRANSACTION_PENDING: '发现尚未完成的分部事务',
  BOOK_STRUCTURE_TRANSACTION_TARGET_CONFLICT: '分部事务与同名目标内容冲突，应用未自动接入或覆盖',
  BOOK_STRUCTURE_TRANSACTION_INVALID: '分部事务文件损坏，未自动恢复',
  BOOK_STRUCTURE_TRANSACTION_TOO_LARGE: '分部事务文件异常过大，未自动恢复',
  BOOK_STRUCTURE_TRANSACTION_UNREADABLE: '分部事务文件无法读取，未自动恢复',
  BOOK_STRUCTURE_TRANSACTION_UNSAFE: '分部事务路径包含不安全链接，未自动恢复',
  BOOK_STRUCTURE_TRANSACTION_INVALID_SHAPE: '分部事务路径不是普通文件，未自动恢复',
  SECTION_ID_INVALID: '分部索引包含非法 ID',
  SECTION_REFERENCE_DUPLICATE: '分部索引重复',
  SECTION_METADATA_MISSING: '分部文件缺失',
  SECTION_METADATA_INVALID: '分部文件 JSON 损坏',
  SECTION_METADATA_TOO_LARGE: '分部文件异常过大，已停止读取',
  SECTION_METADATA_UNREADABLE: '分部文件无法读取',
  SECTION_METADATA_UNSAFE: '分部数据路径包含不安全链接',
  SECTION_METADATA_INVALID_SHAPE: '分部文件结构异常',
  SECTION_ID_MISMATCH: '分部目录与内部 ID 不一致',
  SECTION_CHAPTERS_INVALID: '章节索引结构异常',
  SECTION_CHAPTERS_LIMIT_EXCEEDED: '章节索引数量超过安全上限',
  SECTION_DATA_INVALID: '分部内容或元数据超出安全边界',
  SECTION_STRUCTURE_TRANSACTION_PENDING: '发现尚未完成的章节事务',
  SECTION_STRUCTURE_TRANSACTION_TARGET_CONFLICT: '章节事务与同名目标内容冲突，应用未自动接入或覆盖',
  SECTION_STRUCTURE_TRANSACTION_INVALID: '章节事务文件损坏，未自动恢复',
  SECTION_STRUCTURE_TRANSACTION_TOO_LARGE: '章节事务文件异常过大，未自动恢复',
  SECTION_STRUCTURE_TRANSACTION_UNREADABLE: '章节事务文件无法读取，未自动恢复',
  SECTION_STRUCTURE_TRANSACTION_UNSAFE: '章节事务路径包含不安全链接，未自动恢复',
  SECTION_STRUCTURE_TRANSACTION_INVALID_SHAPE: '章节事务路径不是普通文件，未自动恢复',
  CHAPTER_DIGEST_TRANSACTION_PENDING: '发现尚未完成的章节摘要聚合事务',
  CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT: '章节摘要聚合事务与当前正文或章节索引冲突，应用未自动覆盖',
  CHAPTER_DIGEST_TRANSACTION_INVALID: '章节摘要聚合事务文件损坏，未自动恢复',
  CHAPTER_DIGEST_TRANSACTION_TOO_LARGE: '章节摘要聚合事务文件异常过大，未自动恢复',
  CHAPTER_DIGEST_TRANSACTION_UNREADABLE: '章节摘要聚合事务文件无法读取，未自动恢复',
  CHAPTER_DIGEST_TRANSACTION_UNSAFE: '章节摘要聚合事务路径包含不安全链接，未自动恢复',
  CHAPTER_DIGEST_TRANSACTION_INVALID_SHAPE: '章节摘要聚合事务路径不是普通文件，未自动恢复',
  SECTION_DIRECTORY_ORPHANED: '发现未被书籍索引引用的分部目录',
  SECTION_DIRECTORY_UNREADABLE: '分部目录无法完整枚举，可能仍有未显示的孤立章节',
  SECTION_DIRECTORY_LIMIT_EXCEEDED: '分部目录子项数量异常过多，已停止枚举',
  CHAPTER_ID_INVALID: '章节索引包含非法 ID',
  CHAPTER_REFERENCE_DUPLICATE: '章节索引重复',
  CHAPTER_FILE_MISSING: '章节文件缺失',
  CHAPTER_FILE_INVALID: '章节文件 JSON 损坏',
  CHAPTER_FILE_TOO_LARGE: '章节文件异常过大，已停止读取',
  CHAPTER_FILE_UNREADABLE: '章节文件无法读取',
  CHAPTER_FILE_UNSAFE: '章节文件路径包含不安全链接',
  CHAPTER_FILE_INVALID_SHAPE: '章节文件结构异常',
  CHAPTER_ID_MISMATCH: '章节文件名与内部 ID 不一致',
  CHAPTER_DATA_INVALID: '章节内容或元数据超出安全边界',
  CHAPTER_FILE_ORPHANED: '发现未被分部索引引用的章节文件',
  ATOMIC_WRITE_TEMP_PENDING: '发现异常退出遗留的原子写入临时文件；正式数据未被覆盖，请先备份后人工核对',
  ATOMIC_WRITE_TEMP_UNSAFE: '发现名称伪装成原子写入临时文件的不安全链接；应用未跟随或删除',
};

const issueLocation = (issue: StorageIssue) =>
  [issue.bookId, issue.sectionId, issue.chapterId, issue.path].filter(Boolean).join(' / ');

export function hasRenameDraft(draft: string, original: string) {
  return draft.trim() !== original.trim();
}

export function shouldConfirmRenameDiscard(dirty: boolean, confirmed: boolean) {
  return dirty && !confirmed;
}

export function renameInputLabel(original: string) {
  return `重命名作品：${original.trim() || '未命名'}`;
}

export type PendingBookDeletion = { id: string; expectedUpdatedAt: string };

export function beginBookDeletion(
  book: Pick<BookSummary, 'id' | 'updatedAt'>,
): PendingBookDeletion {
  // 两步确认必须冻结第一次点击时看到的版本；确认期间即使书架刷新，
  // 也不能偷偷采用新版锚点去删除另一页面刚保存的内容。
  return { id: book.id, expectedUpdatedAt: book.updatedAt };
}

export function isPendingBookDeletionCurrent(
  books: Array<Pick<BookSummary, 'id' | 'updatedAt'>>,
  pending: PendingBookDeletion | null,
) {
  if (!pending) return true;
  return books.some((book) => book.id === pending.id
    && book.updatedAt === pending.expectedUpdatedAt);
}

// 书架组件：微信读书风格的卡片概览，支持新建 / 打开 / 内联改名 / 两步删除
export function Bookshelf({ books, deletedBooks = [], diagnostics, diagnosticsLoadError, trashLoadError, busy = false, onOpen, onNew, onRename, onDelete, onRestore, onExport, onExportText, onImport, onRefresh, onDeepDiagnostics, onOpenSettings }: {
  books: BookSummary[];
  deletedBooks?: DeletedBook[];
  diagnostics?: StorageDiagnostics | null;
  diagnosticsLoadError?: string | null;
  trashLoadError?: string | null;
  busy?: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string, expectedTitle: string) => boolean | Promise<boolean>;
  onDelete: (id: string, expectedUpdatedAt: string) => void;
  onRestore: (trashId: string) => void;
  onExport: (bookId: string) => void | Promise<void>;
  onExportText: (bookId: string) => void | Promise<void>;
  onImport: (file: File) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onDeepDiagnostics: () => void | Promise<void>;
  onOpenSettings: () => void;
}) {
  // 当前进入改名态的书 id
  const [renaming, setRenaming] = useState<string | null>(null);
  // 改名输入草稿
  const [draft, setDraft] = useState('');
  const [renameBase, setRenameBase] = useState('');
  const [confirmRenameCancel, setConfirmRenameCancel] = useState(false);
  const [renameSaving, setRenameSaving] = useState(false);
  const renameSavingRef = useRef(false);
  // 当前进入删除确认态的书 id
  const [confirmDel, setConfirmDel] = useState<PendingBookDeletion | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [checking, setChecking] = useState(false);
  // React 状态要到下一次渲染才会进入事件处理器闭包；只靠 disabled / exporting
  // 会让同一帧内的双击重复发起导出、导入或全盘检查。同步 ref 作为三者共用的门。
  const auxiliaryActionRef = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const activeConfirmDel = isPendingBookDeletionCurrent(books, confirmDel)
    ? confirmDel
    : null;
  const interactionLocked = busy || importing || !!exporting || checking || renameSaving;
  const renameDirty = renaming !== null && hasRenameDraft(draft, renameBase);
  // 改名框自身的输入/保存/取消仍可用；其它会卸载或覆盖草稿的动作锁住。
  const externalInteractionLocked = interactionLocked || renameDirty;
  const resetRename = () => {
    setRenaming(null);
    setDraft('');
    setRenameBase('');
    setConfirmRenameCancel(false);
  };
  useBeforeUnloadWarning(renameDirty || interactionLocked);
  useEffect(() => {
    if (!renaming) return;
    const refreshed = books.find((book) => book.id === renaming);
    if (!refreshed) {
      resetRename();
      return;
    }
    if (refreshed.title === renameBase) return;
    // 操作结果未确认后，书架刷新可能已经确认目标标题；冲突刷新则采用新的
    // 服务端标题作为重试基线，同时保留用户输入。
    if (refreshed.title === draft.trim()) resetRename();
    else {
      setRenameBase(refreshed.title);
      setConfirmRenameCancel(false);
    }
  }, [books, draft, renameBase, renaming]);
  useEffect(() => {
    if (!isPendingBookDeletionCurrent(books, confirmDel)) setConfirmDel(null);
  }, [books, confirmDel]);
  const beginRename = (book: BookSummary) => {
    if (externalInteractionLocked) return;
    setRenaming(book.id);
    setDraft(book.title);
    setRenameBase(book.title);
    setConfirmRenameCancel(false);
  };
  const submitRename = async () => {
    if (!renaming || interactionLocked || renameSavingRef.current
      || !draft.trim() || !renameDirty) return;
    renameSavingRef.current = true;
    setRenameSaving(true);
    try {
      if (await onRename(renaming, draft.trim(), renameBase)) resetRename();
    } finally {
      renameSavingRef.current = false;
      setRenameSaving(false);
    }
  };
  const cancelRename = () => {
    if (interactionLocked) return;
    if (shouldConfirmRenameDiscard(renameDirty, confirmRenameCancel)) {
      setConfirmRenameCancel(true);
      return;
    }
    resetRename();
  };
  const exportBackup = async (bookId: string) => {
    await runExclusiveAction({
      isRunning: () => auxiliaryActionRef.current || externalInteractionLocked,
      setRunning: (running) => {
        auxiliaryActionRef.current = running;
        setExporting(running ? `backup:${bookId}` : null);
      },
      task: async () => { await onExport(bookId); },
    });
  };
  const exportText = async (bookId: string) => {
    await runExclusiveAction({
      isRunning: () => auxiliaryActionRef.current || externalInteractionLocked,
      setRunning: (running) => {
        auxiliaryActionRef.current = running;
        setExporting(running ? `text:${bookId}` : null);
      },
      task: async () => { await onExportText(bookId); },
    });
  };
  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      await runExclusiveAction({
        isRunning: () => auxiliaryActionRef.current || externalInteractionLocked,
        setRunning: (running) => {
          auxiliaryActionRef.current = running;
          setImporting(running);
        },
        task: async () => { await onImport(file); },
      });
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };
  const runDeepDiagnostics = async () => {
    await runExclusiveAction({
      isRunning: () => auxiliaryActionRef.current || externalInteractionLocked,
      setRunning: (running) => {
        auxiliaryActionRef.current = running;
        setChecking(running);
      },
      task: async () => { await onDeepDiagnostics(); },
    });
  };

  return (
    <div className="shelf">
      <div className="shelf-heading">
        <h1 className="shelf-title">📚 我的书架</h1>
        <div className="shelf-heading-actions">
          <input ref={importRef} hidden type="file" accept=".json,application/json"
            onChange={(event) => { void importBackup(event.currentTarget.files?.[0]); }} />
          <button className="hbtn" disabled={externalInteractionLocked} onClick={() => importRef.current?.click()}>
            {importing ? '导入中…' : '⇧ 导入备份'}
          </button>
          <button className="hbtn" disabled={externalInteractionLocked} onClick={() => { void runDeepDiagnostics(); }}>
            {checking ? '检查中…' : '⌕ 深度检查'}
          </button>
          <button className="hbtn" disabled={externalInteractionLocked} onClick={onOpenSettings}>⚙️ API 设置</button>
        </div>
      </div>
      {(diagnosticsLoadError || trashLoadError) && (
        <div className="storage-warning sketch" role="alert">
          <strong>书架状态未完全读取</strong>
          <span>{diagnosticsLoadError && trashLoadError
            ? '本地完整性检查和回收站读取均失败；界面保留上一次成功结果，当前结果可能已过期。'
            : diagnosticsLoadError
              ? '本地完整性检查失败；异常告警保留为上一次成功结果。'
              : '回收站读取失败；已删除作品列表保留为上一次成功结果，恢复前请先重新读取。'}</span>
          <button className="hbtn mini" disabled={externalInteractionLocked}
            onClick={() => { void onRefresh(); }}>重新读取书架</button>
        </div>
      )}
      {!!diagnostics?.issues.length && (
        <div className="storage-warning sketch" role="alert">
          <strong>{diagnostics.truncated
            ? `已显示前 ${diagnostics.issues.length} 处本地数据异常`
            : `检测到 ${diagnostics.issues.length} 处本地数据异常`}</strong>
          <span>{diagnostics.truncated
            ? `异常过多，检查已在 ${diagnostics.issueLimit ?? diagnostics.issues.length} 条明细后提前停止；当前结果不代表全部问题。请先复制 data/ 目录备份。`
            : '部分作品可能没有显示。请先复制 data/ 目录备份；应用不会自动删除或覆盖这些文件。'}</span>
          <details>
            <summary>查看异常详情</summary>
            <ul>
              {diagnostics.issues.map((issue, index) => (
                <li key={`${issue.code}-${issueLocation(issue)}-${index}`}>
                  <code>{issueLocation(issue)}</code>：{issueLabels[issue.code] || issue.code}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {!!deletedBooks.length && (
        <details className="trash-panel sketch">
          <summary>回收站（{deletedBooks.length}）</summary>
          <div className="trash-list">
            {deletedBooks.map((book) => (
              <div className="trash-row" key={book.trashId}>
                <span>{book.invalid ? `⚠ ${book.title || book.bookId || '无法识别的作品'}` : (book.title || '未命名')}</span>
                <span className="shelf-meta">{book.deletedAt ? new Date(book.deletedAt).toLocaleString() : '删除时间未知'}</span>
                {book.invalid && <span className="shelf-meta" title={book.issueCode}>
                  {book.issueCode?.startsWith('TRASH_DIRECTORY_')
                    ? <>目录名称异常或为不安全链接；应用未读取其内容，原条目仍保留在 <code>data/trash/books/{book.trashId}</code></>
                    : <>主数据缺失或损坏；原文件仍保留在 <code>data/trash/books/{book.trashId}</code></>}
                </span>}
                {!book.invalid && book.restoreBlockedByActiveBook && <span className="shelf-meta">
                  书架已有同 ID 作品；此回收站副本仍会保留，应用不会自动覆盖或删除
                </span>}
                {!book.invalid && book.validationDeferred && <span className="shelf-meta">
                  大型副本已通过流式结构检查；点击恢复后会先完整校验，失败时仍保留原副本
                </span>}
                <button className="hbtn mini" disabled={externalInteractionLocked || !!trashLoadError || book.invalid || book.restoreBlockedByActiveBook}
                  title={trashLoadError
                    ? '回收站列表可能已过期，请先重新读取书架'
                    : book.invalid
                    ? '请先备份 data/trash 目录并人工检查，应用不会自动覆盖或删除'
                    : book.restoreBlockedByActiveBook
                      ? '活动书架已有同 ID 作品；请先确认两份数据，应用不会自动删除回收站副本'
                      : undefined}
                  onClick={() => onRestore(book.trashId)}>{book.invalid
                    ? '无法自动恢复'
                    : book.restoreBlockedByActiveBook ? '书架已有作品' : '恢复'}</button>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="shelf-grid">
        <button className="shelf-card new sketch" disabled={externalInteractionLocked} onClick={onNew}>＋ 新建一本</button>
        {books.map((b) => (
          <div key={b.id} className="shelf-card sketch">
            <div className={`spine spine-tone-${bookSpineTone(b.id)}`} />
            {renaming === b.id ? (
              <input className="shelf-rename" autoFocus aria-label={renameInputLabel(renameBase)}
                maxLength={200} disabled={interactionLocked} value={draft}
                onChange={(e) => { setConfirmRenameCancel(false); setDraft(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename();
                  else if (e.key === 'Escape') cancelRename();
                }} />
            ) : (
              <button type="button" className="shelf-name" disabled={externalInteractionLocked}
                onClick={() => onOpen(b.id)}>{b.title || '未命名'}</button>
            )}
            <div className="shelf-meta">{b.sectionCount} 部 · {b.chapterCount} 章</div>
            <div className="shelf-meta dim">{new Date(b.updatedAt).toLocaleString()}</div>
            <div className="shelf-ops">
              {renaming === b.id
                ? <>
                  <button className="hbtn mini" disabled={interactionLocked || !draft.trim() || !renameDirty}
                    onClick={() => { void submitRename(); }}>{renameSaving ? '保存中…' : '保存'}</button>
                  <button className={confirmRenameCancel ? 'hbtn mini accent' : 'hbtn mini'} disabled={interactionLocked}
                    onClick={cancelRename}>{confirmRenameCancel ? '确认取消？' : '取消'}</button>
                </>
                : <button className="hbtn mini" disabled={externalInteractionLocked} onClick={() => beginRename(b)}>✏️ 改名</button>}
              <button className="hbtn mini" disabled={externalInteractionLocked}
                onClick={() => { void exportBackup(b.id); }}>
                {exporting === `backup:${b.id}` ? '备份中…' : '⇩ 备份'}
              </button>
              <button className="hbtn mini" disabled={externalInteractionLocked}
                onClick={() => { void exportText(b.id); }}>
                {exporting === `text:${b.id}` ? 'TXT 中…' : 'TXT 正文'}
              </button>
              {activeConfirmDel?.id === b.id
                ? <button className="hbtn mini accent" disabled={externalInteractionLocked} onClick={() => { const pending = activeConfirmDel; setConfirmDel(null); onDelete(pending.id, pending.expectedUpdatedAt); }}>移入回收站？</button>
                : <button className="hbtn mini" disabled={externalInteractionLocked} onClick={() => setConfirmDel(beginBookDeletion(b))}>🗑 移入回收站</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
