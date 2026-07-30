import { useEffect, useRef, useState } from 'react';
import type { Book, BookTree } from './types';
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

export default function App() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState<BookTree | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'outline' });
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [statusText, setStatusText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planText, setPlanText] = useState('');
  const abortRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    api.listBooks().then(async (list) => {
      if (list.length) { const t = await api.getTree(list[0].id); setTree(t); setSelection(firstSelectable(t)); }
    }).finally(() => setLoading(false));
  }, []);

  const reload = async (bookId: string, sel?: Selection) => {
    const t = await api.getTree(bookId);
    setTree(t);
    if (sel) setSelection(sel);
  };

  if (showSettings) return <SettingsPage onClose={() => setShowSettings(false)} />;
  if (loading) return <div className="boot-skeleton"><div className="sk-line" /><div className="sk-line" /><div className="sk-line short" /></div>;
  if (!tree) return <FirstRun onCreated={async (b: Book) => { await reload(b.id, { kind: 'outline' }); }} />;

  const bookId = tree.book.id;

  const runChapter = (mode: 'next' | 'rewrite' | 'whip', whip?: string) => {
    const sel = selection;
    const sectionId = sel.kind === 'chapter' ? sel.sectionId : tree.sections[0]?.id;
    if (!sectionId) { toast.error('请先新建一个部'); return; }
    const chapterId = sel.kind === 'chapter' ? sel.chapterId : undefined;
    const stage = mode === 'whip' ? '🗯️ 正在按你的要求重写…' : mode === 'rewrite' ? '✍️ 正在重写本章…' : '✍️ 正在写下一章…';
    setStreaming(true); setStreamingText(''); setStatusText(stage);
    abortRef.current = api.streamGen('/api/gen/chapter',
      { bookId, sectionId, chapterId, mode, whip },
      {
        onDelta: (d) => setStreamingText((t) => t + d),
        onError: (m) => { setStreaming(false); setStatusText(''); toast.error('生成失败：' + m); },
        onDone: async (e) => {
          setStreaming(false); setStatusText('');
          await reload(bookId, { kind: 'chapter', sectionId, chapterId: e.chapterId ?? chapterId! });
          toast.success('✓ 本章完成');
        },
      });
  };

  const runOutline = () => {
    setStreaming(true); setStreamingText(''); setStatusText('✍️ 正在构思全书大纲…');
    abortRef.current = api.streamGen('/api/gen/outline', { bookId }, {
      onDelta: (d) => setStreamingText((t) => t + d),
      onError: (m) => { setStreaming(false); setStatusText(''); toast.error('生成失败：' + m); },
      onDone: async () => { setStreaming(false); setStatusText(''); await reload(bookId, { kind: 'outline' }); toast.success('✓ 大纲已生成'); },
    });
  };

  const runSections = () => {
    setPlanOpen(true); setPlanText('');
    setStreaming(true); setStatusText('🧩 正在规划分部…');
    abortRef.current = api.streamGen('/api/gen/sections', { bookId }, {
      onDelta: (d) => setPlanText((t) => t + d),
      onError: (m) => { setStreaming(false); setStatusText(''); toast.error('规划失败：' + m); },
      onDone: (e) => { setStreaming(false); setStatusText(''); if (e.sections) setPlanText(e.sections); },
    });
  };

  const adoptSections = async (titles: string[]) => {
    setPlanOpen(false);
    for (const t of titles) await api.addSection(bookId, t);
    await reload(bookId);
    toast.success(`✓ 已创建 ${titles.length} 个部`);
  };

  const stopGen = () => { abortRef.current?.(); setStreaming(false); setStatusText(''); };

  return (
    <div className="app">
      <TopBar title={tree.book.title} streaming={streaming} statusText={statusText}
        onOpenSettings={() => setShowSettings(true)} />
      <div className="body">
        <Sidebar tree={tree} selection={selection} disabled={streaming}
          onSelect={setSelection}
          onAddSection={async () => { await api.addSection(bookId); await reload(bookId); }}
          onAddChapter={async (sid) => { const c = await api.addChapter(bookId, sid); await reload(bookId, { kind: 'chapter', sectionId: sid, chapterId: c.id }); }}
          onPlanSections={runSections} />
        <div className="content">
          <MainPanel tree={tree} selection={selection} streaming={streaming} streamingText={streamingText}
            onSaveChapter={async (content) => {
              if (selection.kind === 'chapter') { await api.saveChapter(bookId, selection.sectionId, selection.chapterId, content); await reload(bookId); toast.success('✓ 已保存'); }
            }}
            onRollback={async () => {
              if (selection.kind === 'chapter') { await api.rollbackChapter(bookId, selection.sectionId, selection.chapterId); await reload(bookId); toast.info('已回到上一版'); }
            }}
            onSaveCore={async (core) => { await api.saveCore(bookId, core); await reload(bookId); toast.success('✓ 设定已保存'); }} />
          <Actions streaming={streaming}
            onRewrite={() => {
              if (selection.kind === 'outline') runOutline();
              else if (selection.kind === 'chapter') runChapter('rewrite');
            }}
            onNext={() => runChapter('next')}
            onWhip={(t) => runChapter('whip', t)}
            onStop={stopGen} />
        </div>
      </div>
      {planOpen && <SectionPlanPanel text={planText} streaming={streaming}
        onAdopt={adoptSections} onClose={() => { if (streaming) stopGen(); setPlanOpen(false); }} />}
    </div>
  );
}
