import { describe, expect, it, vi } from 'vitest';
import type { BookSummary, BookTree, Chapter } from './types';
import { createLatestAbortGate, createLatestRequestGate } from './asyncAction';
import { ApiResponseError } from './api';
import {
  applyShelfSupplementalLoadResult,
  adoptSectionTitles,
  chapterPostprocessWarningMessage,
  lastChapterIdForSection,
  lastSectionIdForBook,
  localDraftBlockReason,
  nextChapterSelection,
  nextSectionPlanReturnFocus,
  ownsActiveGeneration,
  outlinePostprocessWarningMessage,
  loadBookWorkspace,
  loadShelfBooks,
  reconcileAcknowledgedCreationOpen,
  reconcileCreatedShelfMutationFailure,
  reconcileGenerationFailure,
  reconcilePersistedMutationFailure,
  reconcileVersionConflict,
  refreshPersistedChange,
  refreshOwnedGeneration,
  refreshStoppedGeneration,
  refreshStoppedReview,
  runExclusiveStructureMutation,
  runExclusiveVersionMutation,
  runExclusiveSectionAdoption,
  runShelfMutation,
  verifiedShelfRefresh,
  shouldDisableSidebar,
  shouldDisableVersionedBox,
  shouldWarnBeforeUnloadForApp,
  shouldShowFirstRun,
  updateDirtyDraftPaths,
} from './App';

describe('page exit protection', () => {
  const idle = {
    creationPremiseDraft: false,
    whipDraft: false,
    sectionPlanDraft: false,
    streaming: false,
    reviewing: false,
    versionMutating: false,
    structureMutating: false,
    planAdopting: false,
    shelfMutating: false,
  };

  it('warns for every unpersisted draft and persistence-affecting operation', () => {
    expect(shouldWarnBeforeUnloadForApp(idle)).toBe(false);
    for (const field of Object.keys(idle) as Array<keyof typeof idle>) {
      expect(shouldWarnBeforeUnloadForApp({ ...idle, [field]: true })).toBe(true);
    }
  });
});

describe('supplemental shelf loading', () => {
  it('preserves the last trusted value when an auxiliary request fails', () => {
    const setValue = vi.fn();
    const setError = vi.fn();
    const error = new Error('TEMPORARY_FAILURE');

    expect(applyShelfSupplementalLoadResult(
      { status: 'rejected', reason: error }, setValue, setError,
    )).toBe('TEMPORARY_FAILURE');
    expect(setValue).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('TEMPORARY_FAILURE');
  });

  it('replaces the value and clears its persistent warning after recovery', () => {
    const setValue = vi.fn();
    const setError = vi.fn();
    const value = [book('restored')];

    expect(applyShelfSupplementalLoadResult(
      { status: 'fulfilled', value }, setValue, setError,
    )).toBeNull();
    expect(setValue).toHaveBeenCalledWith(value);
    expect(setError).toHaveBeenCalledWith(null);
  });
});

const book = (id: string): BookSummary => ({
  id,
  title: `Book ${id}`,
  updatedAt: '2026-08-03T00:00:00.000Z',
  sectionCount: 0,
  chapterCount: 0,
});

const treeWithChapter = (bookId: string): BookTree => ({
  book: {
    id: bookId,
    title: `Book ${bookId}`,
    titleSource: 'manual',
    outline: { versions: [''], cursor: 0 },
    settings: {
      core: {
        world: { versions: [''], cursor: 0 },
        style: { versions: [''], cursor: 0 },
        constraints: { versions: [''], cursor: 0 },
        pacing: { versions: [''], cursor: 0 },
      },
      history: [],
    },
  },
  sections: [{
    id: 'section-01', index: 1, title: '', titleSource: 'default',
    chapters: [{
      id: 'chapter-01', index: 1, title: '', titleSource: 'default',
      status: '', hasContent: false,
    }],
  }],
});

const chapter = (id = 'chapter-01'): Chapter => ({
  id,
  index: 1,
  title: '',
  titleSource: 'default',
  body: { versions: [''], cursor: 0 },
  content: '',
  bodyFingerprint: '',
  characters: [],
  summary: '',
  progress: '',
  status: '',
});

describe('structure creation anchors', () => {
  it('uses the last section and chapter visible in the tree', () => {
    const tree = treeWithChapter('book-1');
    tree.sections[0].chapters.push({
      id: 'chapter-02', index: 2, title: '', titleSource: 'default',
      status: '', hasContent: false,
    });

    expect(lastSectionIdForBook(tree)).toBe('section-01');
    expect(lastChapterIdForSection(tree, 'section-01')).toBe('chapter-02');
    expect(lastChapterIdForSection(tree, 'missing-section')).toBeNull();
    expect(lastSectionIdForBook({ ...tree, sections: [] })).toBeNull();
  });
});

