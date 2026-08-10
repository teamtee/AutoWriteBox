import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Book, BookTree, BookSummary, Chapter, DeletedBook, SectionPlan,
  PlatformConfirmationInput, StorageDiagnostics, Versioned,
} from './types';
import type { Selection } from './store';
import { firstSelectable, selectionExists } from './store';
import * as api from './api';
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
type WorkspaceSnapshot = {
  tree: BookTree;
  selection: Selection;
  loadedChapter: LoadedChapter | null;
};
export { runExclusiveAction as runExclusiveSectionAdoption } from './asyncAction';
export { runExclusiveAction as runExclusiveStructureMutation } from './asyncAction';
export { runExclusiveAction as runExclusiveVersionMutation } from './asyncAction';

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function loadShelfBooks(
  listBooks: (signal?: AbortSignal) => Promise<BookSummary[]>,
  setBooks: (books: BookSummary[]) => void,
  setShelfError: (message: string | null) => void,
  onError?: (message: string) => void,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) {
  try {
    const list = await listBooks(signal);
    if (!isCurrent()) return null;
    setBooks(list);
    setShelfError(null);
    return list;
  } catch (e) {
    if (!isCurrent()) return null;
    const message = messageOf(e);
    setShelfError(message);
    onError?.(message);
    return null;
  }
}

export function applyShelfSupplementalLoadResult<T>(
  result: PromiseSettledResult<T>,
  setValue: (value: T) => void,
  setError: (message: string | null) => void,
): string | null {
  if (result.status === 'fulfilled') {
    setValue(result.value);
    setError(null);
    return null;
  }
  // 辅助列表失败时保留上一次成功结果，避免回收站副本或
  // 数据异常告警在短暂网络/读盘故障时从界面消失。
  const message = messageOf(result.reason);
  setError(message);
  return message;
}

export function verifiedShelfRefresh(
  books: BookSummary[] | null,
  { requireTrash = false, trashError = null }: {
    requireTrash?: boolean;
    trashError?: string | null;
  } = {},
): BookSummary[] | null {
  if (!books || (requireTrash && trashError)) return null;
  return books;
}

export async function loadBookWorkspace({
  bookId,
  requestedSelection,
  getTree,
  getChapter,
  signal,
  isCurrent = () => true,
  setChapterLoading,
}: {
  bookId: string;
  requestedSelection?: Selection;
  getTree: (bookId: string, signal?: AbortSignal) => Promise<BookTree>;
  getChapter: (
    bookId: string,
    sectionId: string,
    chapterId: string,
    signal?: AbortSignal,
  ) => Promise<Chapter>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  setChapterLoading?: (loading: boolean) => void;
}): Promise<WorkspaceSnapshot | null> {
  try {
    const tree = await getTree(bookId, signal);
    // 树请求期间可能已切换作品或章节；旧请求不得再改变 loading，
    // 也不应继续请求已经失去所有权的章节正文。
    if (!isCurrent()) return null;
    const selection = requestedSelection && selectionExists(tree, requestedSelection)
      ? requestedSelection
      : firstSelectable(tree);
    setChapterLoading?.(selection.kind === 'chapter');
    const loadedChapter = selection.kind === 'chapter'
      ? {
        sectionId: selection.sectionId,
        chapter: await getChapter(bookId, selection.sectionId, selection.chapterId, signal),
      }
      : null;
    if (!isCurrent()) return null;
    setChapterLoading?.(false);
    return { tree, selection, loadedChapter };
  } catch (error) {
    if (!isCurrent()) return null;
    setChapterLoading?.(false);
    throw error;
  }
}

export function shouldShowFirstRun({
  creating, books, shelfError, hasStorageIssues = false, hasDeletedBooks = false,
  hasAuxiliaryLoadError = false,
}: {
  creating: boolean;
  books: BookSummary[];
  shelfError: string | null;
  hasStorageIssues?: boolean;
  hasDeletedBooks?: boolean;
  hasAuxiliaryLoadError?: boolean;
}) {
  return creating || (!shelfError && books.length === 0 && !hasStorageIssues
    && !hasDeletedBooks && !hasAuxiliaryLoadError);
}

export function shouldDisableSidebar({ streaming, structureMutating, reviewing = false, versionMutating = false, planAdopting = false }: {
  streaming: boolean;
  structureMutating: boolean;
  reviewing?: boolean;
  versionMutating?: boolean;
  planAdopting?: boolean;
}) {
  return streaming || structureMutating || reviewing || versionMutating || planAdopting;
}

