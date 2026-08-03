import { useEffect, useRef, useState } from 'react';
import type { Book, BookTree, BookSummary } from './types';
import type { Selection } from './store';
import { firstSelectable } from './store';
import * as api from './api';
import { useToast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { MainPanel } from './components/MainPanel';
import { Actions } from './components/Actions';
import { SettingsPage } from './components/SettingsPage';
import { FirstRun } from './components/FirstRun';
import { SectionPlanPanel } from './components/SectionPlanPanel';
import { Bookshelf } from './components/Bookshelf';
import { runExclusiveAction } from './asyncAction';

// 顶层视图：书架 / 单本书
type View = 'shelf' | 'book';
export { runExclusiveAction as runExclusiveSectionAdoption } from './asyncAction';

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function loadShelfBooks(
  listBooks: () => Promise<BookSummary[]>,
  setBooks: (books: BookSummary[]) => void,
  setShelfError: (message: string | null) => void,
  onError?: (message: string) => void,
) {
  try {
    const list = await listBooks();
    setBooks(list);
    setShelfError(null);
    return list;
  } catch (e) {
    const message = messageOf(e);
    setShelfError(message);
    onError?.(message);
    return null;
  }
}

export function shouldShowFirstRun({ creating, books, shelfError }: {
  creating: boolean;
  books: BookSummary[];
  shelfError: string | null;
}) {
  return creating || (!shelfError && books.length === 0);
}

export async function runShelfMutation({
  action,
  refresh,
  onSuccess,
  onFailure,
}: {
  action: () => Promise<unknown>;
  refresh: () => Promise<BookSummary[] | null>;
  onSuccess: () => void;
  onFailure: (e: unknown) => void;
}) {
  try {
    await action();
    const refreshed = await refresh();
    if (!refreshed) return false;
    onSuccess();
    return true;
  } catch (e) {
    onFailure(e);
    return false;
  }
}

export async function adoptSectionTitles({
  titles,
  addSection,
  reload,
  onSuccess,
  onPartialFailure,
  onRefreshFailure,
  onFailure,
  onFinish,
}: {
  titles: string[];
  addSection: (title: string) => Promise<unknown>;
  reload: () => Promise<void>;
  onSuccess: (created: number) => void;
  onPartialFailure: (created: number, total: number, e: unknown) => void;
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
  if (created === 0 && addError) {
    onFailure(addError);
    return { created, total: titles.length, ok: false };
  }
  try {
    await reload();
  } catch (e) {
    onRefreshFailure?.(created, titles.length, e);
    onFinish();
    return { created, total: titles.length, ok: false };
  }
  if (addError) {
    onPartialFailure(created, titles.length, addError);
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
  const [creating, setCreating] = useState(false);
  const [tree, setTree] = useState<BookTree | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'outline' });
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  // 当前流式的分派路径；章节任意生成统一为 'chapter' 哨兵
  const [streamingPath, setStreamingPath] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planText, setPlanText] = useState('');
  const [planAdopting, setPlanAdopting] = useState(false);
  const abortRef = useRef<null | (() => void)>(null);
  const planAdoptingRef = useRef(false);

  // 拉取书架列表
  const loadShelf = async () => loadShelfBooks(
    api.listBooks,
    setBooks,
    setShelfError,
    (message) => toast.error('加载书架失败：' + message),
  );
  useEffect(() => { loadShelf().finally(() => setLoading(false)); }, []);

  const openBook = async (id: string) => {
    try {
      const t = await api.getTree(id); setTree(t); setSelection(firstSelectable(t)); setView('book');
    } catch (e) { toast.error('打开失败：' + messageOf(e)); }
  };
  const reload = async (bookId: string, sel?: Selection) => {
    const t = await api.getTree(bookId); setTree(t); if (sel) setSelection(sel);
  };
  // 返回书架前先停掉任意进行中的流，避免离开后仍有 SSE 回调改状态
  const goShelf = async () => { if (streaming) stopGen(); setCreating(false); setView('shelf'); await loadShelf(); };

  if (showSettings) return <SettingsPage onClose={() => setShowSettings(false)} />;
  if (loading) return <div className="boot-skeleton"><div className="sk-line" /><div className="sk-line" /><div className="sk-line short" /></div>;

  // 书架视图：空书架或点了「新建」都落到 FirstRun
  if (view === 'shelf') {
    if (shelfError && !creating) {
      return <div className="empty-hint big">
        <h1>书架加载失败</h1>
        <p>无法确认当前是否已有作品，请重试后再新建。</p>
        <button className="hbtn" onClick={() => { void loadShelf(); }}>重试</button>
      </div>;
    }
    if (shouldShowFirstRun({ creating, books, shelfError })) {
      return <FirstRun onCreated={async (b: Book) => { setCreating(false); await openBook(b.id); }} />;
    }
    return <Bookshelf books={books}
      onOpen={openBook}
      onNew={() => setCreating(true)}
      onRename={async (id, title) => {
        await runShelfMutation({
          action: () => api.renameBook(id, title),
          refresh: loadShelf,
          onSuccess: () => toast.success('✓ 已改名'),
          onFailure: (e) => toast.error('改名失败：' + messageOf(e)),
        });
      }}
      onDelete={async (id) => {
        await runShelfMutation({
          action: () => api.deleteBook(id),
          refresh: loadShelf,
          onSuccess: () => toast.success('✓ 已删除'),
          onFailure: (e) => toast.error('删除失败：' + messageOf(e)),
        });
      }} />;
  }

  if (!tree) return <div className="boot-skeleton"><div className="sk-line" /></div>;
  const bookId = tree.book.id;

  // —— 统一版本操作 ——
  const doMove = async (path: string, delta: number) => {
    try { await api.versionMove(bookId, path, delta); await reload(bookId); }
    catch (e) { toast.error('切换版本失败：' + messageOf(e)); }
  };
  const doClear = async (path: string) => {
    try { await api.versionClear(bookId, path); await reload(bookId); toast.info('已清空（可用「上一个」找回）'); }
    catch (e) { toast.error('清空失败：' + messageOf(e)); }
  };
  const doSave = async (path: string, text: string) => {
    try { await api.versionSave(bookId, path, text); await reload(bookId); toast.success('✓ 已保存'); }
    catch (e) { toast.error('保存失败：' + messageOf(e)); }
  };

  // 状态文案：按 path 前缀区分
  const stageFor = (path: string) =>
    path === 'outline' ? '✍️ 正在重写全书大纲…' : path.startsWith('core:') ? '✍️ 正在重写设定…' : '✍️ 正在重写本章…';

  // 重写分派：章节走 gen/chapter（mode=rewrite）；outline/core 走 version/rewrite
  const doRewrite = (path: string) => {
    const isChapter = path.startsWith('section:');
    setStreaming(true); setStreamingText(''); setStatusText(stageFor(path));
    if (isChapter) {
      setStreamingPath('chapter');
      const [, sectionId, , chapterId] = path.split(':');
      abortRef.current = api.streamGen('/api/gen/chapter', { bookId, sectionId, chapterId, mode: 'rewrite' }, {
        onDelta: (d) => setStreamingText((t) => t + d),
        onError: (m) => { setStreaming(false); setStreamingPath(null); setStatusText(''); toast.error('生成失败：' + m); },
        onDone: async () => { setStreaming(false); setStreamingPath(null); setStatusText(''); await reload(bookId, selection); toast.success('✓ 已重写'); },
      });
    } else {
      setStreamingPath(path);
      abortRef.current = api.streamGen(api.rewriteUrl(bookId), { path }, {
        onDelta: (d) => setStreamingText((t) => t + d),
        onError: (m) => { setStreaming(false); setStreamingPath(null); setStatusText(''); toast.error('生成失败：' + m); },
        onDone: async () => { setStreaming(false); setStreamingPath(null); setStatusText(''); await reload(bookId, selection); toast.success('✓ 已重写'); },
      });
    }
  };

  // —— 章节推进（下一章 / 抽打）——
  const runChapter = (mode: 'next' | 'whip', whip?: string) => {
    const sectionId = selection.kind === 'chapter' ? selection.sectionId : tree.sections[0]?.id;
    if (!sectionId) { toast.error('请先新建一个部'); return; }
    const chapterId = selection.kind === 'chapter' ? selection.chapterId : undefined;
    setStreaming(true); setStreamingText(''); setStreamingPath('chapter');
    setStatusText(mode === 'whip' ? '🗯️ 正在按你的要求重写…' : '✍️ 正在写下一章…');
    abortRef.current = api.streamGen('/api/gen/chapter', { bookId, sectionId, chapterId, mode, whip }, {
      onDelta: (d) => setStreamingText((t) => t + d),
      onError: (m) => { setStreaming(false); setStreamingPath(null); setStatusText(''); toast.error('生成失败：' + m); },
      onDone: async (e) => {
        setStreaming(false); setStreamingPath(null); setStatusText('');
        await reload(bookId, { kind: 'chapter', sectionId, chapterId: e.chapterId ?? chapterId! });
        toast.success('✓ 本章完成');
      },
    });
  };

  // AI 规划分部
  const runSections = () => {
    setPlanOpen(true); setPlanText(''); setStreaming(true); setStatusText('🧩 正在规划分部…');
    abortRef.current = api.streamGen('/api/gen/sections', { bookId }, {
      onDelta: (d) => setPlanText((t) => t + d),
      onError: (m) => { setStreaming(false); setStatusText(''); toast.error('规划失败：' + m); },
      onDone: (e) => { setStreaming(false); setStatusText(''); if (e.sections) setPlanText(e.sections); },
    });
  };
  const adoptSections = async (titles: string[]) => {
    await runExclusiveAction({
      isRunning: () => planAdoptingRef.current,
      setRunning: (running) => { planAdoptingRef.current = running; setPlanAdopting(running); },
      task: () => adoptSectionTitles({
        titles,
        addSection: (title) => api.addSection(bookId, title, 'ai'),
        reload: () => reload(bookId),
        onSuccess: (created) => toast.success(`✓ 已创建 ${created} 个部`),
        onPartialFailure: (created, total, e) => toast.error(`采纳分部部分成功：已创建 ${created}/${total} 个，后续失败：${messageOf(e)}`),
        onRefreshFailure: (created, total, e) => toast.error(`采纳分部已创建 ${created}/${total} 个，但刷新失败：${messageOf(e)}`),
        onFailure: (e) => toast.error('采纳分部失败：' + messageOf(e)),
        onFinish: () => setPlanOpen(false),
      }),
    });
  };
  const stopGen = () => { abortRef.current?.(); setStreaming(false); setStreamingPath(null); setStatusText(''); };

  return (
    <div className="app">
      <TopBar title={tree.book.title} streaming={streaming} statusText={statusText}
        onOpenSettings={() => setShowSettings(true)} onHome={goShelf} />
      <div className="body">
        <Sidebar tree={tree} selection={selection} disabled={streaming}
          onSelect={setSelection}
          onAddSection={async () => {
            try { await api.addSection(bookId); await reload(bookId); }
            catch (e) { toast.error('新建部失败：' + messageOf(e)); }
          }}
          onAddChapter={async (sid) => {
            try {
              const c = await api.addChapter(bookId, sid);
              await reload(bookId, { kind: 'chapter', sectionId: sid, chapterId: c.id });
            } catch (e) { toast.error('新建章失败：' + messageOf(e)); }
          }}
          onPlanSections={runSections} />
        <div className="content">
          <MainPanel tree={tree} selection={selection}
            streaming={streaming} streamingText={streamingText} streamingPath={streamingPath}
            onMove={doMove} onRewrite={doRewrite} onClear={doClear} onSave={doSave} onStop={stopGen} />
          {/* 流式期间由 VersionedBox 工具条负责 Stop，Actions 隐藏避免双 Stop 按钮 */}
          {selection.kind === 'chapter' && !streaming &&
            <Actions streaming={streaming} onNext={() => runChapter('next')} onWhip={(t) => runChapter('whip', t)} onStop={stopGen} />}
        </div>
      </div>
      {planOpen && <SectionPlanPanel text={planText} streaming={streaming} adopting={planAdopting}
        onAdopt={adoptSections} onClose={() => { if (streaming) stopGen(); setPlanOpen(false); }} />}
    </div>
  );
}