describe('existing next chapter navigation', () => {
  it('finds the next chapter in the current section', () => {
    const tree = treeWithChapter('book-1');
    tree.sections[0].chapters.push({
      id: 'chapter-02', index: 2, title: '', titleSource: 'default',
      status: '', hasContent: true,
    });

    expect(nextChapterSelection(tree, {
      kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-01',
    })).toEqual({
      kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-02',
    });
  });

  it('crosses empty sections and only generates when no later chapter exists', () => {
    const tree = treeWithChapter('book-1');
    tree.sections.push(
      { id: 'section-02', index: 2, title: '', titleSource: 'default', chapters: [] },
      {
        id: 'section-03', index: 3, title: '', titleSource: 'default',
        chapters: [{
          id: 'chapter-03', index: 1, title: '', titleSource: 'default',
          status: '', hasContent: false,
        }],
      },
    );

    expect(nextChapterSelection(tree, {
      kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-01',
    })).toEqual({
      kind: 'chapter', sectionId: 'section-03', chapterId: 'chapter-03',
    });
    expect(nextChapterSelection(tree, {
      kind: 'chapter', sectionId: 'section-03', chapterId: 'chapter-03',
    })).toBeNull();
    expect(nextChapterSelection(tree, { kind: 'outline' })).toBeNull();
  });
});

describe('dirty draft registry', () => {
  it('keeps navigation blocked until every dirty editor is clean', () => {
    const paths = new Set<string>();

    expect(updateDirtyDraftPaths(paths, 'outline', true)).toBe(true);
    expect(updateDirtyDraftPaths(paths, 'core:world', true)).toBe(true);
    expect(updateDirtyDraftPaths(paths, 'outline', false)).toBe(true);
    expect(updateDirtyDraftPaths(paths, 'core:world', false)).toBe(false);
    expect(paths.size).toBe(0);
  });

  it('is idempotent when an editor reports the same state twice', () => {
    const paths = new Set<string>();

    updateDirtyDraftPaths(paths, 'outline', true);
    updateDirtyDraftPaths(paths, 'outline', true);
    expect(paths.size).toBe(1);
    expect(updateDirtyDraftPaths(paths, 'outline', false)).toBe(false);
  });

  it('prioritizes editor drafts and only allows submission of the current whip draft', () => {
    expect(localDraftBlockReason({
      hasEditorDraft: true, hasWhipDraft: true, allowWhipDraft: true,
    })).toBe('editor');
    expect(localDraftBlockReason({
      hasEditorDraft: false, hasWhipDraft: true,
    })).toBe('whip');
    expect(localDraftBlockReason({
      hasEditorDraft: false, hasWhipDraft: true, allowWhipDraft: true,
    })).toBeNull();
  });
});

describe('section plan focus restoration', () => {
  it('remembers a new trigger outside the dialog', () => {
    expect(nextSectionPlanReturnFocus({
      current: 'old-trigger', active: 'plan-button', activeInsideDialog: false,
    })).toBe('plan-button');
  });

  it('keeps the original trigger across dialog retries', () => {
    expect(nextSectionPlanReturnFocus({
      current: 'plan-button', active: 'retry-button', activeInsideDialog: true,
    })).toBe('plan-button');
    expect(nextSectionPlanReturnFocus({
      current: 'plan-button', active: null, activeInsideDialog: false,
    })).toBe('plan-button');
  });
});

describe('book workspace loading', () => {
  it('does not let a stale tree response restart loading or request an old chapter', async () => {
    const gate = createLatestRequestGate();
    const token = gate.begin();
    let releaseTree!: (tree: BookTree) => void;
    const delayedTree = new Promise<BookTree>((resolve) => { releaseTree = resolve; });
    const getChapter = vi.fn(async () => chapter());
    const loadingStates: boolean[] = [];

    const staleLoad = loadBookWorkspace({
      bookId: 'old-book',
      getTree: () => delayedTree,
      getChapter,
      isCurrent: () => gate.owns(token),
      setChapterLoading: (loading) => loadingStates.push(loading),
    });
    gate.invalidate();
    releaseTree(treeWithChapter('old-book'));

    await expect(staleLoad).resolves.toBeNull();
    expect(getChapter).not.toHaveBeenCalled();
    expect(loadingStates).toEqual([]);
  });

  it('does not let a stale chapter response clear loading owned by a newer request', async () => {
    const gate = createLatestRequestGate();
    const token = gate.begin();
    let releaseChapter!: (chapter: Chapter) => void;
    let markChapterStarted!: () => void;
    const chapterStarted = new Promise<void>((resolve) => { markChapterStarted = resolve; });
    const delayedChapter = new Promise<Chapter>((resolve) => { releaseChapter = resolve; });
    const loadingStates: boolean[] = [];

    const staleLoad = loadBookWorkspace({
      bookId: 'old-book',
      getTree: async () => treeWithChapter('old-book'),
      getChapter: async () => {
        markChapterStarted();
        return delayedChapter;
      },
      isCurrent: () => gate.owns(token),
      setChapterLoading: (loading) => loadingStates.push(loading),
    });
    await chapterStarted;
    gate.invalidate();
    releaseChapter(chapter());

    await expect(staleLoad).resolves.toBeNull();
    expect(loadingStates).toEqual([true]);
  });

  it('clears loading when the current chapter request fails', async () => {
    const loadingStates: boolean[] = [];

    await expect(loadBookWorkspace({
      bookId: 'current-book',
      getTree: async () => treeWithChapter('current-book'),
      getChapter: async () => { throw new Error('CHAPTER_LOAD_FAILED'); },
      setChapterLoading: (loading) => loadingStates.push(loading),
    })).rejects.toThrow('CHAPTER_LOAD_FAILED');
    expect(loadingStates).toEqual([true, false]);
  });
});