export function shouldDisableVersionedBox({ streaming, versionMutating, reviewing = false, structureMutating = false, planAdopting = false }: {
  streaming: boolean;
  versionMutating: boolean;
  reviewing?: boolean;
  structureMutating?: boolean;
  planAdopting?: boolean;
}) {
  return streaming || versionMutating || reviewing || structureMutating || planAdopting;
}

export function lastChapterIdForSection(tree: BookTree, sectionId: string): string | null {
  const chapters = tree.sections.find((section) => section.id === sectionId)?.chapters;
  return chapters?.length ? chapters[chapters.length - 1].id : null;
}

export function nextChapterSelection(tree: BookTree, selection: Selection): Selection | null {
  if (selection.kind !== 'chapter') return null;
  const sectionIndex = tree.sections.findIndex((section) => section.id === selection.sectionId);
  if (sectionIndex < 0) return null;
  const chapterIndex = tree.sections[sectionIndex].chapters
    .findIndex((chapter) => chapter.id === selection.chapterId);
  if (chapterIndex < 0) return null;

  const nextInSection = tree.sections[sectionIndex].chapters[chapterIndex + 1];
  if (nextInSection) {
    return { kind: 'chapter', sectionId: selection.sectionId, chapterId: nextInSection.id };
  }
  for (const section of tree.sections.slice(sectionIndex + 1)) {
    const firstChapter = section.chapters[0];
    if (firstChapter) {
      return { kind: 'chapter', sectionId: section.id, chapterId: firstChapter.id };
    }
  }
  return null;
}

export function lastSectionIdForBook(tree: BookTree): string | null {
  return tree.sections.length ? tree.sections[tree.sections.length - 1].id : null;
}

export function updateDirtyDraftPaths(
  paths: Set<string>, path: string, dirty: boolean,
): boolean {
  if (dirty) paths.add(path);
  else paths.delete(path);
  return paths.size > 0;
}

export function shouldWarnBeforeUnloadForApp({
  creationPremiseDraft, whipDraft, sectionPlanDraft,
  streaming, reviewing, versionMutating, structureMutating, planAdopting, shelfMutating,
}: {
  creationPremiseDraft: boolean;
  whipDraft: boolean;
  sectionPlanDraft: boolean;
  streaming: boolean;
  reviewing: boolean;
  versionMutating: boolean;
  structureMutating: boolean;
  planAdopting: boolean;
  shelfMutating: boolean;
}): boolean {
  return creationPremiseDraft || whipDraft || sectionPlanDraft
    || streaming || reviewing || versionMutating || structureMutating
    || planAdopting || shelfMutating;
}

export function localDraftBlockReason({
  hasEditorDraft, hasWhipDraft, allowWhipDraft = false,
}: {
  hasEditorDraft: boolean;
  hasWhipDraft: boolean;
  allowWhipDraft?: boolean;
}): 'editor' | 'whip' | null {
  if (hasEditorDraft) return 'editor';
  if (hasWhipDraft && !allowWhipDraft) return 'whip';
  return null;
}

export function ownsActiveGeneration({
  running, token, currentToken,
}: {
  running: boolean;
  token: number;
  currentToken: number;
}) {
  return running && token === currentToken;
}

export function chapterPostprocessWarningMessage(
  warnings: api.PostprocessWarning[] | undefined,
): string | null {
  const digestFailed = warnings?.includes('digest');
  const reviewFailed = warnings?.includes('review');
  if (digestFailed && reviewFailed) {
    return '正文已保存，但摘要/剧情路标/人物提取和自动审稿均未完成；继续生成下一章时可用前情会较少，请先检查模型 JSON 兼容性，审稿可通过页面按钮手动重试';
  }
  if (digestFailed) {
    return '正文已保存，但摘要/剧情路标/人物提取未完成；继续生成下一章时可用前情会较少，请检查模型 JSON 兼容性';
  }
  if (reviewFailed) return '正文已保存，但自动审稿未完成；可通过页面审稿按钮手动重试';
  return null;
}

export function outlinePostprocessWarningMessage(
  warnings: api.PostprocessWarning[] | undefined,
): string | null {
  if (!warnings?.includes('title')) return null;
  return '大纲已保存，但自动书名未生成；当前默认名称保持不变，可返回书架手动改名';
}

