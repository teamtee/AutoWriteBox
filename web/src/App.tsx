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

// 顶层视图：书架 / 单本书
type View = 'shelf' | 'book';

export default function App() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('shelf');
  const [books, setBooks] = useState<BookSummary[]>([]);
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
  const abortRef = useRef<null | (() => void)>(null);

  // 拉取书架列表
  const loadShelf = async () => { const list = await api.listBooks(); setBooks(list); return list; };
  useEffect(() => { loadShelf().finally(() => setLoading(false)); }, []);

  const openBook = async (id: string) => {
    const t = await api.getTree(id); setTree(t); setSelection(firstSelectable(t)); setView('book');
  };
  const reload = async (bookId: string, sel?: Selection) => {
    const t = await api.getTree(bookId); setTree(t); if (sel) setSelection(sel);
  };
  const goShelf = async () => { setView('shelf'); await loadShelf(); };

  if (showSettings) return <SettingsPage onClose={() => setShowSettings(false)} />;
  if (loading) return <div className="boot-skeleton"><div className="sk-line" /><div className="sk-line" /><div className="sk-line short" /></div>;

  // 书架视图：空书架或点了「新建」都落到 FirstRun
  if (view === 'shelf') {
    if (creating || books.length === 0) {
      return <FirstRun onCreated={async (b: Book) => { setCreating(false); await openBook(b.id); }} />;
    }
    return <Bookshelf books={books}
      onOpen={openBook}
      onNew={() => setCreating(true)}
      onRename={async (id, title) => { await api.renameBook(id, title); await loadShelf(); toast.success('✓ 已改名'); }}
      onDelete={async (id) => { await api.deleteBook(id); await loadShelf(); toast.success('✓ 已删除'); }} />;
  }

  if (!tree) return <div className="boot-skeleton"><div className="sk-line" /></div>;
  const bookId = tree.book.id;

  // —— 统一版本操作 ——
  const doMove = async (path: string, delta: number) => { await api.versionMove(bookId, path, delta); await reload(bookId); };
  const doClear = async (path: string) => { await api.versionClear(bookId, path); await reload(bookId); toast.info('已清空（可用「上一个」找回）'); };
  const doSave = async (path: string, text: string) => { await api.versionSave(bookId, path, text); await reload(bookId); toast.success('✓ 已保存'); };

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
    setPlanOpen(false);
    for (const t of titles) await api.addSection(bookId, t);
    await reload(bookId); toast.success(`✓ 已创建 ${titles.length} 个部`);
  };
  const stopGen = () => { abortRef.current?.(); setStreaming(false); setStreamingPath(null); setStatusText(''); };

  return (
    <div className="app">
      <TopBar title={tree.book.title} streaming={streaming} statusText={statusText}
        onOpenSettings={() => setShowSettings(true)} onHome={goShelf} />
      <div className="body">
        <Sidebar tree={tree} selection={selection} disabled={streaming}
          onSelect={setSelection}
          onAddSection={async () => { await api.addSection(bookId); await reload(bookId); }}
          onAddChapter={async (sid) => { const c = await api.addChapter(bookId, sid); await reload(bookId, { kind: 'chapter', sectionId: sid, chapterId: c.id }); }}
          onPlanSections={runSections} />
        <div className="content">
          <MainPanel tree={tree} selection={selection}
            streaming={streaming} streamingText={streamingText} streamingPath={streamingPath}
            onMove={doMove} onRewrite={doRewrite} onClear={doClear} onSave={doSave} onStop={stopGen} />
          {selection.kind === 'chapter' &&
            <Actions streaming={streaming} onNext={() => runChapter('next')} onWhip={(t) => runChapter('whip', t)} onStop={stopGen} />}
        </div>
      </div>
      {planOpen && <SectionPlanPanel text={planText} streaming={streaming}
        onAdopt={adoptSections} onClose={() => { if (streaming) stopGen(); setPlanOpen(false); }} />}
    </div>
  );
}