describe('shelf loading', () => {
  it('records the load error without replacing the shelf with an empty list', async () => {
    const setBooks = vi.fn();
    let shelfError: string | null = null;

    const result = await loadShelfBooks(
      async () => { throw new Error('SERVER_DOWN'); },
      setBooks,
      (next) => { shelfError = next; },
    );

    expect(result).toBeNull();
    expect(setBooks).not.toHaveBeenCalled();
    expect(shelfError).toBe('SERVER_DOWN');
  });

  it('clears the previous load error after a successful shelf load', async () => {
    const setBooks = vi.fn();
    let shelfError: string | null = 'SERVER_DOWN';
    const books = [book('b1')];

    const result = await loadShelfBooks(
      async () => books,
      setBooks,
      (next) => { shelfError = next; },
    );

    expect(result).toEqual(books);
    expect(setBooks).toHaveBeenCalledWith(books);
    expect(shelfError).toBeNull();
  });

  it('does not let an older overlapping shelf request replace the latest list', async () => {
    const gate = createLatestAbortGate();
    let releaseOld!: (books: BookSummary[]) => void;
    const oldResponse = new Promise<BookSummary[]>((resolve) => { releaseOld = resolve; });
    const visible: BookSummary[][] = [];
    let oldSignal: AbortSignal | undefined;
    const load = (response: Promise<BookSummary[]>) => {
      const { token, signal } = gate.begin();
      return loadShelfBooks(
        (receivedSignal) => {
          if (response === oldResponse) oldSignal = receivedSignal;
          return response;
        },
        (books) => visible.push(books),
        () => {},
        undefined,
        () => gate.owns(token),
        signal,
      );
    };

    const oldLoad = load(oldResponse);
    await load(Promise.resolve([book('latest')]));
    expect(oldSignal?.aborted).toBe(true);
    releaseOld([book('stale')]);
    await oldLoad;

    expect(visible).toEqual([[book('latest')]]);
  });

  it('does not show first-run creation when the empty shelf came from a load error', () => {
    expect(shouldShowFirstRun({
      creating: false,
      books: [],
      shelfError: 'SERVER_DOWN',
    })).toBe(false);
  });

  it('still shows first-run creation for a successfully loaded empty shelf', () => {
    expect(shouldShowFirstRun({
      creating: false,
      books: [],
      shelfError: null,
    })).toBe(true);
  });

  it('keeps the shelf visible when hidden damaged data was detected', () => {
    expect(shouldShowFirstRun({
      creating: false,
      books: [],
      shelfError: null,
      hasStorageIssues: true,
    })).toBe(false);
  });

  it('keeps the shelf visible when all books are currently in the recycle bin', () => {
    expect(shouldShowFirstRun({
      creating: false,
      books: [],
      shelfError: null,
      hasDeletedBooks: true,
    })).toBe(false);
  });

  it('keeps the shelf visible when auxiliary state could not be verified', () => {
    expect(shouldShowFirstRun({
      creating: false,
      books: [],
      shelfError: null,
      hasAuxiliaryLoadError: true,
    })).toBe(false);
  });

  it('does not show mutation success when the follow-up shelf refresh failed', async () => {
    const action = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => null);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const onRefreshFailure = vi.fn();

    const ok = await runShelfMutation({
      action, refresh, onSuccess, onFailure, onRefreshFailure,
    });

    expect(ok).toBe(false);
    expect(action).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(onRefreshFailure).toHaveBeenCalledOnce();
  });

  it('reports an acknowledged mutation when the follow-up refresh throws', async () => {
    const onRefreshFailure = vi.fn();

    const ok = await runShelfMutation({
      action: async () => undefined,
      refresh: async () => { throw new Error('refresh failed'); },
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      onRefreshFailure,
    });

    expect(ok).toBe(false);
    expect(onRefreshFailure).toHaveBeenCalledOnce();
  });

  it('shows mutation success only after the shelf refresh succeeded', async () => {
    const books = [book('b1')];
    const action = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => books);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    const ok = await runShelfMutation({ action, refresh, onSuccess, onFailure });

    expect(ok).toBe(true);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports mutation failure without trying to refresh the shelf', async () => {
    const error = new ApiResponseError('BAD_TITLE', 400);
    const action = vi.fn(async () => { throw error; });
    const refresh = vi.fn(async () => [book('b1')]);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    const ok = await runShelfMutation({ action, refresh, onSuccess, onFailure });

    expect(ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(error);
  });

  it('refreshes the shelf before reporting an ambiguous mutation response', async () => {
    const error = new TypeError('fetch failed');
    const refresh = vi.fn(async () => [book('b1')]);
    const onFailure = vi.fn();
    const onAmbiguousFailure = vi.fn();

    const ok = await runShelfMutation({
      action: async () => { throw error; },
      refresh,
      onSuccess: vi.fn(),
      onFailure,
      onAmbiguousFailure,
    });

    expect(ok).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onAmbiguousFailure).toHaveBeenCalledWith(error);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('refreshes the shelf after a 5xx mutation response that may follow a committed rename', async () => {
    const error = new ApiResponseError(
      'directory sync failed', 500, 'STORAGE_IO_ERROR',
    );
    const refresh = vi.fn(async () => [book('b1')]);
    const onFailure = vi.fn();
    const onAmbiguousFailure = vi.fn();

    const ok = await runShelfMutation({
      action: async () => { throw error; },
      refresh,
      onSuccess: vi.fn(),
      onFailure,
      onAmbiguousFailure,
    });

    expect(ok).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onAmbiguousFailure).toHaveBeenCalledWith(error);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('refreshes the shelf before reporting a recognized mutation conflict', async () => {
    const error = new ApiResponseError(
      'another page renamed the book', 409, 'BOOK_TITLE_CONFLICT',
    );
    const refresh = vi.fn(async () => [book('b1')]);
    const onConflictFailure = vi.fn();
    const onFailure = vi.fn();

    const ok = await runShelfMutation({
      action: async () => { throw error; },
      refresh,
      onSuccess: vi.fn(),
      onFailure,
      isConflictFailure: (failure) => failure === error,
      onConflictFailure,
    });

    expect(ok).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onConflictFailure).toHaveBeenCalledWith(error);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports when a recognized conflict cannot refresh the shelf', async () => {
    const error = new ApiResponseError(
      'another page renamed the book', 409, 'BOOK_TITLE_CONFLICT',
    );
    const onConflictRefreshFailure = vi.fn();

    await runShelfMutation({
      action: async () => { throw error; },
      refresh: async () => null,
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      isConflictFailure: (failure) => failure === error,
      onConflictRefreshFailure,
    });

    expect(onConflictRefreshFailure).toHaveBeenCalledWith(error);
  });

  it('reports unknown shelf state when ambiguous-failure refresh fails', async () => {
    const error = new SyntaxError('truncated response');
    const onAmbiguousRefreshFailure = vi.fn();

    await runShelfMutation({
      action: async () => { throw error; },
      refresh: async () => null,
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      onAmbiguousRefreshFailure,
    });

    expect(onAmbiguousRefreshFailure).toHaveBeenCalledWith(error);
  });
});