export function nextSectionPlanReturnFocus<T>({
  current, active, activeInsideDialog,
}: {
  current: T | null;
  active: T | null;
  activeInsideDialog: boolean;
}): T | null {
  return active && !activeInsideDialog ? active : current;
}

export async function runShelfMutation({
  action,
  refresh,
  onSuccess,
  onFailure,
  isConflictFailure,
  onConflictFailure,
  onConflictRefreshFailure,
  onAmbiguousFailure,
  onAmbiguousRefreshFailure,
  onRefreshFailure,
}: {
  action: () => Promise<unknown>;
  refresh: () => Promise<BookSummary[] | null>;
  onSuccess: () => void;
  onFailure: (e: unknown) => void;
  isConflictFailure?: (e: unknown) => boolean;
  onConflictFailure?: (e: unknown) => void;
  onConflictRefreshFailure?: (e: unknown) => void;
  onAmbiguousFailure?: (e: unknown) => void;
  onAmbiguousRefreshFailure?: (e: unknown) => void;
  onRefreshFailure?: () => void;
}) {
  try {
    await action();
  } catch (e) {
    const conflict = Boolean(isConflictFailure?.(e));
    if (conflict || api.isAmbiguousApiFailure(e)) {
      let refreshed: BookSummary[] | null = null;
      try { refreshed = await refresh(); }
      catch { /* loadShelf 通常已自行收敛错误；这里仍保持未知状态。 */ }
      if (refreshed) {
        if (conflict) onConflictFailure?.(e);
        else onAmbiguousFailure?.(e);
      } else if (conflict) onConflictRefreshFailure?.(e);
      else onAmbiguousRefreshFailure?.(e);
      return false;
    }
    onFailure(e);
    return false;
  }
  let refreshed: BookSummary[] | null;
  try { refreshed = await refresh(); }
  catch {
    onRefreshFailure?.();
    return false;
  }
  if (!refreshed) {
    onRefreshFailure?.();
    return false;
  }
  onSuccess();
  return true;
}

export async function reconcileCreatedShelfMutationFailure({
  error,
  expectedBookId,
  refresh,
}: {
  error: unknown;
  expectedBookId: string;
  refresh: () => Promise<BookSummary[] | null>;
}): Promise<{
  status: 'explicit_failure' | 'created' | 'not_created' | 'unknown';
  createdIds: string[];
}> {
  if (!api.isAmbiguousApiFailure(error)) {
    return { status: 'explicit_failure', createdIds: [] };
  }
  let refreshed: BookSummary[] | null;
  try { refreshed = await refresh(); }
  catch { return { status: 'unknown', createdIds: [] }; }
  if (!refreshed) return { status: 'unknown', createdIds: [] };
  // 服务端严格使用本次请求预分配的 ID。只匹配它，避免把另一标签页
  // 同时创建或导入的作品误认为本次操作已经成功。
  const createdIds = refreshed.some((book) => book.id === expectedBookId)
    ? [expectedBookId]
    : [];
  return {
    status: createdIds.length ? 'created' : 'not_created',
    createdIds,
  };
}

export async function reconcileAcknowledgedCreationOpen({
  expectedBookId,
  open,
  refresh,
}: {
  expectedBookId: string;
  open: () => Promise<boolean>;
  refresh: () => Promise<BookSummary[] | null>;
}): Promise<'opened' | 'shelf_refreshed' | 'unavailable'> {
  try {
    if (await open()) return 'opened';
  } catch { /* 创建已确认；继续用书架精确核对可见性。 */ }
  let refreshed: BookSummary[] | null = null;
  try { refreshed = await refresh(); }
  catch { /* 调用方将展示“已创建但不可确认页面状态”。 */ }
  return refreshed?.some((book) => book.id === expectedBookId)
    ? 'shelf_refreshed'
    : 'unavailable';
}

export async function reconcilePersistedMutationFailure({
  error,
  refresh,
}: {
  error: unknown;
  refresh: () => Promise<void>;
}): Promise<
  'explicit_failure'
  | 'conflict'
  | 'conflict_refresh_failed'
  | 'recovered'
  | 'recovered_refresh_failed'
  | 'refreshed'
  | 'unknown'
