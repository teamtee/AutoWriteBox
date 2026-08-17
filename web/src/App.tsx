import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Book, BookTree, BookSummary, Chapter, ChapterPlan, ChapterPlanInput,
  DeletedBook, SectionPlan,
  PlatformConfirmationInput, StorageDiagnostics, Versioned,
} from './types';
import type { Selection } from './store';
import * as api from './api';
import {
  adoptSectionTitles, applyShelfSupplementalLoadResult,
  chapterPostprocessWarningMessage, lastChapterIdForSection, lastSectionIdForBook,
  loadBookWorkspace, loadShelfBooks, localDraftBlockReason, messageOf,
  nextChapterSelection,
  nextSectionPlanReturnFocus, outlinePostprocessWarningMessage,
  ownsActiveGeneration, reconcileAcknowledgedCreationOpen,
  reconcileCreatedShelfMutationFailure, reconcileGenerationFailure,
  reconcilePersistedMutationFailure, reconcileVersionConflict,
  refreshOwnedGeneration, refreshPersistedChange, refreshStoppedGeneration,
  runPersistedCreation,
  refreshStoppedReview, runPersistedReviewRequest, runShelfMutation,
  saveChapterPlanWithReconciliation,
  shouldDisableSidebar,
  shouldDisableVersionedBox, shouldShowFirstRun, shouldWarnBeforeUnloadForApp,
  updateDirtyDraftPaths, verifiedShelfRefresh,
} from './app-workflows';
import { useToast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { MainPanel } from './components/MainPanel';
import {
  Actions, hasWhipInstructionDraft, isSubmittedWhipDraft,
} from './components/Actions';
import { SettingsPage } from './components/SettingsPage';
import { FirstRun, hasCreationPremiseDraft } from './components/FirstRun';
import { sectionPlanOutline, SectionPlanPanel } from './components/SectionPlanPanel';
import { Bookshelf } from './components/Bookshelf';
import { LoadingState } from './components/LoadingState';
import { currentText } from './versioned';
import {
  createLatestAbortGate, finishOwnedAction,
  runExclusiveAction, startExclusiveAction,
} from './asyncAction';
import { useBeforeUnloadWarning } from './components/VersionedBox';

// 顶层视图：书架 / 单本书
type View = 'shelf' | 'book';
type LoadedChapter = { sectionId: string; chapter: Chapter };
export * from './app-workflows';
export { runExclusiveAction as runExclusiveSectionAdoption } from './asyncAction';
export { runExclusiveAction as runExclusiveStructureMutation } from './asyncAction';
export { runExclusiveAction as runExclusiveVersionMutation } from './asyncAction';

export default function App() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('shelf');
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const [storageDiagnostics, setStorageDiagnostics] = useState<StorageDiagnostics | null>(null);
  const [diagnosticsLoadError, setDiagnosticsLoadError] = useState<string | null>(null);
  const [deletedBooks, setDeletedBooks] = useState<DeletedBook[]>([]);
  const [trashLoadError, setTrashLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creationPremise, setCreationPremise] = useState('');
  const [tree, setTree] = useState<BookTree | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'outline' });
  const [loadedChapter, setLoadedChapter] = useState<LoadedChapter | null>(null);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamStopping, setStreamStopping] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  // 当前流式的分派路径；章节任意生成统一为 'chapter' 哨兵
  const [streamingPath, setStreamingPath] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planText, setPlanText] = useState('');
  const [planTitles, setPlanTitles] = useState<string[]>([]);
  const [planSections, setPlanSections] = useState<SectionPlan[]>([]);
  const [planParseError, setPlanParseError] = useState(false);
  const [planAdopting, setPlanAdopting] = useState(false);
  const [structureMutating, setStructureMutating] = useState(false);
  const [versionMutating, setVersionMutating] = useState(false);
  const [memoryRecomputing, setMemoryRecomputing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [shelfMutating, setShelfMutating] = useState(false);
  const [hasDirtyDraft, setHasDirtyDraft] = useState(false);
  const [whipDraft, setWhipDraft] = useState('');
  const streamHandleRef = useRef<api.StreamGenHandle | null>(null);
  const streamingRef = useRef(false);
  const streamStoppingRef = useRef(false);
  const streamStopOperationRef = useRef<Promise<void> | null>(null);
  const streamingTokenRef = useRef(0);
  const planAdoptingRef = useRef(false);
  const structureMutatingRef = useRef(false);
  const versionMutatingRef = useRef(false);
  const reviewingRef = useRef(false);
  const reviewKindRef = useRef<'chapter' | 'golden-three' | null>(null);
  const reviewRequestRunningRef = useRef(false);
  const reviewRequestGate = useRef(createLatestAbortGate()).current;
  const reviewOperationRef = useRef<Promise<unknown> | null>(null);
  const reviewStoppingRef = useRef(false);
  const reviewStopOperationRef = useRef<Promise<void> | null>(null);
  const shelfMutatingRef = useRef(false);
  const savedSelectionRef = useRef<Selection | null>(null);
  const chapterLoadGate = useRef(createLatestAbortGate()).current;
  const shelfLoadGate = useRef(createLatestAbortGate()).current;
  const dirtyDraftPathsRef = useRef(new Set<string>());
  const whipDraftRef = useRef('');
  const whipDraftDirtyRef = useRef(false);
  const sectionPlanReturnFocusRef = useRef<HTMLElement | null>(null);
  const updateDraftDirty = useCallback((path: string, dirty: boolean) => {
    const next = updateDirtyDraftPaths(dirtyDraftPathsRef.current, path, dirty);
    setHasDirtyDraft((current) => current === next ? current : next);
  }, []);
  const updateWhipDraft = useCallback((text: string) => {
    whipDraftRef.current = text;
    whipDraftDirtyRef.current = hasWhipInstructionDraft(text);
    setWhipDraft(text);
  }, []);
  const whipDraftDirty = hasWhipInstructionDraft(whipDraft);
  const creationPremiseDirty = hasCreationPremiseDraft(creationPremise);
  const hasAnyLocalDraft = hasDirtyDraft || whipDraftDirty;
  const generationBusy = streaming || streamStopping;
  const isGenerationBusy = () => streamingRef.current || streamStoppingRef.current;
  const blockDirtyDraftAction = ({ allowWhipDraft = false } = {}) => {
    const reason = localDraftBlockReason({
      hasEditorDraft: dirtyDraftPathsRef.current.size > 0,
      hasWhipDraft: whipDraftDirtyRef.current,
      allowWhipDraft,
    });
    if (!reason) return false;
    if (reason === 'editor') {
      toast.error('当前页面有未保存修改；请先保存，或在编辑器中两次点击“放弃修改”');
    } else {
      toast.error('抽打指令尚未提交；请先点击“抽”，或清空输入框后再离开');
    }
    return true;
  };

  useBeforeUnloadWarning(shouldWarnBeforeUnloadForApp({
    hasEditorDraft: hasDirtyDraft,
    creationPremiseDraft: creationPremiseDirty,
    whipDraft: whipDraftDirty,
    sectionPlanDraft: planOpen && Boolean(planText.trim()),
    streaming: generationBusy,
    reviewing,
    versionMutating,
    structureMutating,
    planAdopting,
    shelfMutating,
  }));

  // 拉取书架列表
  const loadShelf = async ({ requireTrash = false }: { requireTrash?: boolean } = {}) => {
    const { token, signal } = shelfLoadGate.begin();
    const list = await loadShelfBooks(
      api.listBooks,
      setBooks,
      setShelfError,
      (message) => toast.error('加载书架失败：' + message),
      () => shelfLoadGate.owns(token),
      signal,
    );
    let trashError: string | null = null;
    if (list && shelfLoadGate.owns(token)) {
      const [diagnosticsResult, deletedResult] = await Promise.allSettled([
        api.getStorageDiagnostics(false, signal),
        api.listDeletedBooks(signal),
      ]);
      if (!shelfLoadGate.owns(token)) return null;
      const diagnosticsError = applyShelfSupplementalLoadResult(
        diagnosticsResult, setStorageDiagnostics, setDiagnosticsLoadError,
      );
      if (diagnosticsError) toast.error('本地数据完整性检查失败：' + diagnosticsError);
      const deletedError = applyShelfSupplementalLoadResult(
        deletedResult, setDeletedBooks, setTrashLoadError,
      );
      trashError = deletedError;
      if (deletedError) toast.error('读取回收站失败：' + deletedError);
    }
    return verifiedShelfRefresh(list, { requireTrash, trashError });
  };
  useEffect(() => {
    let mounted = true;
    void loadShelf().finally(() => { if (mounted) setLoading(false); });
    return () => {
      mounted = false;
      shelfLoadGate.invalidate();
    };
  }, []);

  const setShelfMutationRunning = (running: boolean) => {
    shelfMutatingRef.current = running;
    setShelfMutating(running);
  };

  const importBackup = async (file: File) => {
    await runExclusiveAction({
      isRunning: () => shelfMutatingRef.current,
      setRunning: setShelfMutationRunning,
      task: async () => {
        chapterLoadGate.invalidate();
        const expectedBookId = api.createClientBookId();
        try { await api.importBookBackup(file, expectedBookId); }
        catch (e) {
          const reconciled = await reconcileCreatedShelfMutationFailure({
            error: e,
            expectedBookId,
            refresh: loadShelf,
          });
          if (reconciled.status === 'created') {
            setCreating(false);
            setCreationPremise('');
            toast.info(`导入结果未确认，但书架检测到 ${reconciled.createdIds.length} 本新副本；请确认标题，不要重复导入`);
          } else if (reconciled.status === 'not_created') {
            toast.error('导入结果未确认；刷新后未检测到新副本，可以重试：' + messageOf(e));
          } else if (reconciled.status === 'unknown') {
            toast.error('导入结果未确认且无法刷新书架；请重新打开书架确认后再重试');
          } else toast.error('导入失败：' + messageOf(e));
          return;
        }
        setCreating(false);
        setCreationPremise('');
        const refreshed = await loadShelf();
        if (refreshed) toast.success('✓ 已导入为新的小说副本');
        else toast.error('备份已导入，但书架刷新失败');
      },
    });
  };
  const exportBackup = async (bookId: string) => {
    try {
      await api.downloadBookBackup(bookId);
      toast.success('✓ 备份下载已开始（不包含 API Key）');
    } catch (e) {
      toast.error('导出失败：' + messageOf(e));
    }
  };
  const exportText = async (bookId: string) => {
    try {
      const result = await api.downloadBookManuscript(bookId, 'current');
      const skipped = result.skippedChapterCount
        ? `；跳过 ${result.skippedChapterCount} 个空章`
        : '';
      toast.success(`✓ 正文 TXT 下载已开始，共 ${result.exportedChapterCount} 章${skipped}`);
    } catch (e) {
      toast.error('正文 TXT 导出失败：' + messageOf(e));
    }
  };

  const openBook = async (id: string, reportFailure = true): Promise<boolean> => {
    const { token, signal } = chapterLoadGate.begin();
    try {
      const snapshot = await loadBookWorkspace({
        bookId: id,
        getTree: api.getTree,
        getChapter: api.getChapter,
        signal,
        isCurrent: () => chapterLoadGate.owns(token),
      });
      if (!snapshot) return false;
      setTree(snapshot.tree);
      setSelection(snapshot.selection);
      setLoadedChapter(snapshot.loadedChapter);
      setChapterLoading(false);
      setView('book');
      return true;
    } catch (e) {
      if (chapterLoadGate.owns(token) && reportFailure) {
        toast.error('打开失败：' + messageOf(e));
      }
      return false;
    }
  };
  const reload = async (bookId: string, sel?: Selection) => {
    const { token, signal } = chapterLoadGate.begin();
    const snapshot = await loadBookWorkspace({
      bookId,
      requestedSelection: sel ?? selection,
      getTree: api.getTree,
      getChapter: api.getChapter,
      signal,
      isCurrent: () => chapterLoadGate.owns(token),
      setChapterLoading,
    });
    if (!snapshot) return;
    setTree(snapshot.tree);
    setSelection(snapshot.selection);
    setLoadedChapter(snapshot.loadedChapter);
  };
  const selectWorkspace = (nextSelection: Selection) => {
    // blur 会先于 click 触发自动保存；这里再读 ref 防止同一次点击
    // 绕过旧渲染中的 disabled，导致迟到刷新把用户拉回旧章。
    if (isGenerationBusy() || reviewingRef.current
      || versionMutatingRef.current || structureMutatingRef.current
      || planAdoptingRef.current) return;
    if (blockDirtyDraftAction()) return;
    setSelection(nextSelection);
    const { token, signal } = chapterLoadGate.begin();
    if (nextSelection.kind !== 'chapter') {
      setLoadedChapter(null);
      setChapterLoading(false);
      return;
    }
    setLoadedChapter(null);
    setChapterLoading(true);
    const selectedBookId = tree?.book.id;
    if (!selectedBookId) {
      setChapterLoading(false);
      return;
    }
    void api.getChapter(selectedBookId, nextSelection.sectionId, nextSelection.chapterId, signal)
      .then((chapter) => {
        if (!chapterLoadGate.owns(token)) return;
        setLoadedChapter({ sectionId: nextSelection.sectionId, chapter });
        setChapterLoading(false);
      })
      .catch((e) => {
        if (!chapterLoadGate.owns(token)) return;
        setChapterLoading(false);
        toast.error('章节加载失败：' + messageOf(e));
      });
  };
  const setStreamingRunning = (running: boolean) => {
    streamingRef.current = running;
    setStreaming(running);
    if (!running) {
      setStreamingPath(null);
      setStatusText('');
      streamHandleRef.current = null;
    }
  };
  const setStreamStoppingRunning = (running: boolean) => {
    streamStoppingRef.current = running;
    setStreamStopping(running);
    if (!running && !streamingRef.current) setStatusText('');
  };
  const ownsStreaming = (token: number) => ownsActiveGeneration({
    running: streamingRef.current,
    token,
    currentToken: streamingTokenRef.current,
  });
  const finishStreaming = (token?: number) => {
    if (token === undefined) {
      setStreamingRunning(false);
      return true;
    }
    if (!ownsStreaming(token)) return false;
    return finishOwnedAction({
      token,
      currentToken: () => streamingTokenRef.current,
      finish: () => setStreamingRunning(false),
    });
  };
  const startStreaming = (start: (token: number) => void) => startExclusiveAction({
    isRunning: () => dirtyDraftPathsRef.current.size > 0
      || isGenerationBusy() || reviewingRef.current || versionMutatingRef.current
      || structureMutatingRef.current || planAdoptingRef.current,
    setRunning: setStreamingRunning,
    start: () => {
      savedSelectionRef.current = null;
      const token = streamingTokenRef.current + 1;
      streamingTokenRef.current = token;
      start(token);
    },
  });
  const setStructureMutationRunning = (running: boolean) => {
    structureMutatingRef.current = running;
    setStructureMutating(running);
  };
  const setVersionMutationRunning = (running: boolean) => {
    versionMutatingRef.current = running;
    setVersionMutating(running);
  };
  const setMemoryRecomputeRunning = (running: boolean) => {
    setMemoryRecomputing(running);
    setVersionMutationRunning(running);
  };
  const syncReviewRunning = () => {
    const running = reviewRequestRunningRef.current || reviewStoppingRef.current;
    if (!running) reviewKindRef.current = null;
    reviewingRef.current = running;
    setReviewing(running);
  };
  const setReviewRequestRunning = (running: boolean) => {
    reviewRequestRunningRef.current = running;
    syncReviewRunning();
  };
  const setReviewStoppingRunning = (running: boolean) => {
    reviewStoppingRef.current = running;
    syncReviewRunning();
  };
  const abortReview = () => {
    reviewRequestGate.invalidate();
  };
  // 返回书架前先停掉任意进行中的流，避免离开后仍有 SSE 回调改状态
  const goShelf = async () => {
    if (isGenerationBusy()) await stopGen();
    else if (reviewingRef.current) await stopReview();
    else if (versionMutatingRef.current || structureMutatingRef.current || planAdoptingRef.current) return;
    if (blockDirtyDraftAction()) return;
    chapterLoadGate.invalidate();
    setLoadedChapter(null);
    setChapterLoading(false);
    setCreating(false);
    setView('shelf');
    await loadShelf();
  };

  const openSettings = () => {
    if (isGenerationBusy() || reviewingRef.current || versionMutatingRef.current
      || structureMutatingRef.current || planAdoptingRef.current || shelfMutatingRef.current) return;
    if (blockDirtyDraftAction()) return;
    chapterLoadGate.invalidate();
    setChapterLoading(false);
    setShowSettings(true);
  };

  if (showSettings) return <SettingsPage onClose={() => setShowSettings(false)} />;
  if (loading) return <LoadingState label="正在加载书架" />;

  // 书架视图：空书架或点了「新建」都落到 FirstRun
  if (view === 'shelf') {
    if (shelfError && !creating) {
      return <div className="empty-hint big">
        <h1>书架加载失败</h1>
        <p>无法确认当前是否已有作品，请重试后再新建。</p>
        <button className="hbtn" onClick={() => { void loadShelf(); }}>重试</button>
      </div>;
    }
    if (shouldShowFirstRun({
      creating, books, shelfError,
      hasStorageIssues: !!storageDiagnostics?.issues.length,
      hasDeletedBooks: deletedBooks.length > 0,
      hasAuxiliaryLoadError: Boolean(diagnosticsLoadError || trashLoadError),
    })) {
      return <FirstRun premise={creationPremise} onPremiseChange={setCreationPremise}
        onCreated={async (b: Book) => {
        setCreating(false);
        setCreationPremise('');
        const reconciled = await reconcileAcknowledgedCreationOpen({
          expectedBookId: b.id,
          open: () => openBook(b.id, false),
          refresh: loadShelf,
        });
        if (reconciled === 'shelf_refreshed') {
          toast.error('作品已创建，但自动打开失败；已刷新书架，请从书架打开');
        } else if (reconciled === 'unavailable') {
          toast.error('作品已创建，但自动打开和书架刷新均失败；请重新加载书架确认，不要重复创建');
        }
      }}
        onCreateFailure={async (error, expectedBookId) => {
          const reconciled = await reconcileCreatedShelfMutationFailure({
            error,
            expectedBookId,
            refresh: loadShelf,
          });
          if (reconciled.status === 'created') {
            setCreating(false);
            setCreationPremise('');
            toast.info('创建结果未确认，但书架已检测到新作品；请先打开确认，不要重复创建');
          } else if (reconciled.status === 'not_created') {
            toast.error('创建结果未确认；刷新后未检测到新作品，可以重试：' + messageOf(error));
          } else if (reconciled.status === 'unknown') {
            toast.error('创建结果未确认且无法刷新书架；请重新打开书架确认后再重试');
          } else toast.error('创建失败：' + messageOf(error));
        }}
        onImportBackup={importBackup}
        onOpenSettings={openSettings}
        onCancel={creating ? () => { setCreationPremise(''); setCreating(false); } : undefined} />;
    }
    return <Bookshelf books={books} deletedBooks={deletedBooks} diagnostics={storageDiagnostics}
      diagnosticsLoadError={diagnosticsLoadError} trashLoadError={trashLoadError}
      busy={shelfMutating}
      onOpen={openBook}
      onNew={() => { chapterLoadGate.invalidate(); setCreating(true); }}
      onExport={exportBackup}
      onExportText={exportText}
      onImport={importBackup}
      onRefresh={async () => {
        await runExclusiveAction({
          isRunning: () => shelfMutatingRef.current,
          setRunning: setShelfMutationRunning,
          task: async () => { await loadShelf(); },
        });
      }}
      onDeepDiagnostics={async () => {
        await runExclusiveAction({
          isRunning: () => shelfMutatingRef.current,
          setRunning: setShelfMutationRunning,
          task: async () => {
            try {
              const diagnostics = await api.getStorageDiagnostics(true);
              setStorageDiagnostics(diagnostics);
              setDiagnosticsLoadError(null);
              if (diagnostics.ok) toast.success('✓ 深度检查完成，未发现异常');
              else if (diagnostics.truncated) {
                toast.error(`深度检查已在 ${diagnostics.issues.length} 处异常后提前停止，请查看详情`);
              } else toast.error(`深度检查发现 ${diagnostics.issues.length} 处异常，请查看详情`);
            } catch (e) {
              const message = messageOf(e);
              setDiagnosticsLoadError(message);
              toast.error('深度检查失败：' + message);
            }
          },
        });
      }}
      onOpenSettings={openSettings}
      onRename={async (id, title, expectedTitle) => {
        return (await runExclusiveAction({
          isRunning: () => shelfMutatingRef.current,
          setRunning: setShelfMutationRunning,
          task: () => {
            chapterLoadGate.invalidate();
            return runShelfMutation({
              action: () => api.renameBook(id, title, expectedTitle),
              refresh: loadShelf,
              onSuccess: () => toast.success('✓ 已改名'),
              onFailure: (e) => toast.error('改名失败：' + messageOf(e)),
              isConflictFailure: (e) => api.isApiErrorCode(e, 'BOOK_TITLE_CONFLICT')
                || api.isApiErrorCode(e, 'BOOK_NOT_FOUND'),
              onConflictFailure: () => toast.error('作品已被另一页面改名或移除；已刷新书架，本次旧页面改名未执行'),
              onConflictRefreshFailure: () => toast.error('作品已被另一页面改名或移除，但书架刷新失败；本次旧页面改名未执行'),
              onAmbiguousFailure: () => toast.error('改名结果未确认，已刷新书架显示实际标题；请确认后再操作'),
              onAmbiguousRefreshFailure: () => toast.error('改名结果未确认且无法刷新书架；请重新加载后确认'),
              onRefreshFailure: () => toast.error('改名已保存，但书架刷新失败；请重新加载页面确认'),
            });
          },
        })) ?? false;
      }}
      onDelete={async (id, expectedUpdatedAt) => {
        await runExclusiveAction({
          isRunning: () => shelfMutatingRef.current,
          setRunning: setShelfMutationRunning,
          task: () => {
            chapterLoadGate.invalidate();
            return runShelfMutation({
              action: () => api.deleteBook(id, expectedUpdatedAt),
              isConflictFailure: (e) => api.isApiErrorCode(e, 'BOOK_DELETE_CONFLICT')
                || api.isApiErrorCode(e, 'BOOK_NOT_FOUND')
                || api.isApiErrorCode(e, 'STRUCTURE_TRANSACTION_RECOVERED'),
              onConflictFailure: (e) => toast.error(
                api.isApiErrorCode(e, 'STRUCTURE_TRANSACTION_RECOVERED')
                  ? '检测到并完成了一笔此前中断的章节结构操作；已刷新书架，本次删除未执行，请确认后重试'
                  : '作品已被另一页面更新或移除；已刷新书架，本次旧书架删除未执行',
              ),
              onConflictRefreshFailure: (e) => toast.error(
                api.isApiErrorCode(e, 'STRUCTURE_TRANSACTION_RECOVERED')
                  ? '检测到并完成了一笔此前中断的章节结构操作，但书架刷新失败；本次删除未执行'
                  : '作品已被另一页面更新或移除且书架刷新失败；本次旧书架删除未执行',
              ),
              refresh: () => loadShelf({ requireTrash: true }),
              onSuccess: () => toast.success('✓ 已移入回收站，可随时恢复'),
              onFailure: (e) => toast.error('删除失败：' + messageOf(e)),
              onAmbiguousFailure: () => toast.error('删除结果未确认，已刷新书架和回收站；请按实际状态操作'),
              onAmbiguousRefreshFailure: () => toast.error('删除结果未确认且无法完整刷新书架和回收站；请重新加载后确认'),
              onRefreshFailure: () => toast.error('作品已移入回收站，但书架或回收站刷新失败；请重新加载页面确认'),
            });
          },
        });
      }}
      onRestore={async (trashId) => {
        await runExclusiveAction({
          isRunning: () => shelfMutatingRef.current,
          setRunning: setShelfMutationRunning,
          task: () => {
            chapterLoadGate.invalidate();
            return runShelfMutation({
              action: () => api.restoreDeletedBook(trashId),
              refresh: () => loadShelf({ requireTrash: true }),
              isConflictFailure: (e) => api.isApiErrorCode(e, 'BOOK_ALREADY_EXISTS')
                || api.isApiErrorCode(e, 'TRASH_BOOK_NOT_FOUND'),
              onConflictFailure: () => toast.error('回收站副本已被另一页面恢复或书架已有同 ID 作品；已刷新实际状态'),
              onConflictRefreshFailure: () => toast.error('回收站副本状态已变化，但书架刷新失败；请重新加载后再操作'),
              onSuccess: () => toast.success('✓ 已从回收站恢复'),
              onFailure: (e) => toast.error('恢复失败：' + messageOf(e)),
              onAmbiguousFailure: () => toast.error('恢复结果未确认，已刷新书架和回收站；请按实际状态操作'),
              onAmbiguousRefreshFailure: () => toast.error('恢复结果未确认且无法完整刷新书架和回收站；请重新加载后确认'),
              onRefreshFailure: () => toast.error('作品已恢复，但书架或回收站刷新失败；请重新加载页面确认'),
            });
          },
        });
      }} />;
  }

  if (!tree) return <LoadingState label="正在加载作品" lines={1} />;
  const bookId = tree.book.id;
  const activeChapter = selection.kind === 'chapter'
    && loadedChapter?.sectionId === selection.sectionId
    && loadedChapter.chapter.id === selection.chapterId
    ? loadedChapter.chapter
    : null;
  const existingNextChapter = nextChapterSelection(tree, selection);
  const activeChapterEmpty = activeChapter ? !currentText(activeChapter.body).trim() : false;

  const stopReview = (): Promise<void> => {
    if (reviewStoppingRef.current) {
      return reviewStopOperationRef.current ?? Promise.resolve();
    }
    setReviewStoppingRunning(true);
    const pending = reviewOperationRef.current;
    const stoppedSelection = selection;
    abortReview();
    const operation: Promise<void> = refreshStoppedReview({
      pending,
      selection: stoppedSelection,
      reload: (nextSelection) => reload(bookId, nextSelection),
    }).then((error) => {
      if (error) {
        toast.error('已停止审稿，但无法确认磁盘上的最终审稿结果；请返回书架确认后再操作');
      }
    }).finally(() => {
      setReviewStoppingRunning(false);
      if (reviewStopOperationRef.current === operation) reviewStopOperationRef.current = null;
    });
    reviewStopOperationRef.current = operation;
    return operation;
  };

  const versionedForPath = (path: string): Versioned => {
    let versioned: Versioned | undefined;
    if (path === 'outline') versioned = tree.book.outline;
    else if (path.startsWith('core:')) {
      const field = path.slice('core:'.length) as keyof typeof tree.book.settings.core;
      versioned = tree.book.settings.core[field];
    } else if (selection.kind === 'chapter'
      && path === `section:${selection.sectionId}:chapter:${selection.chapterId}`) {
      versioned = activeChapter?.body;
    }
    if (!versioned?.revision) {
      throw new api.ApiResponseError(
        '页面缺少有效的版本标识，请刷新后重试', 409, 'BAD_VERSION_REVISION',
      );
    }
    return versioned;
  };

  const handleVersionConflict = async (error: unknown, message: string) => {
    return reconcileVersionConflict({
      error,
      refresh: () => reload(bookId),
      onRefreshed: () => toast.error(`${message}；已刷新服务器状态，本地草稿仍保留`),
      onRefreshFailure: (refreshError) => toast.error(
        `${message}，且服务器状态刷新失败：${messageOf(refreshError)}；本地草稿仍保留`,
      ),
    });
  };

  // —— 统一版本操作 ——
  const doMove = async (path: string, delta: number) => {
    await runExclusiveAction({
      isRunning: () => versionMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setVersionMutationRunning,
      task: async () => {
        try {
          await api.versionMove(bookId, path, delta, versionedForPath(path).revision!);
        }
        catch (e) {
          if (await handleVersionConflict(e, '切换版本时检测到另一页面已更新内容，本次切换未执行')) return;
          const reconciled = await reconcilePersistedMutationFailure({
            error: e, refresh: () => reload(bookId),
          });
          if (reconciled === 'refreshed') {
            toast.error('切换版本结果未确认，已刷新实际版本位置；请确认后再操作');
          } else if (reconciled === 'unknown') {
            toast.error('切换版本结果未确认且刷新失败；请返回书架确认当前位置');
          } else toast.error('切换版本失败：' + messageOf(e));
          return;
        }
        const refreshError = await refreshPersistedChange(() => reload(bookId));
        if (refreshError) {
          toast.error('版本位置已切换，但页面刷新失败：' + messageOf(refreshError));
        }
      },
    });
  };
  const doClear = async (path: string) => {
    await runExclusiveAction({
      isRunning: () => versionMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setVersionMutationRunning,
      task: async () => {
        try { await api.versionClear(bookId, path, versionedForPath(path).revision!); }
        catch (e) {
          if (await handleVersionConflict(e, '清空时检测到另一页面已更新内容，本次清空未执行')) return;
          const reconciled = await reconcilePersistedMutationFailure({
            error: e, refresh: () => reload(bookId),
          });
          if (reconciled === 'refreshed') {
            toast.error('清空结果未确认，已刷新实际内容；请确认版本后再操作');
          } else if (reconciled === 'unknown') {
            toast.error('清空结果未确认且刷新失败；请返回书架确认');
          } else toast.error('清空失败：' + messageOf(e));
          return;
        }
        const refreshError = await refreshPersistedChange(() => reload(bookId));
        if (refreshError) toast.error('已清空，但页面刷新失败：' + messageOf(refreshError));
        else toast.info('已清空（可用「上一个」找回）');
      },
    });
  };
  const doSave = async (path: string, text: string) => {
    await runExclusiveAction({
      isRunning: () => versionMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setVersionMutationRunning,
      task: async () => {
        try { await api.versionSave(bookId, path, text, versionedForPath(path).revision!); }
        catch (e) {
          if (await handleVersionConflict(e, '保存时检测到另一页面已更新内容，本次保存未执行')) return;
          const reconciled = await reconcilePersistedMutationFailure({
            error: e, refresh: () => reload(bookId),
          });
          if (reconciled === 'refreshed') {
            toast.error('保存结果未确认，已刷新实际内容；请确认版本后再决定是否重试');
          } else if (reconciled === 'unknown') {
            toast.error('保存结果未确认且刷新失败；请返回书架确认后再重试');
          } else toast.error('保存失败：' + messageOf(e));
          return;
        }
        const refreshError = await refreshPersistedChange(() => reload(bookId));
        if (refreshError) toast.error('内容已保存，但页面刷新失败：' + messageOf(refreshError));
        else toast.success('✓ 已保存');
      },
    });
  };

  const doSaveDailyWordGoal = async (dailyWordGoal: number) => {
    const expectedRevision = tree.book.settings.serialization?.revision;
    if (!expectedRevision) {
      toast.error('页面缺少有效的连载设置版本，请刷新后重试');
      return;
    }
    await runExclusiveAction({
      isRunning: () => versionMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setVersionMutationRunning,
      task: async () => {
        try {
          await api.saveSerializationSettings(bookId, dailyWordGoal, expectedRevision);
        } catch (error) {
          if (api.isApiErrorCode(error, 'SERIALIZATION_CONFLICT')) {
            try {
              await reload(bookId, { kind: 'serialization' });
              toast.error('每日目标已被另一页面修改；已刷新实际设置，本次旧页面保存未覆盖新版');
            } catch {
              toast.error('每日目标已被另一页面修改，且页面刷新失败；本次旧设置未保存');
            }
            return;
          }
          const reconciled = await reconcilePersistedMutationFailure({
            error, refresh: () => reload(bookId, { kind: 'serialization' }),
          });
          if (reconciled === 'refreshed') {
            toast.error('每日目标保存结果未确认，已刷新磁盘实际设置');
          } else if (reconciled === 'unknown') {
            toast.error('每日目标保存结果未确认且刷新失败；请返回书架确认');
          } else toast.error('保存每日目标失败：' + messageOf(error));
          return;
        }
        const refreshError = await refreshPersistedChange(
          () => reload(bookId, { kind: 'serialization' }),
        );
        if (refreshError) toast.error('每日目标已保存，但页面刷新失败：' + messageOf(refreshError));
        else toast.success('✓ 每日字数目标已保存');
      },
    });
  };

  const doPlatformGovernanceMutation = async (
    action: (expectedRevision: string) => Promise<unknown>, successMessage: string,
  ): Promise<boolean> => {
    const expectedRevision = tree.book.settings.serialization?.revision;
    if (!expectedRevision) {
      toast.error('页面缺少有效的连载设置版本，请刷新后重试');
      return false;
    }
    let confirmed = false;
    await runExclusiveAction({
      isRunning: () => versionMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setVersionMutationRunning,
      task: async () => {
        try { await action(expectedRevision); }
        catch (error) {
          if (api.isApiErrorCode(error, 'SERIALIZATION_CONFLICT')) {
            try {
              await reload(bookId, { kind: 'serialization' });
              toast.error('平台核对记录已被另一页面修改；已刷新实际记录，本次旧页面操作未覆盖新版');
            } catch {
              toast.error('平台核对记录已变化且页面刷新失败；本次旧页面操作未覆盖新版');
            }
            return;
          }
          const reconciled = await reconcilePersistedMutationFailure({
            error, refresh: () => reload(bookId, { kind: 'serialization' }),
          });
          if (reconciled === 'refreshed') {
            toast.error('平台核对记录操作结果未确认，已刷新磁盘实际状态');
          } else if (reconciled === 'unknown') {
            toast.error('平台核对记录操作结果未确认且刷新失败；请返回书架确认');
          } else toast.error('平台核对记录操作失败：' + messageOf(error));
          return;
        }
        const refreshError = await refreshPersistedChange(
          () => reload(bookId, { kind: 'serialization' }),
        );
        if (refreshError) {
          toast.error('平台核对记录已保存，但页面刷新失败：' + messageOf(refreshError));
          return;
        }
        confirmed = true;
        toast.success(successMessage);
      },
    });
    return confirmed;
  };

  const doSavePlatformConfirmation = (input: PlatformConfirmationInput) =>
    doPlatformGovernanceMutation(
      (expectedRevision) => api.savePlatformConfirmation(bookId, input, expectedRevision),
      '✓ 人工核对记录已保存；发布时仍需确认官方信息未变化',
    );
  const doDeletePlatformConfirmation = (confirmationId: string) =>
    doPlatformGovernanceMutation(
      (expectedRevision) => api.deletePlatformConfirmation(
        bookId, confirmationId, expectedRevision,
      ),
      '✓ 平台核对记录已删除',
    );

  const doSaveChapterPlan = async (
    plan: ChapterPlanInput, expectedRevision: string,
  ): Promise<ChapterPlan> => {
    if (selection.kind !== 'chapter' || !activeChapter) {
      throw new Error('章节已经切换，请重新打开后保存策划卡');
    }
    const target = selection;
    return saveChapterPlanWithReconciliation({
      save: () => api.saveChapterPlan(
        bookId, target.sectionId, target.chapterId, plan, expectedRevision,
      ),
      refresh: () => reload(bookId, target),
      isConflict: (error) => api.isApiErrorCode(error, 'CHAPTER_PLAN_CONFLICT')
        || api.isApiErrorCode(error, 'CHAPTER_PLAN_QUALITY_DOWNGRADE')
        || api.isApiErrorCode(error, 'CHAPTER_PLAN_RHYTHM_DOWNGRADE'),
      onConflict: () => toast.error('策划卡已被另一页面修改；已刷新最新版本，本地草稿仍保留，请核对后重试'),
      onConflictRefreshFailure: () => toast.error('策划卡已被另一页面修改，且最新版本刷新失败；本地草稿仍保留'),
      onAmbiguous: () => toast.error('策划卡保存结果未确认，已刷新磁盘实际状态；本地草稿仍保留'),
      onAmbiguousRefreshFailure: () => toast.error('策划卡保存结果未确认且刷新失败；本地草稿仍保留，请返回书架确认'),
      onSaved: (saved) => setLoadedChapter((current) => current?.sectionId === target.sectionId
        && current.chapter.id === target.chapterId
        ? { ...current, chapter: { ...current.chapter, plan: saved,
          review: undefined, reviewContextRevision: undefined } }
        : current),
      onRefreshFailure: () => toast.error('策划卡已保存，但章节上下文刷新失败；请重新打开本章后再生成或审稿'),
      onSuccess: () => toast.success('✓ 章节策划卡已保存，生成与审稿将使用新意图'),
    });
  };

  const doPublishChapter = async () => {
    if (selection.kind !== 'chapter' || !activeChapter) return;
    if (blockDirtyDraftAction()) return;
    if (!activeChapter.memoryRevision) {
      toast.error('页面缺少长期记忆版本标识，请刷新后重试');
      return;
    }
    const target = selection;
    await runExclusiveAction({
      isRunning: () => versionMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setVersionMutationRunning,
      task: async () => {
        try {
          await api.publishChapter(
            bookId, target.sectionId, target.chapterId,
            activeChapter.bodyFingerprint, activeChapter.memoryRevision!,
          );
        } catch (error) {
          const conflict = api.isApiErrorCode(error, 'PUBLICATION_STALE')
            || api.isApiErrorCode(error, 'MEMORY_REVISION_CONFLICT');
          if (conflict) {
            try {
              await reload(bookId, target);
              toast.error('正文或长期记忆已被另一页更新；已刷新实际发布锁状态，本次旧页面操作未覆盖新版');
            } catch {
              toast.error('正文或长期记忆已变化，且页面刷新失败；本次旧页面操作未执行');
            }
            return;
          }
          const reconciled = await reconcilePersistedMutationFailure({
            error, refresh: () => reload(bookId, target),
          });
          if (reconciled === 'refreshed') {
            toast.error('发布锁结果未确认，已刷新磁盘实际状态；请确认后再操作');
          } else if (reconciled === 'unknown') {
            toast.error('发布锁结果未确认且刷新失败；请返回书架确认，不要立即重复点击');
          } else toast.error('锁定发布版失败：' + messageOf(error));
          return;
        }
        const refreshError = await refreshPersistedChange(() => reload(bookId, target));
        if (refreshError) {
          toast.error('已锁定发布版，但页面刷新失败：' + messageOf(refreshError));
        } else toast.success('✓ 已锁定读者实际看到的正文版本');
      },
    });
  };

  const doRecomputeMemory = async () => {
    if (selection.kind !== 'chapter' || !activeChapter) return;
    if (blockDirtyDraftAction()) return;
    const target = selection;
    const expectedBodyFingerprint = activeChapter.bodyFingerprint;
    await runExclusiveAction({
      isRunning: () => versionMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setMemoryRecomputeRunning,
      task: async () => {
        try {
          await api.recomputeChapterMemory(
            bookId, target.sectionId, target.chapterId, expectedBodyFingerprint,
          );
        } catch (error) {
          if (api.isApiErrorCode(error, 'MEMORY_SOURCE_STALE')) {
            try {
              await reload(bookId, target);
              toast.error('正文已被另一页更新；旧正文的记忆重算结果未保存，已刷新当前章节');
            } catch {
              toast.error('正文已变化且页面刷新失败；旧记忆重算结果未保存');
            }
            return;
          }
          const reconciled = await reconcilePersistedMutationFailure({
            error, refresh: () => reload(bookId, target),
          });
          if (reconciled === 'refreshed') {
            toast.error('记忆重算结果未确认，已刷新磁盘实际状态；请检查候选后再操作');
          } else if (reconciled === 'unknown') {
            toast.error('记忆重算结果未确认且刷新失败；请返回书架确认');
          } else toast.error('记忆重算失败：' + messageOf(error));
          return;
        }
        const refreshError = await refreshPersistedChange(() => reload(bookId, target));
        if (refreshError) {
          toast.error('记忆候选已重新提取，但页面刷新失败：' + messageOf(refreshError));
        } else toast.success('✓ 已按当前正文重新提取；候选仍需人工确认');
      },
    });
  };

  // 状态文案：按 path 前缀区分
  const stageFor = (path: string) =>
    path === 'outline' ? '✍️ 正在重写全书大纲…' : path.startsWith('core:') ? '✍️ 正在重写设定…' : '✍️ 正在重写本章…';

  const handleGenerationError = async (token: number, message: string) => {
    if (!ownsStreaming(token)) return;
    setStreamStoppingRunning(true);
    if (!finishStreaming(token)) {
      setStreamStoppingRunning(false);
      return;
    }
    setStatusText('⏳ 生成中断，正在核对磁盘状态…');
    const savedSelection = savedSelectionRef.current;
    const operation: Promise<void> = reconcileGenerationFailure({
      message,
      savedSelection,
      fallbackSelection: selection,
      reload: (nextSelection) => reload(bookId, nextSelection),
      // 连接可能恰好在服务端提交后、saved 帧到达前中断。即使已经刷新，
      // 也不能把“未收到保存确认”武断描述成未落盘并诱导用户立即重试；
      // 下一章模式下那会再追加一章。让用户以刷新后的正文和侧栏为准。
      onUnsavedFailure: (failure) => toast.error(
        `生成未完成或保存结果未确认，已刷新磁盘实际状态：${failure}；请检查当前内容后再决定是否重试`,
      ),
      onUnsavedRefreshFailure: (failure, error) => toast.error(
        `生成失败且无法确认是否已保存：${failure}；刷新失败：${messageOf(error)}。请返回书架确认后再重试`,
      ),
      onSavedFailure: (failure) => toast.error('内容已保存，但后续处理或连接中断：' + failure),
      onSavedRefreshFailure: (failure, error) => toast.error(
        `内容已保存，但页面刷新失败：${messageOf(error)}；后续流程错误：${failure}`,
      ),
    }).then(() => undefined).finally(() => {
      setStreamStoppingRunning(false);
      if (streamStopOperationRef.current === operation) streamStopOperationRef.current = null;
    });
    streamStopOperationRef.current = operation;
    await operation;
  };

  // 重写分派：章节走 gen/chapter（mode=rewrite）；outline/core 走 version/rewrite
  const doRewrite = (path: string) => {
    if (blockDirtyDraftAction()) return;
    const isChapter = path.startsWith('section:');
    const generatingEmptyChapter = isChapter && !currentText(versionedForPath(path)).trim();
    startStreaming((token) => {
      setStreamingText('');
      setStatusText(generatingEmptyChapter ? '✍️ 正在生成本章…' : stageFor(path));
      if (isChapter) {
        setStreamingPath('chapter');
        const [, sectionId, , chapterId] = path.split(':');
        streamHandleRef.current = api.streamGen('/api/gen/chapter', {
          bookId,
          sectionId,
          chapterId,
          mode: 'rewrite',
          expectedRevision: versionedForPath(path).revision,
          // 策划留白不再阻断生成：服务端会把作者未决的判断作为上下文交给模型。
          // 策划卡上的写前门槛继续显示，由作者决定是否先补齐。
        }, {
          onDelta: (d) => { if (ownsStreaming(token)) setStreamingText((t) => t + d); },
          onSaved: () => {
            if (!ownsStreaming(token)) return;
            savedSelectionRef.current = selection;
            setStatusText('🧾 正文已保存，正在整理摘要与审稿…');
          },
          onError: (m) => handleGenerationError(token, m),
          onDone: async (e) => {
            const warning = chapterPostprocessWarningMessage(e.postprocessWarnings);
            const completion = await refreshOwnedGeneration({
              owns: () => ownsStreaming(token),
              refresh: () => reload(bookId, selection),
            });
            if (!completion.owned || !finishStreaming(token)) return;
            if (completion.refreshError) {
              toast.error('内容已保存，但页面刷新失败：' + messageOf(completion.refreshError)
                + (warning ? `；服务端另报告：${warning}` : ''));
            } else if (warning) toast.error(warning);
            else toast.success(generatingEmptyChapter ? '✓ 本章已生成' : '✓ 已重写');
          },
        });
      } else {
        setStreamingPath(path);
        streamHandleRef.current = api.streamGen(api.rewriteUrl(bookId), {
          path,
          expectedRevision: versionedForPath(path).revision,
        }, {
          onDelta: (d) => { if (ownsStreaming(token)) setStreamingText((t) => t + d); },
          onSaved: () => {
            if (!ownsStreaming(token)) return;
            savedSelectionRef.current = selection;
            setStatusText('🧾 内容已保存，正在整理…');
          },
          onError: (m) => handleGenerationError(token, m),
          onDone: async (e) => {
            const warning = path === 'outline'
              ? outlinePostprocessWarningMessage(e.postprocessWarnings)
              : null;
            const completion = await refreshOwnedGeneration({
              owns: () => ownsStreaming(token),
              refresh: () => reload(bookId, selection),
            });
            if (!completion.owned || !finishStreaming(token)) return;
            if (completion.refreshError) {
              toast.error('内容已保存，但页面刷新失败：' + messageOf(completion.refreshError)
                + (warning ? `；服务端另报告：${warning}` : ''));
            } else if (warning) toast.error(warning);
            else toast.success('✓ 已重写');
          },
        });
      }
    });
  };

  // 下一章先走策划门槛；这里仅处理已有正文的定向抽打。
  const runChapterWhip = (whip: string) => {
    const submittedWhipDraft = isSubmittedWhipDraft(whipDraftRef.current, whip);
    if (blockDirtyDraftAction({ allowWhipDraft: submittedWhipDraft })) return false;
    if (selection.kind !== 'chapter' || !activeChapter) return false;
    const { sectionId, chapterId } = selection;
    return startStreaming((token) => {
      setStreamingText(''); setStreamingPath('chapter');
      setStatusText('🗯️ 正在按你的要求重写…');
      streamHandleRef.current = api.streamGen('/api/gen/chapter', {
        bookId, sectionId, chapterId, mode: 'whip', whip,
        expectedRevision: activeChapter.body.revision,
      }, {
        onDelta: (d) => { if (ownsStreaming(token)) setStreamingText((t) => t + d); },
        onSaved: (e) => {
          if (!ownsStreaming(token)) return;
          savedSelectionRef.current = { kind: 'chapter', sectionId, chapterId: e.chapterId ?? chapterId! };
          if (submittedWhipDraft && isSubmittedWhipDraft(whipDraftRef.current, whip)) {
            updateWhipDraft('');
          }
          setStatusText('🧾 正文已保存，正在整理摘要与审稿…');
        },
        onError: (m) => handleGenerationError(token, m),
        onDone: async (e) => {
          const warning = chapterPostprocessWarningMessage(e.postprocessWarnings);
          const nextSelection = { kind: 'chapter', sectionId, chapterId: e.chapterId ?? chapterId! } as const;
          const completion = await refreshOwnedGeneration({
            owns: () => ownsStreaming(token),
            refresh: () => reload(bookId, nextSelection),
          });
          if (!completion.owned || !finishStreaming(token)) return;
          if (completion.refreshError) {
            toast.error('本章已保存，但页面刷新失败：' + messageOf(completion.refreshError)
              + (warning ? `；服务端另报告：${warning}` : ''));
          } else if (warning) toast.error(warning);
          else toast.success('✓ 本章完成');
        },
      });
    });
  };

  const runReviewRequest = async (
    kind: 'chapter' | 'golden-three', request: (signal: AbortSignal) => Promise<unknown>,
  ) => {
    if (blockDirtyDraftAction()) return;
    const reviewedSelection = selection;
    const operation = runExclusiveAction({
      isRunning: () => reviewingRef.current || isGenerationBusy() || versionMutatingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: (running) => {
        if (running) reviewKindRef.current = kind;
        setReviewRequestRunning(running);
      },
      task: async () => {
        const result = await runPersistedReviewRequest({
          begin: () => reviewRequestGate.begin(), owns: (token) => reviewRequestGate.owns(token),
          request, refresh: () => reload(bookId, reviewedSelection),
        });
        if (result.status === 'refreshed') toast.error('审稿结果未确认，已刷新实际审稿结果；请确认后再决定是否重试');
        else if (result.status === 'unknown') toast.error('审稿结果未确认且刷新失败；请返回书架确认');
        else if (result.status === 'failed') toast.error('审稿失败：' + messageOf(result.error));
        else if (result.status === 'saved-refresh-failed') toast.error('审稿已保存，但页面刷新失败：' + messageOf(result.error));
        else if (result.status === 'saved') toast.success('✓ 审稿完成');
      },
    });
    reviewOperationRef.current = operation;
    try { await operation; }
    finally {
      if (reviewOperationRef.current === operation) reviewOperationRef.current = null;
    }
  };
  // —— 单章 / 黄金三章审稿共享同一个可停止互斥通道 ——
  const doReview = async () => {
    if (selection.kind !== 'chapter' || !activeChapter?.bodyFingerprint
      || !activeChapter.reviewContextRevision) {
      toast.error('页面缺少有效的审稿版本标识，请刷新章节后重试');
      return;
    }
    const { sectionId, chapterId } = selection;
    await runReviewRequest('chapter', (signal) => api.reviewChapter(
      bookId, sectionId, chapterId, activeChapter.bodyFingerprint,
      activeChapter.reviewContextRevision!, signal,
    ));
  };
  const doGoldenThreeReview = async () => {
    const state = activeChapter?.goldenThreeReviewState;
    if (!state?.ready || !state.contextRevision) {
      toast.error('前三章正文尚未齐备，或页面缺少联合审稿版本；请刷新第三章后重试');
      return;
    }
    await runReviewRequest('golden-three', (signal) =>
      api.reviewGoldenThree(bookId, state.contextRevision!, signal));
  };
  const onUseSuggestion = (instruction: string) => {
    runChapterWhip(instruction);
  };

  // AI 规划分部
  const runSections = () => {
    if (blockDirtyDraftAction()) return;
    const expectedContextRevision = tree.book.sectionPlanContextRevision;
    if (!expectedContextRevision) {
      toast.error('页面缺少有效的分部规划上下文标识，请刷新作品后重试');
      return;
    }
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    sectionPlanReturnFocusRef.current = nextSectionPlanReturnFocus({
      current: sectionPlanReturnFocusRef.current,
      active: activeElement,
      activeInsideDialog: Boolean(activeElement?.closest('[role="dialog"]')),
    });
    startStreaming((token) => {
      setPlanOpen(true); setPlanText(''); setPlanTitles([]); setPlanSections([]); setPlanParseError(false); setStatusText('🧩 正在规划分部…');
      streamHandleRef.current = api.streamGen('/api/gen/sections', {
        bookId, expectedContextRevision,
      }, {
        onDelta: (d) => { if (ownsStreaming(token)) setPlanText((t) => t + d); },
        onError: (m) => { if (finishStreaming(token)) toast.error('规划失败：' + m); },
        onDone: (e) => {
          if (!finishStreaming(token)) return;
          if (e.sections) setPlanText(e.sections);
          if (e.parsedTitles) setPlanTitles(e.parsedTitles);
          if (e.parsedSections) setPlanSections(e.parsedSections);
          if (e.parseError) {
            setPlanParseError(true);
            toast.error('AI 输出格式不符合，无法解析分部标题，请重新生成');
          }
        },
      });
    });
  };
  const adoptSections = async (titles: string[]) => {
    if (blockDirtyDraftAction()) return;
    await runExclusiveAction({
      isRunning: () => planAdoptingRef.current || isGenerationBusy() || reviewingRef.current
        || versionMutatingRef.current || structureMutatingRef.current,
      setRunning: (running) => { planAdoptingRef.current = running; setPlanAdopting(running); },
      task: () => {
        let expectedLastSectionId = lastSectionIdForBook(tree);
        let planIndex = 0;
        return adoptSectionTitles({
          titles,
          addSection: async (title) => {
            const plan = planSections[planIndex];
            planIndex += 1;
            const created = await api.addSection(
              bookId, title, 'ai', expectedLastSectionId,
              plan?.title === title ? sectionPlanOutline(plan) : undefined,
            );
            expectedLastSectionId = created.id;
            return created;
          },
          reload: () => reload(bookId),
          onSuccess: (created) => toast.success(`✓ 已创建 ${created} 个部`),
          onPartialFailure: (created, total, e) => toast.error(`采纳分部部分成功：已创建 ${created}/${total} 个，后续失败：${messageOf(e)}`),
          isAmbiguousFailure: api.isAmbiguousApiFailure,
          isRecoveredFailure: (e) => api.isApiErrorCode(e, 'STRUCTURE_TRANSACTION_RECOVERED'),
          isConflictFailure: (e) => api.isApiErrorCode(e, 'NEXT_SECTION_CONFLICT'),
          onAmbiguousFailure: () => toast.error('采纳分部结果未确认，已刷新侧栏；可能已有额外分部落盘，请检查后再决定是否重新规划'),
          onAmbiguousRefreshFailure: () => toast.error('采纳分部结果未确认且刷新失败，无法确认实际创建数量；请返回书架确认后再重试'),
          onRecoveredFailure: () => toast.error('已完成此前中断的分部事务并刷新侧栏；本次采纳已停止，请检查实际分部后再操作'),
          onRecoveredRefreshFailure: () => toast.error('已完成此前中断的分部事务，但侧栏刷新失败；本次采纳已停止，请返回书架确认'),
          onConflictFailure: () => toast.error('另一页面已新增分部；已刷新侧栏并停止本次采纳，请检查后再操作'),
          onConflictRefreshFailure: () => toast.error('另一页面已新增分部且侧栏刷新失败；本次采纳已停止，请返回书架确认'),
          onRefreshFailure: (created, total, e) => toast.error(`采纳分部已创建 ${created}/${total} 个，但刷新失败：${messageOf(e)}`),
          onFailure: (e) => toast.error('采纳分部失败：' + messageOf(e)),
          onFinish: () => setPlanOpen(false),
        });
      },
    });
  };
  const stopGen = (): Promise<void> => {
    if (streamStoppingRef.current) {
      return streamStopOperationRef.current ?? Promise.resolve();
    }
    const savedSelection = savedSelectionRef.current;
    const pending = streamHandleRef.current?.settled ?? null;
    const stoppedSelection = selection;
    setStreamStoppingRunning(true);
    // 使正在排队的旧 onDone/onError 回调失去所有权，避免停止后又弹成功提示。
    streamingTokenRef.current += 1;
    streamHandleRef.current?.abort();
    finishStreaming();
    setStatusText('⏳ 正在停止并核对磁盘状态…');
    // 使已经进入 onDone 刷新、但尚未返回的旧章节请求失效。
    chapterLoadGate.invalidate();
    const operation: Promise<void> = refreshStoppedGeneration({
      pending,
      savedSelection,
      fallbackSelection: stoppedSelection,
      reload: (nextSelection) => reload(bookId, nextSelection),
    }).then((error) => {
      if (error) toast.error('已停止，但无法确认磁盘上的最终内容；请返回书架确认后再操作');
    }).finally(() => {
      setStreamStoppingRunning(false);
      if (streamStopOperationRef.current === operation) streamStopOperationRef.current = null;
    });
    streamStopOperationRef.current = operation;
    return operation;
  };

  const addPlanningChapter = async (sid: string) => {
    if (blockDirtyDraftAction()) return;
    await runExclusiveAction({
      isRunning: () => structureMutatingRef.current || isGenerationBusy() || reviewingRef.current
        || versionMutatingRef.current || planAdoptingRef.current,
      setRunning: setStructureMutationRunning,
      task: async () => {
        const result = await runPersistedCreation({
          create: () => api.addChapter(
            bookId, sid, undefined, lastChapterIdForSection(tree, sid),
          ),
          refreshAfterFailure: () => reload(bookId),
          refreshAfterSuccess: (chapter) => reload(bookId, {
            kind: 'chapter', sectionId: sid, chapterId: chapter.id,
          }),
        });
        if (result.status === 'failed') {
          const { error, reconciliation } = result;
          if (reconciliation === 'conflict') {
            toast.error('另一页面已经新增章节；已刷新侧栏，本次新建未执行');
          } else if (reconciliation === 'conflict_refresh_failed') {
            toast.error('另一页面已经新增章节，但侧栏刷新失败；本次新建未执行，请返回书架确认');
          } else if (reconciliation === 'recovered') {
            toast.error('已完成此前中断的章节事务并刷新侧栏；本次新建未执行，请检查后再操作');
          } else if (reconciliation === 'recovered_refresh_failed') {
            toast.error('已完成此前中断的章节事务，但侧栏刷新失败；本次新建未执行，请返回书架确认');
          } else if (reconciliation === 'refreshed') {
            toast.error('新建章结果未确认，已刷新本地数据；请先检查侧栏，再决定是否重试');
          } else if (reconciliation === 'unknown') {
            toast.error('新建章结果未确认且刷新失败；请返回书架确认后再重试');
          } else toast.error('新建章失败：' + messageOf(error));
          return;
        }
        if (result.refreshError) {
          toast.error('章节已创建，但页面刷新失败：' + messageOf(result.refreshError));
        } else toast.success('✓ 已建立下一章；先完成策划门槛，再生成正文');
      },
    });
  };

  return (
    <div className="app">
      <TopBar title={tree.book.title} streaming={generationBusy}
        busy={generationBusy || reviewing || versionMutating || structureMutating || planAdopting || chapterLoading || hasAnyLocalDraft}
        cancellable={streaming || reviewing}
        statusText={statusText}
        onOpenSettings={openSettings} onHome={goShelf} />
      <div className="body">
        <Sidebar tree={tree} selection={selection}
          disabled={hasAnyLocalDraft || shouldDisableSidebar({ streaming: generationBusy, structureMutating, reviewing, versionMutating, planAdopting })}
          onSelect={selectWorkspace}
          onAddSection={async () => {
            if (blockDirtyDraftAction()) return;
            await runExclusiveAction({
              isRunning: () => structureMutatingRef.current || isGenerationBusy() || reviewingRef.current
                || versionMutatingRef.current || planAdoptingRef.current,
              setRunning: setStructureMutationRunning,
              task: async () => {
                const result = await runPersistedCreation({
                  create: () => api.addSection(
                    bookId, undefined, undefined, lastSectionIdForBook(tree),
                  ),
                  refreshAfterFailure: () => reload(bookId),
                  refreshAfterSuccess: () => reload(bookId),
                });
                if (result.status === 'failed') {
                  const { error, reconciliation } = result;
                  if (reconciliation === 'conflict') {
                    toast.error('另一页面已经新增分部；已刷新侧栏，本次新建未执行');
                  } else if (reconciliation === 'conflict_refresh_failed') {
                    toast.error('另一页面已经新增分部，但侧栏刷新失败；本次新建未执行，请返回书架确认');
                  } else if (reconciliation === 'recovered') {
                    toast.error('已完成此前中断的分部事务并刷新侧栏；本次新建未执行，请检查后再操作');
                  } else if (reconciliation === 'recovered_refresh_failed') {
                    toast.error('已完成此前中断的分部事务，但侧栏刷新失败；本次新建未执行，请返回书架确认');
                  } else if (reconciliation === 'refreshed') {
                    toast.error('新建部结果未确认，已刷新本地数据；请先检查侧栏，再决定是否重试');
                  } else if (reconciliation === 'unknown') {
                    toast.error('新建部结果未确认且刷新失败；请返回书架确认后再重试');
                  } else toast.error('新建部失败：' + messageOf(error));
                  return;
                }
                if (result.refreshError) {
                  toast.error('分部已创建，但侧栏刷新失败：' + messageOf(result.refreshError));
                }
              },
            });
          }}
          onAddChapter={addPlanningChapter}
          onPlanSections={runSections} />
        <div className="content">
          <MainPanel tree={tree} selection={selection} chapter={activeChapter} chapterLoading={chapterLoading}
            streaming={streaming}
            versionBusy={whipDraftDirty || shouldDisableVersionedBox({ streaming: generationBusy, versionMutating, reviewing, structureMutating, planAdopting })}
            streamingText={streamingText} streamingPath={streamingPath}
            onMove={doMove} onRewrite={doRewrite} onClear={doClear} onSave={doSave} onStop={stopGen}
            onDraftDirtyChange={updateDraftDirty}
            onSaveChapterPlan={doSaveChapterPlan}
            onRefreshBook={() => reload(bookId, selection)}
            reviewing={reviewing} reviewKind={reviewKindRef.current} reviewDisabled={hasAnyLocalDraft || generationBusy || versionMutating || structureMutating || planAdopting || chapterLoading || !activeChapter}
            onReview={doReview} onGoldenThreeReview={doGoldenThreeReview} onStopReview={stopReview} onUseSuggestion={onUseSuggestion}
            publishing={versionMutating && !memoryRecomputing} onPublishChapter={doPublishChapter}
            memoryRecomputing={memoryRecomputing} onRecomputeMemory={doRecomputeMemory}
            onSaveDailyWordGoal={doSaveDailyWordGoal}
            onSavePlatformConfirmation={doSavePlatformConfirmation}
            onDeletePlatformConfirmation={doDeletePlatformConfirmation}
            onOpenMemorySource={(sectionId, chapterId) => selectWorkspace({
              kind: 'chapter', sectionId, chapterId,
            })} />
          {/* 流式期间由 VersionedBox 工具条负责 Stop，Actions 隐藏避免双 Stop 按钮 */}
          {selection.kind === 'chapter' && !streaming &&
            <Actions streaming={streaming} disabled={hasDirtyDraft || streamStopping || reviewing || versionMutating || structureMutating || planAdopting || chapterLoading || !activeChapter}
              hasExistingNextChapter={Boolean(existingNextChapter)}
              chapterEmpty={activeChapterEmpty}
              whip={whipDraft} onWhipChange={updateWhipDraft}
              onNext={() => existingNextChapter
                ? selectWorkspace(existingNextChapter)
                : void addPlanningChapter(selection.sectionId)}
              onWhip={runChapterWhip} onStop={stopGen} />}
        </div>
      </div>
      {planOpen && <SectionPlanPanel text={planText} titles={planTitles} plans={planSections} streaming={generationBusy} adopting={planAdopting} parseError={planParseError}
        returnFocus={sectionPlanReturnFocusRef.current}
        onAdopt={adoptSections} onRetry={() => { setPlanOpen(false); runSections(); }} onClose={() => { if (streamingRef.current) void stopGen(); setPlanOpen(false); }} />}
    </div>
  );
}