describe('shelf mutation refresh verification', () => {
  const current = [book('b1')];

  it('allows book-only mutations to reconcile when the trash refresh failed', () => {
    expect(verifiedShelfRefresh(current, {
      trashError: '回收站暂时不可用',
    })).toBe(current);
  });

  it('keeps delete and restore outcomes unconfirmed until the trash list is fresh', () => {
    expect(verifiedShelfRefresh(current, {
      requireTrash: true,
      trashError: '回收站暂时不可用',
    })).toBeNull();
    expect(verifiedShelfRefresh(current, {
      requireTrash: true,
      trashError: null,
    })).toBe(current);
  });
});

describe('persisted change refresh reporting', () => {
  it('returns null when refresh succeeds', async () => {
    await expect(refreshPersistedChange(async () => {})).resolves.toBeNull();
  });

  it('returns the refresh error without turning the persisted operation into a failure', async () => {
    const error = new Error('refresh failed');
    await expect(refreshPersistedChange(async () => { throw error; })).resolves.toBe(error);
  });
});

describe('created shelf item failure reconciliation', () => {
  it('does not refresh after an explicit server rejection', async () => {
    const refresh = vi.fn(async () => [book('old')]);
    await expect(reconcileCreatedShelfMutationFailure({
      error: new ApiResponseError('BAD_PREMISE', 400),
      expectedBookId: 'expected',
      refresh,
    })).resolves.toEqual({ status: 'explicit_failure', createdIds: [] });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('detects a committed new book after an ambiguous response failure', async () => {
    await expect(reconcileCreatedShelfMutationFailure({
      error: new TypeError('fetch failed'),
      expectedBookId: 'new-copy',
      refresh: async () => [book('old'), book('new-copy')],
    })).resolves.toEqual({ status: 'created', createdIds: ['new-copy'] });
  });

  it('detects a committed new book after an explicit 5xx response', async () => {
    await expect(reconcileCreatedShelfMutationFailure({
      error: new ApiResponseError('storage sync failed', 507, 'STORAGE_FULL'),
      expectedBookId: 'new-copy',
      refresh: async () => [book('old'), book('new-copy')],
    })).resolves.toEqual({ status: 'created', createdIds: ['new-copy'] });
  });

  it('does not mistake another tab\'s concurrently created book for this request', async () => {
    await expect(reconcileCreatedShelfMutationFailure({
      error: new SyntaxError('truncated JSON'),
      expectedBookId: 'expected-copy',
      refresh: async () => [book('old'), book('other-tab-copy')],
    })).resolves.toEqual({ status: 'not_created', createdIds: [] });
  });

  it('reports unknown state when the reconciliation refresh fails', async () => {
    await expect(reconcileCreatedShelfMutationFailure({
      error: new TypeError('fetch failed'),
      expectedBookId: 'expected-copy',
      refresh: async () => null,
    })).resolves.toEqual({ status: 'unknown', createdIds: [] });
  });
});

describe('acknowledged creation opening', () => {
  it('does not refresh the shelf when the new book opens successfully', async () => {
    const refresh = vi.fn(async () => [book('expected-copy')]);

    await expect(reconcileAcknowledgedCreationOpen({
      expectedBookId: 'expected-copy',
      open: async () => true,
      refresh,
    })).resolves.toBe('opened');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes the exact acknowledged book when automatic opening fails', async () => {
    await expect(reconcileAcknowledgedCreationOpen({
      expectedBookId: 'expected-copy',
      open: async () => false,
      refresh: async () => [book('old'), book('expected-copy')],
    })).resolves.toBe('shelf_refreshed');
  });

  it('does not treat another tab book as the acknowledged creation', async () => {
    await expect(reconcileAcknowledgedCreationOpen({
      expectedBookId: 'expected-copy',
      open: async () => { throw new Error('tree failed'); },
      refresh: async () => [book('other-tab-copy')],
    })).resolves.toBe('unavailable');
  });

  it('keeps the acknowledged creation distinct when shelf refresh also fails', async () => {
    await expect(reconcileAcknowledgedCreationOpen({
      expectedBookId: 'expected-copy',
      open: async () => false,
      refresh: async () => null,
    })).resolves.toBe('unavailable');
  });
});

describe('persisted mutation failure reconciliation', () => {
  it('does not refresh after the server explicitly rejected the mutation', async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(reconcilePersistedMutationFailure({
      error: new ApiResponseError('SECTION_CHAPTER_LIMIT', 400),
      refresh,
    })).resolves.toBe('explicit_failure');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes after an ambiguous failure before allowing a retry decision', async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(reconcilePersistedMutationFailure({
      error: new TypeError('fetch failed'),
      refresh,
    })).resolves.toBe('refreshed');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refreshes after a 5xx save response before allowing a retry decision', async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(reconcilePersistedMutationFailure({
      error: new ApiResponseError('storage sync failed', 500, 'STORAGE_IO_ERROR'),
      refresh,
    })).resolves.toBe('refreshed');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refreshes after the server recovers a previous structure transaction', async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(reconcilePersistedMutationFailure({
      error: new ApiResponseError(
        'previous structure transaction recovered', 409, 'STRUCTURE_TRANSACTION_RECOVERED',
      ),
      refresh,
    })).resolves.toBe('recovered');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refreshes after another page advances a structure anchor', async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(reconcilePersistedMutationFailure({
      error: new ApiResponseError(
        'another page added a section', 409, 'NEXT_SECTION_CONFLICT',
      ),
      refresh,
    })).resolves.toBe('conflict');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('distinguishes a structure conflict whose refresh fails', async () => {
    await expect(reconcilePersistedMutationFailure({
      error: new ApiResponseError(
        'another page added a chapter', 409, 'NEXT_CHAPTER_CONFLICT',
      ),
      refresh: async () => { throw new Error('reload failed'); },
    })).resolves.toBe('conflict_refresh_failed');
  });

  it('distinguishes a recovered structure transaction whose refresh fails', async () => {
    await expect(reconcilePersistedMutationFailure({
      error: new ApiResponseError(
        'previous structure transaction recovered', 409, 'STRUCTURE_TRANSACTION_RECOVERED',
      ),
      refresh: async () => { throw new Error('reload failed'); },
    })).resolves.toBe('recovered_refresh_failed');
  });

  it('reports unknown state when ambiguous-failure refresh also fails', async () => {
    await expect(reconcilePersistedMutationFailure({
      error: new SyntaxError('truncated response'),
      refresh: async () => { throw new Error('reload failed'); },
    })).resolves.toBe('unknown');
  });
});