> {
  const structureConflict = api.isApiErrorCode(error, 'NEXT_SECTION_CONFLICT')
    || api.isApiErrorCode(error, 'NEXT_CHAPTER_CONFLICT');
  if (structureConflict) {
    try {
      await refresh();
      return 'conflict';
    } catch {
      return 'conflict_refresh_failed';
    }
  }
  const recoveredStructure = api.isApiErrorCode(error, 'STRUCTURE_TRANSACTION_RECOVERED');
  if (recoveredStructure) {
    try {
      await refresh();
      return 'recovered';
    } catch {
      return 'recovered_refresh_failed';
    }
  }
  if (!api.isAmbiguousApiFailure(error)) return 'explicit_failure';
  try {
    await refresh();
    return 'refreshed';
  } catch {
    return 'unknown';
  }
}

export async function reconcileVersionConflict({
  error,
  refresh,
  onRefreshed,
  onRefreshFailure,
}: {
  error: unknown;
  refresh: () => Promise<void>;
  onRefreshed: () => void;
  onRefreshFailure: (error: unknown) => void;
}) {
  if (!api.isApiErrorCode(error, 'VERSION_CONFLICT')) return false;
  try {
    await refresh();
    onRefreshed();
  } catch (refreshError) {
    onRefreshFailure(refreshError);
  }
  return true;
}

// 持久化已成功后单独刷新页面数据。调用方据返回值区分“操作失败”和
// “操作已落盘但刷新失败”，避免给用户错误的重试暗示。
export async function refreshPersistedChange(refresh: () => Promise<void>): Promise<unknown | null> {
  try {
    await refresh();
    return null;
  } catch (e) {
    return e;
  }
}

// 生成完成后刷新页面前后都要确认所有权：停止按钮或更新一轮生成会使旧回调
// 立即失效。这样迟到的 done 既不会启动旧刷新，也不会在刷新等待期间失去
// 所有权后继续弹出成功提示。
export async function refreshOwnedGeneration({
  owns, refresh,
}: {
  owns: () => boolean;
  refresh: () => Promise<void>;
}): Promise<{ owned: boolean; refreshError: unknown | null }> {
  if (!owns()) return { owned: false, refreshError: null };
  const refreshError = await refreshPersistedChange(refresh);
  return { owned: owns(), refreshError };
}

export async function refreshStoppedGeneration({
  pending,
  savedSelection,
  fallbackSelection,
  reload,
}: {
  pending?: Promise<unknown> | null;
  savedSelection: Selection | null;
  fallbackSelection: Selection;
  reload: (selection: Selection) => Promise<void>;
}): Promise<unknown | null> {
  // AbortController 只发出取消请求，不代表浏览器流任务或服务端提交边界
  // 已经收尾。先等流读取及其回调退出，再读取磁盘上的最终状态。
  try { await pending; }
  catch { /* 原流错误由所属回调处理；停止核对仍以磁盘为准。 */ }
  // 停止与服务端提交可能同时发生。即使浏览器还没收到 saved 事件，也要
  // 重新读取磁盘；否则旧页面可能在一次实际已落盘的生成后继续显示旧版本。
  try {
    await reload(savedSelection ?? fallbackSelection);
    return null;
  } catch (error) {
    return error;
  }
}

export async function refreshStoppedReview({
  pending,
  selection,
  reload,
}: {
  pending: Promise<unknown> | null;
  selection: Selection;
  reload: (selection: Selection) => Promise<void>;
}): Promise<unknown | null> {
  return refreshStoppedGeneration({
    pending,
    savedSelection: null,
    fallbackSelection: selection,
    reload,
  });
}

export async function reconcileGenerationFailure({
  message,
  savedSelection,
  fallbackSelection = null,
  reload,
  onUnsavedFailure,
  onUnsavedRefreshFailure,
  onSavedFailure,
  onSavedRefreshFailure,
}: {
  message: string;
  savedSelection: Selection | null;
  fallbackSelection?: Selection | null;
  reload: (selection: Selection) => Promise<void>;
  onUnsavedFailure: (message: string) => void;
  onUnsavedRefreshFailure?: (message: string, error: unknown) => void;
  onSavedFailure: (message: string) => void;
  onSavedRefreshFailure: (message: string, error: unknown) => void;
}) {
  const targetSelection = savedSelection ?? fallbackSelection;
  if (!targetSelection) {
    onUnsavedFailure(message);
    return false;
  }
  try {
    await reload(targetSelection);
  } catch (error) {
    if (savedSelection) onSavedRefreshFailure(message, error);
    else if (onUnsavedRefreshFailure) onUnsavedRefreshFailure(message, error);
    else onUnsavedFailure(message);
    return false;
  }
  if (savedSelection) {
    onSavedFailure(message);
    return true;
  }
  onUnsavedFailure(message);
  return false;
}

