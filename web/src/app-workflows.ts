import type { BookSummary, BookTree, Chapter } from './types';
import type { Selection } from './store';
import { firstSelectable, selectionExists } from './store';
import * as api from './api';

type LoadedChapter = { sectionId: string; chapter: Chapter };
type WorkspaceSnapshot = {
  tree: BookTree;
  selection: Selection;
  loadedChapter: LoadedChapter | null;
};

export const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function runPersistedReviewRequest({
  begin, owns, request, refresh,
}: {
  begin: () => { token: number; signal: AbortSignal };
  owns: (token: number) => boolean;
  request: (signal: AbortSignal) => Promise<unknown>;
  refresh: () => Promise<void>;
}): Promise<{
  status: 'saved' | 'saved-refresh-failed' | 'refreshed' | 'unknown' | 'failed' | 'aborted';
  error?: unknown;
}> {
  const { token, signal } = begin();
  try { await request(signal); }
  catch (error) {
    if (signal.aborted || !owns(token)) return { status: 'aborted' };
    const reconciled = await reconcilePersistedMutationFailure({ error, refresh });
    if (!owns(token)) return { status: 'aborted' };
    return {
      status: reconciled === 'refreshed' || reconciled === 'unknown'
        ? reconciled : 'failed',
      error,
    };
  }
  if (signal.aborted || !owns(token)) return { status: 'aborted' };
  const error = await refreshPersistedChange(refresh);
  if (!owns(token)) return { status: 'aborted' };
  return error ? { status: 'saved-refresh-failed', error } : { status: 'saved' };
}

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
  hasEditorDraft, creationPremiseDraft, whipDraft, sectionPlanDraft,
  streaming, reviewing, versionMutating, structureMutating, planAdopting, shelfMutating,
}: {
  hasEditorDraft: boolean;
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
  return hasEditorDraft || creationPremiseDraft || whipDraft || sectionPlanDraft
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
    return '正文已保存，但摘要/剧情路标/人物与章末交接快照提取和自动审稿均未完成；继续生成下一章时可用前情会较少，请先检查模型 JSON 兼容性，审稿可通过页面按钮手动重试';
  }
  if (digestFailed) {
    return '正文已保存，但摘要/剧情路标/人物与章末交接快照提取未完成；继续生成下一章时可用前情会较少，请检查模型 JSON 兼容性';
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

export type PersistedMutationReconciliation =
  'explicit_failure'
  | 'conflict'
  | 'conflict_refresh_failed'
  | 'recovered'
  | 'recovered_refresh_failed'
  | 'refreshed'
  | 'unknown';

export async function reconcilePersistedMutationFailure({
  error,
  refresh,
}: {
  error: unknown;
  refresh: () => Promise<void>;
}): Promise<PersistedMutationReconciliation> {
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

export type PersistedCreationResult<T> =
  | { status: 'created'; value: T; refreshError: unknown | null }
  | {
    status: 'failed';
    error: unknown;
    reconciliation: PersistedMutationReconciliation;
  };

// 新建部、章都遵守同一“先提交、失败时核对、成功后刷新”边界。
// 把它留在可独立测试的工作流层，避免顶层组件在两处复制模糊失败处理，
// 同时由调用方保留具体选择目标和用户提示。
export async function runPersistedCreation<T>({
  create,
  refreshAfterFailure,
  refreshAfterSuccess,
}: {
  create: () => Promise<T>;
  refreshAfterFailure: () => Promise<void>;
  refreshAfterSuccess: (value: T) => Promise<void>;
}): Promise<PersistedCreationResult<T>> {
  let value: T;
  try {
    value = await create();
  } catch (error) {
    return {
      status: 'failed',
      error,
      reconciliation: await reconcilePersistedMutationFailure({
        error, refresh: refreshAfterFailure,
      }),
    };
  }
  return {
    status: 'created',
    value,
    refreshError: await refreshPersistedChange(() => refreshAfterSuccess(value)),
  };
}

export async function saveChapterPlanWithReconciliation<T>({
  save, refresh, isConflict, onConflict, onConflictRefreshFailure,
  onAmbiguous, onAmbiguousRefreshFailure, onSaved, onRefreshFailure, onSuccess,
}: {
  save: () => Promise<T>;
  refresh: () => Promise<void>;
  isConflict: (error: unknown) => boolean;
  onConflict: () => void;
  onConflictRefreshFailure: () => void;
  onAmbiguous: () => void;
  onAmbiguousRefreshFailure: () => void;
  onSaved: (saved: T) => void;
  onRefreshFailure: (error: unknown) => void;
  onSuccess: () => void;
}): Promise<T> {
  let saved: T;
  try {
    saved = await save();
  } catch (error) {
    if (isConflict(error)) {
      try { await refresh(); onConflict(); }
      catch { onConflictRefreshFailure(); }
      throw error;
    }
    const reconciled = await reconcilePersistedMutationFailure({ error, refresh });
    if (reconciled === 'refreshed') onAmbiguous();
    else if (reconciled === 'unknown') onAmbiguousRefreshFailure();
    throw error;
  }
  onSaved(saved);
  const refreshError = await refreshPersistedChange(refresh);
  if (refreshError) onRefreshFailure(refreshError);
  else onSuccess();
  return saved;
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