describe('generation failure reconciliation', () => {
  it('refreshes the fallback selection before reporting a failure without a saved acknowledgement', async () => {
    const selection = { kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-01' } as const;
    const reload = vi.fn(async () => undefined);
    const onUnsavedFailure = vi.fn();
    const onSavedFailure = vi.fn();
    const onSavedRefreshFailure = vi.fn();

    await expect(reconcileGenerationFailure({
      message: 'LLM_STREAM_INCOMPLETE',
      savedSelection: null,
      fallbackSelection: selection,
      reload,
      onUnsavedFailure,
      onSavedFailure,
      onSavedRefreshFailure,
    })).resolves.toBe(false);

    expect(reload).toHaveBeenCalledWith(selection);
    expect(onUnsavedFailure).toHaveBeenCalledWith('LLM_STREAM_INCOMPLETE');
    expect(onSavedFailure).not.toHaveBeenCalled();
    expect(onSavedRefreshFailure).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed save state when fallback refresh also fails', async () => {
    const refreshError = new Error('TREE_RELOAD_FAILED');
    const selection = { kind: 'outline' } as const;
    const onUnsavedFailure = vi.fn();
    const onUnsavedRefreshFailure = vi.fn();

    await expect(reconcileGenerationFailure({
      message: '连接中断',
      savedSelection: null,
      fallbackSelection: selection,
      reload: async () => { throw refreshError; },
      onUnsavedFailure,
      onUnsavedRefreshFailure,
      onSavedFailure: vi.fn(),
      onSavedRefreshFailure: vi.fn(),
    })).resolves.toBe(false);

    expect(onUnsavedRefreshFailure).toHaveBeenCalledWith('连接中断', refreshError);
    expect(onUnsavedFailure).not.toHaveBeenCalled();
  });

  it('refreshes persisted content before reporting a post-save stream failure', async () => {
    const selection = { kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-01' } as const;
    const reload = vi.fn(async () => undefined);
    const onUnsavedFailure = vi.fn();
    const onSavedFailure = vi.fn();
    const onSavedRefreshFailure = vi.fn();

    await expect(reconcileGenerationFailure({
      message: '连接中断',
      savedSelection: selection,
      reload,
      onUnsavedFailure,
      onSavedFailure,
      onSavedRefreshFailure,
    })).resolves.toBe(true);

    expect(reload).toHaveBeenCalledWith(selection);
    expect(onSavedFailure).toHaveBeenCalledWith('连接中断');
    expect(onUnsavedFailure).not.toHaveBeenCalled();
    expect(onSavedRefreshFailure).not.toHaveBeenCalled();
  });

  it('distinguishes a saved response whose follow-up refresh also failed', async () => {
    const refreshError = new Error('TREE_RELOAD_FAILED');
    const selection = { kind: 'outline' } as const;
    const reload = vi.fn(async () => { throw refreshError; });
    const onUnsavedFailure = vi.fn();
    const onSavedFailure = vi.fn();
    const onSavedRefreshFailure = vi.fn();

    await expect(reconcileGenerationFailure({
      message: '连接中断',
      savedSelection: selection,
      reload,
      onUnsavedFailure,
      onSavedFailure,
      onSavedRefreshFailure,
    })).resolves.toBe(false);

    expect(onSavedRefreshFailure).toHaveBeenCalledWith('连接中断', refreshError);
    expect(onUnsavedFailure).not.toHaveBeenCalled();
    expect(onSavedFailure).not.toHaveBeenCalled();
  });
});

describe('generation completion ownership', () => {
  it('turns an automatic-title degradation into an actionable partial-success message', () => {
    expect(outlinePostprocessWarningMessage(undefined)).toBeNull();
    expect(outlinePostprocessWarningMessage(['title'])).toMatch(/大纲已保存/);
    expect(outlinePostprocessWarningMessage(['title'])).toMatch(/手动改名/);
  });

  it('turns each postprocess degradation into an actionable partial-success message', () => {
    expect(chapterPostprocessWarningMessage(undefined)).toBeNull();
    expect(chapterPostprocessWarningMessage(['digest'])).toMatch(/摘要\/剧情路标\/人物提取未完成/);
    expect(chapterPostprocessWarningMessage(['digest'])).toMatch(/下一章/);
    expect(chapterPostprocessWarningMessage(['review'])).toMatch(/自动审稿未完成/);
    expect(chapterPostprocessWarningMessage(['review'])).toMatch(/手动重试/);
    expect(chapterPostprocessWarningMessage(['digest', 'review']))
      .toMatch(/摘要\/剧情路标\/人物提取和自动审稿均未完成/);
  });

  it('requires both the current token and a still-running action', () => {
    expect(ownsActiveGeneration({ running: true, token: 2, currentToken: 2 })).toBe(true);
    expect(ownsActiveGeneration({ running: true, token: 1, currentToken: 2 })).toBe(false);
    expect(ownsActiveGeneration({ running: false, token: 2, currentToken: 2 })).toBe(false);
  });

  it('does not start a refresh for a callback invalidated before done', async () => {
    const refresh = vi.fn(async () => undefined);

    await expect(refreshOwnedGeneration({
      owns: () => false,
      refresh,
    })).resolves.toEqual({ owned: false, refreshError: null });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('drops a refresh result when stop invalidates ownership while it is pending', async () => {
    let owned = true;
    let release!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const completion = refreshOwnedGeneration({ owns: () => owned, refresh });

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    owned = false;
    release();

    await expect(completion).resolves.toEqual({ owned: false, refreshError: null });
  });

  it('preserves an owned refresh failure for an accurate post-save error', async () => {
    const refreshError = new Error('TREE_RELOAD_FAILED');

    await expect(refreshOwnedGeneration({
      owns: () => true,
      refresh: async () => { throw refreshError; },
    })).resolves.toEqual({ owned: true, refreshError });
  });

  it('refreshes the visible selection after stop even before a saved event arrived', async () => {
    const fallbackSelection = { kind: 'outline' } as const;
    const reload = vi.fn(async () => undefined);

    await expect(refreshStoppedGeneration({
      savedSelection: null,
      fallbackSelection,
      reload,
    })).resolves.toBeNull();

    expect(reload).toHaveBeenCalledWith(fallbackSelection);
  });

  it('waits for the aborted generation stream to settle before reloading disk state', async () => {
    const fallbackSelection = { kind: 'outline' } as const;
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const reload = vi.fn(async () => undefined);

    const reconciliation = refreshStoppedGeneration({
      pending,
      savedSelection: null,
      fallbackSelection,
      reload,
    });
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    settle();
    await expect(reconciliation).resolves.toBeNull();
    expect(reload).toHaveBeenCalledWith(fallbackSelection);
  });

  it('prefers the acknowledged saved chapter and reports a stop refresh failure', async () => {
    const savedSelection = {
      kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-02',
    } as const;
    const refreshError = new Error('TREE_RELOAD_FAILED');
    const reload = vi.fn(async () => { throw refreshError; });

    await expect(refreshStoppedGeneration({
      savedSelection,
      fallbackSelection: { kind: 'outline' },
      reload,
    })).resolves.toBe(refreshError);

    expect(reload).toHaveBeenCalledWith(savedSelection);
  });

  it('waits for an aborted review request to settle before checking whether it committed', async () => {
    const selection = {
      kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-02',
    } as const;
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const reload = vi.fn(async () => undefined);

    const reconciliation = refreshStoppedReview({ pending, selection, reload });
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    settle();
    await expect(reconciliation).resolves.toBeNull();
    expect(reload).toHaveBeenCalledWith(selection);
  });

  it('still refreshes after an aborted review rejects and exposes refresh failure', async () => {
    const selection = { kind: 'outline' } as const;
    const refreshError = new Error('TREE_RELOAD_FAILED');
    const reload = vi.fn(async () => { throw refreshError; });

    await expect(refreshStoppedReview({
      pending: Promise.reject(new Error('ABORTED')),
      selection,
      reload,
    })).resolves.toBe(refreshError);

    expect(reload).toHaveBeenCalledWith(selection);
  });
});

describe('section adoption', () => {
  it('reloads and finishes the flow when section adoption partially succeeded', async () => {
    const error = new Error('NETWORK_DOWN');
    const addSection = vi.fn(async (title: string) => {
      if (title === '终局') throw error;
    });
    const reload = vi.fn(async () => undefined);
    const onSuccess = vi.fn();
    const onPartialFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮', '终局'],
      addSection,
      reload,
      onSuccess,
      onPartialFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 2, total: 3, ok: false });
    expect(addSection).toHaveBeenNthCalledWith(1, '起源');
    expect(addSection).toHaveBeenNthCalledWith(2, '暗潮');
    expect(addSection).toHaveBeenNthCalledWith(3, '终局');
    expect(reload).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onPartialFailure).toHaveBeenCalledWith(2, 3, error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('keeps the adoption flow open when no section was created', async () => {
    const error = new Error('BOOK_NOT_FOUND');
    const addSection = vi.fn(async () => { throw error; });
    const reload = vi.fn(async () => undefined);
    const onSuccess = vi.fn();
    const onPartialFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮'],
      addSection,
      reload,
      onSuccess,
      onPartialFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 0, total: 2, ok: false });
    expect(reload).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onPartialFailure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(error);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('refreshes and closes the flow when the first add response is ambiguous', async () => {
    const error = new TypeError('fetch failed');
    const reload = vi.fn(async () => undefined);
    const onAmbiguousFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮'],
      addSection: async () => { throw error; },
      reload,
      onSuccess: vi.fn(),
      onPartialFailure: vi.fn(),
      isAmbiguousFailure: () => true,
      onAmbiguousFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 0, total: 2, ok: false });
    expect(reload).toHaveBeenCalledOnce();
    expect(onAmbiguousFailure).toHaveBeenCalledWith(0, 2, error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('refreshes and stops adoption when a previous structure transaction was recovered', async () => {
    const error = new ApiResponseError(
      'previous structure transaction recovered', 409, 'STRUCTURE_TRANSACTION_RECOVERED',
    );
    const reload = vi.fn(async () => undefined);
    const onRecoveredFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮'],
      addSection: async () => { throw error; },
      reload,
      onSuccess: vi.fn(),
      onPartialFailure: vi.fn(),
      isRecoveredFailure: (failure) => failure === error,
      onRecoveredFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 0, total: 2, ok: false });
    expect(reload).toHaveBeenCalledOnce();
    expect(onRecoveredFailure).toHaveBeenCalledWith(0, 2, error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('refreshes and stops adoption when another page advances the last section', async () => {
    const error = new ApiResponseError(
      'another page added a section', 409, 'NEXT_SECTION_CONFLICT',
    );
    const reload = vi.fn(async () => undefined);
    const onConflictFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮'],
      addSection: async () => { throw error; },
      reload,
      onSuccess: vi.fn(),
      onPartialFailure: vi.fn(),
      isConflictFailure: (failure) => failure === error,
      onConflictFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 0, total: 2, ok: false });
    expect(reload).toHaveBeenCalledOnce();
    expect(onConflictFailure).toHaveBeenCalledWith(0, 2, error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('finishes the flow when sections were created but the refresh failed', async () => {
    const error = new Error('TREE_RELOAD_FAILED');
    const addSection = vi.fn(async () => undefined);
    const reload = vi.fn(async () => { throw error; });
    const onSuccess = vi.fn();
    const onPartialFailure = vi.fn();
    const onRefreshFailure = vi.fn();
    const onFailure = vi.fn();
    const onFinish = vi.fn();

    const result = await adoptSectionTitles({
      titles: ['起源', '暗潮'],
      addSection,
      reload,
      onSuccess,
      onPartialFailure,
      onRefreshFailure,
      onFailure,
      onFinish,
    });

    expect(result).toEqual({ created: 2, total: 2, ok: false });
    expect(reload).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onPartialFailure).not.toHaveBeenCalled();
    expect(onRefreshFailure).toHaveBeenCalledWith(2, 2, error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('ignores concurrent adoption while another adoption is running', async () => {
    let locked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => {
      await gate;
      return 'created';
    });
    const setRunning = vi.fn((next: boolean) => { locked = next; });

    const first = runExclusiveSectionAdoption({
      isRunning: () => locked,
      setRunning,
      task,
    });
    const second = await runExclusiveSectionAdoption({
      isRunning: () => locked,
      setRunning,
      task,
    });

    expect(second).toBeNull();
    expect(task).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe('created');
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(locked).toBe(false);
  });
});

describe('book structure mutations', () => {
  it('disables the sidebar while streaming or mutating the book structure', () => {
    expect(shouldDisableSidebar({ streaming: true, structureMutating: false })).toBe(true);
    expect(shouldDisableSidebar({ streaming: false, structureMutating: true })).toBe(true);
    expect(shouldDisableSidebar({ streaming: false, structureMutating: false })).toBe(false);
    expect(shouldDisableSidebar({ streaming: false, structureMutating: false, reviewing: true })).toBe(true);
    expect(shouldDisableSidebar({ streaming: false, structureMutating: false, versionMutating: true })).toBe(true);
    expect(shouldDisableSidebar({ streaming: false, structureMutating: false, planAdopting: true })).toBe(true);
  });

  it('ignores concurrent structure mutations while one is running', async () => {
    let locked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => {
      await gate;
      return 'section-created';
    });
    const setRunning = vi.fn((next: boolean) => { locked = next; });

    const first = runExclusiveStructureMutation({
      isRunning: () => locked,
      setRunning,
      task,
    });
    const second = await runExclusiveStructureMutation({
      isRunning: () => locked,
      setRunning,
      task,
    });

    expect(second).toBeNull();
    expect(task).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe('section-created');
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(locked).toBe(false);
  });
});

describe('version mutations', () => {
  it('refreshes server state after an explicit version conflict without treating it as ambiguous', async () => {
    const refresh = vi.fn(async () => {});
    const onRefreshed = vi.fn();
    const onRefreshFailure = vi.fn();
    const conflict = new ApiResponseError(
      '服务器内容已更新', 409, 'VERSION_CONFLICT',
    );

    await expect(reconcileVersionConflict({
      error: conflict,
      refresh,
      onRefreshed,
      onRefreshFailure,
    })).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onRefreshed).toHaveBeenCalledOnce();
    expect(onRefreshFailure).not.toHaveBeenCalled();

    await expect(reconcileVersionConflict({
      error: new ApiResponseError('BAD_TEXT', 400, 'BAD_TEXT'),
      refresh,
      onRefreshed,
      onRefreshFailure,
    })).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('disables versioned boxes while streaming or mutating a versioned field', () => {
    expect(shouldDisableVersionedBox({ streaming: true, versionMutating: false })).toBe(true);
    expect(shouldDisableVersionedBox({ streaming: false, versionMutating: true })).toBe(true);
    expect(shouldDisableVersionedBox({ streaming: false, versionMutating: false })).toBe(false);
    expect(shouldDisableVersionedBox({ streaming: false, versionMutating: false, reviewing: true })).toBe(true);
    expect(shouldDisableVersionedBox({ streaming: false, versionMutating: false, structureMutating: true })).toBe(true);
    expect(shouldDisableVersionedBox({ streaming: false, versionMutating: false, planAdopting: true })).toBe(true);
  });

  it('ignores concurrent version mutations while one is running', async () => {
    let locked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => {
      await gate;
      return 'saved';
    });
    const setRunning = vi.fn((next: boolean) => { locked = next; });

    const first = runExclusiveVersionMutation({
      isRunning: () => locked,
      setRunning,
      task,
    });
    const second = await runExclusiveVersionMutation({
      isRunning: () => locked,
      setRunning,
      task,
    });

    expect(second).toBeNull();
    expect(task).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe('saved');
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(locked).toBe(false);
  });
});