export async function adoptSectionTitles({
  titles,
  addSection,
  reload,
  onSuccess,
  onPartialFailure,
  isAmbiguousFailure,
  isRecoveredFailure,
  isConflictFailure,
  onAmbiguousFailure,
  onAmbiguousRefreshFailure,
  onRecoveredFailure,
  onRecoveredRefreshFailure,
  onConflictFailure,
  onConflictRefreshFailure,
  onRefreshFailure,
  onFailure,
  onFinish,
}: {
  titles: string[];
  addSection: (title: string) => Promise<unknown>;
  reload: () => Promise<void>;
  onSuccess: (created: number) => void;
  onPartialFailure: (created: number, total: number, e: unknown) => void;
  isAmbiguousFailure?: (e: unknown) => boolean;
  isRecoveredFailure?: (e: unknown) => boolean;
  isConflictFailure?: (e: unknown) => boolean;
  onAmbiguousFailure?: (acknowledged: number, total: number, e: unknown) => void;
  onAmbiguousRefreshFailure?: (
    acknowledged: number, total: number, addError: unknown, refreshError: unknown,
  ) => void;
  onRecoveredFailure?: (acknowledged: number, total: number, e: unknown) => void;
  onRecoveredRefreshFailure?: (
    acknowledged: number, total: number, addError: unknown, refreshError: unknown,
  ) => void;
  onConflictFailure?: (acknowledged: number, total: number, e: unknown) => void;
  onConflictRefreshFailure?: (
    acknowledged: number, total: number, addError: unknown, refreshError: unknown,
  ) => void;
  onRefreshFailure?: (created: number, total: number, e: unknown) => void;
  onFailure: (e: unknown) => void;
  onFinish: () => void;
}) {
  let created = 0;
  let addError: unknown = null;
  for (const title of titles) {
    try {
      await addSection(title);
      created += 1;
    } catch (e) {
      addError = e;
      break;
    }
  }
  const ambiguous = addError !== null && Boolean(isAmbiguousFailure?.(addError));
  const recovered = addError !== null && Boolean(isRecoveredFailure?.(addError));
  const conflict = addError !== null && Boolean(isConflictFailure?.(addError));
  if (created === 0 && addError && !ambiguous && !recovered && !conflict) {
    onFailure(addError);
    return { created, total: titles.length, ok: false };
  }
  try {
    await reload();
  } catch (e) {
    if (ambiguous) {
      if (onAmbiguousRefreshFailure) {
        onAmbiguousRefreshFailure(created, titles.length, addError, e);
      } else onRefreshFailure?.(created, titles.length, e);
    } else if (recovered) {
      if (onRecoveredRefreshFailure) {
        onRecoveredRefreshFailure(created, titles.length, addError, e);
      } else onRefreshFailure?.(created, titles.length, e);
    } else if (conflict) {
      if (onConflictRefreshFailure) {
        onConflictRefreshFailure(created, titles.length, addError, e);
      } else onRefreshFailure?.(created, titles.length, e);
    } else onRefreshFailure?.(created, titles.length, e);
    onFinish();
    return { created, total: titles.length, ok: false };
  }
  if (addError) {
    if (ambiguous && onAmbiguousFailure) {
      onAmbiguousFailure(created, titles.length, addError);
    } else if (recovered && onRecoveredFailure) {
      onRecoveredFailure(created, titles.length, addError);
    } else if (conflict && onConflictFailure) {
      onConflictFailure(created, titles.length, addError);
    } else if (created > 0) onPartialFailure(created, titles.length, addError);
    else onFailure(addError);
    onFinish();
    return { created, total: titles.length, ok: false };
  }
  onSuccess(created);
  onFinish();
  return { created, total: titles.length, ok: true };
}

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

  // —— 章节推进（下一章 / 抽打）——
  const runChapter = (mode: 'next' | 'whip', whip?: string) => {
    const submittedWhipDraft = mode === 'whip'
      && isSubmittedWhipDraft(whipDraftRef.current, whip ?? '');
    if (blockDirtyDraftAction({ allowWhipDraft: submittedWhipDraft })) return false;
    const sectionId = selection.kind === 'chapter' ? selection.sectionId : tree.sections[0]?.id;
    if (!sectionId) { toast.error('请先新建一个部'); return false; }
    const chapterId = selection.kind === 'chapter' ? selection.chapterId : undefined;
    const expectedLastChapterId = mode === 'next'
      ? lastChapterIdForSection(tree, sectionId)
      : undefined;
    return startStreaming((token) => {
      setStreamingText(''); setStreamingPath('chapter');
      setStatusText(mode === 'whip' ? '🗯️ 正在按你的要求重写…' : '✍️ 正在写下一章…');
      const expectedRevision = mode === 'whip' && selection.kind === 'chapter'
        ? activeChapter?.body.revision
        : undefined;
      streamHandleRef.current = api.streamGen('/api/gen/chapter', {
        bookId, sectionId, chapterId, mode, whip, expectedRevision, expectedLastChapterId,
      }, {
        onDelta: (d) => { if (ownsStreaming(token)) setStreamingText((t) => t + d); },
        onSaved: (e) => {
          if (!ownsStreaming(token)) return;
          savedSelectionRef.current = { kind: 'chapter', sectionId, chapterId: e.chapterId ?? chapterId! };
          if (submittedWhipDraft && isSubmittedWhipDraft(whipDraftRef.current, whip ?? '')) {
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

  // —— 手动审稿 ——
  const doReview = async () => {
    if (selection.kind !== 'chapter') return;
    if (blockDirtyDraftAction()) return;
    if (!activeChapter?.bodyFingerprint || !activeChapter.reviewContextRevision) {
      toast.error('页面缺少有效的审稿版本标识，请刷新章节后重试');
      return;
    }
    const { sectionId, chapterId } = selection;
    const expectedBodyFingerprint = activeChapter.bodyFingerprint;
    const expectedContextRevision = activeChapter.reviewContextRevision;
    const operation = runExclusiveAction({
      isRunning: () => reviewingRef.current || isGenerationBusy() || versionMutatingRef.current
        || structureMutatingRef.current || planAdoptingRef.current,
      setRunning: setReviewRequestRunning,
      task: async () => {
        const { token, signal } = reviewRequestGate.begin();
        try {
          await api.reviewChapter(
            bookId, sectionId, chapterId,
            expectedBodyFingerprint, expectedContextRevision, signal,
          );
        } catch (e) {
          if (signal.aborted || !reviewRequestGate.owns(token)) return;
          const reconciled = await reconcilePersistedMutationFailure({
            error: e,
            refresh: () => reload(bookId, selection),
          });
          if (!reviewRequestGate.owns(token)) return;
          if (reconciled === 'refreshed') {
            toast.error('审稿结果未确认，已刷新实际审稿结果；请确认后再决定是否重试');
          } else if (reconciled === 'unknown') {
            toast.error('审稿结果未确认且刷新失败；请返回书架确认');
          } else toast.error('审稿失败：' + messageOf(e));
          return;
        }
        if (signal.aborted || !reviewRequestGate.owns(token)) return;
        const refreshError = await refreshPersistedChange(() => reload(bookId, selection));
        if (!reviewRequestGate.owns(token)) return;
        if (refreshError) toast.error('审稿已保存，但页面刷新失败：' + messageOf(refreshError));
        else toast.success('✓ 审稿完成');
      },
    });
    reviewOperationRef.current = operation;
    try { await operation; }
    finally {
      if (reviewOperationRef.current === operation) reviewOperationRef.current = null;
    }
  };
  const onUseSuggestion = (instruction: string) => {
    runChapter('whip', instruction);
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
                try {
                  await api.addSection(
                    bookId, undefined, undefined, lastSectionIdForBook(tree),
                  );
                }
                catch (e) {
                  const reconciled = await reconcilePersistedMutationFailure({
                    error: e,
                    refresh: () => reload(bookId),
                  });
                  if (reconciled === 'conflict') {
                    toast.error('另一页面已经新增分部；已刷新侧栏，本次新建未执行');
                  } else if (reconciled === 'conflict_refresh_failed') {
                    toast.error('另一页面已经新增分部，但侧栏刷新失败；本次新建未执行，请返回书架确认');
                  } else if (reconciled === 'recovered') {
                    toast.error('已完成此前中断的分部事务并刷新侧栏；本次新建未执行，请检查后再操作');
                  } else if (reconciled === 'recovered_refresh_failed') {
                    toast.error('已完成此前中断的分部事务，但侧栏刷新失败；本次新建未执行，请返回书架确认');
                  } else if (reconciled === 'refreshed') {
                    toast.error('新建部结果未确认，已刷新本地数据；请先检查侧栏，再决定是否重试');
                  } else if (reconciled === 'unknown') {
                    toast.error('新建部结果未确认且刷新失败；请返回书架确认后再重试');
                  } else toast.error('新建部失败：' + messageOf(e));
                  return;
                }
                const refreshError = await refreshPersistedChange(() => reload(bookId));
                if (refreshError) {
                  toast.error('分部已创建，但侧栏刷新失败：' + messageOf(refreshError));
                }
              },
            });
          }}
          onAddChapter={async (sid) => {
            if (blockDirtyDraftAction()) return;
            await runExclusiveAction({
              isRunning: () => structureMutatingRef.current || isGenerationBusy() || reviewingRef.current
                || versionMutatingRef.current || planAdoptingRef.current,
              setRunning: setStructureMutationRunning,
              task: async () => {
                let c;
                try {
                  c = await api.addChapter(
                    bookId, sid, undefined, lastChapterIdForSection(tree, sid),
                  );
                }
                catch (e) {
                  const reconciled = await reconcilePersistedMutationFailure({
                    error: e,
                    refresh: () => reload(bookId),
                  });
                  if (reconciled === 'conflict') {
                    toast.error('另一页面已经新增章节；已刷新侧栏，本次新建未执行');
                  } else if (reconciled === 'conflict_refresh_failed') {
                    toast.error('另一页面已经新增章节，但侧栏刷新失败；本次新建未执行，请返回书架确认');
                  } else if (reconciled === 'recovered') {
                    toast.error('已完成此前中断的章节事务并刷新侧栏；本次新建未执行，请检查后再操作');
                  } else if (reconciled === 'recovered_refresh_failed') {
                    toast.error('已完成此前中断的章节事务，但侧栏刷新失败；本次新建未执行，请返回书架确认');
                  } else if (reconciled === 'refreshed') {
                    toast.error('新建章结果未确认，已刷新本地数据；请先检查侧栏，再决定是否重试');
                  } else if (reconciled === 'unknown') {
                    toast.error('新建章结果未确认且刷新失败；请返回书架确认后再重试');
                  } else toast.error('新建章失败：' + messageOf(e));
                  return;
                }
                const refreshError = await refreshPersistedChange(() => reload(
                  bookId, { kind: 'chapter', sectionId: sid, chapterId: c.id },
                ));
                if (refreshError) {
                  toast.error('章节已创建，但侧栏刷新失败：' + messageOf(refreshError));
                }
              },
            });
          }}
          onPlanSections={runSections} />
        <div className="content">
          <MainPanel tree={tree} selection={selection} chapter={activeChapter} chapterLoading={chapterLoading}
            streaming={streaming}
            versionBusy={whipDraftDirty || shouldDisableVersionedBox({ streaming: generationBusy, versionMutating, reviewing, structureMutating, planAdopting })}
            streamingText={streamingText} streamingPath={streamingPath}
            onMove={doMove} onRewrite={doRewrite} onClear={doClear} onSave={doSave} onStop={stopGen}
            onDraftDirtyChange={updateDraftDirty}
            reviewing={reviewing} reviewDisabled={hasAnyLocalDraft || generationBusy || versionMutating || structureMutating || planAdopting || chapterLoading || !activeChapter}
            onReview={doReview} onStopReview={stopReview} onUseSuggestion={onUseSuggestion}
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
                : runChapter('next')}
              onWhip={(t) => runChapter('whip', t)} onStop={stopGen} />}
        </div>
      </div>
      {planOpen && <SectionPlanPanel text={planText} titles={planTitles} plans={planSections} streaming={generationBusy} adopting={planAdopting} parseError={planParseError}
        returnFocus={sectionPlanReturnFocusRef.current}
        onAdopt={adoptSections} onRetry={() => { setPlanOpen(false); runSections(); }} onClose={() => { if (streamingRef.current) void stopGen(); setPlanOpen(false); }} />}
    </div>
  );
}
