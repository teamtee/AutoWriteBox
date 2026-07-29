import { useEffect, useRef, useState } from 'react';
import type { Book, BookTree } from './types';
import type { Selection } from './store';
import { firstSelectable } from './store';
import * as api from './api';
import { Sidebar } from './components/Sidebar';
import { MainPanel } from './components/MainPanel';
import { Actions } from './components/Actions';
import { SettingsPage } from './components/SettingsPage';
import { FirstRun } from './components/FirstRun';

export default function App() {
  const [tree, setTree] = useState<BookTree | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'outline' });
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const abortRef = useRef<null | (() => void)>(null);

  // 启动：若已有书则载入第一本，否则显示开篇
  useEffect(() => {
    api.listBooks().then(async (list) => {
      if (list.length) { const t = await api.getTree(list[0].id); setTree(t); setSelection(firstSelectable(t)); }
    });
  }, []);

  const reload = async (bookId: string, sel?: Selection) => {
    const t = await api.getTree(bookId);
    setTree(t);
    if (sel) setSelection(sel);
  };

  if (showSettings) return <SettingsPage onClose={() => setShowSettings(false)} />;
  if (!tree) return <FirstRun onCreated={async (b: Book) => { await reload(b.id, { kind: 'outline' }); }} />;

  const bookId = tree.book.id;

  const runChapter = (mode: 'next' | 'rewrite' | 'whip', whip?: string) => {
    const sel = selection;
    const sectionId = sel.kind === 'chapter' ? sel.sectionId : tree.sections[0]?.id;
    if (!sectionId) { alert('请先新建一个部'); return; }
    const chapterId = sel.kind === 'chapter' ? sel.chapterId : undefined;
    setStreaming(true); setStreamingText('');
    abortRef.current = api.streamGen('/api/gen/chapter',
      { bookId, sectionId, chapterId, mode, whip },
      {
        onDelta: (d) => setStreamingText((t) => t + d),
        onError: (m) => { alert('生成失败：' + m); setStreaming(false); },
        onDone: async (e) => {
          setStreaming(false);
          await reload(bookId, { kind: 'chapter', sectionId, chapterId: e.chapterId ?? chapterId! });
        },
      });
  };

  const runOutline = () => {
    setStreaming(true); setStreamingText('');
    abortRef.current = api.streamGen('/api/gen/outline', { bookId }, {
      onDelta: (d) => setStreamingText((t) => t + d),
      onError: (m) => { alert('生成失败：' + m); setStreaming(false); },
      onDone: async () => { setStreaming(false); await reload(bookId, { kind: 'outline' }); },
    });
  };

  const runSections = () => {
    setStreaming(true); setStreamingText('');
    abortRef.current = api.streamGen('/api/gen/sections', { bookId }, {
      onDelta: (d) => setStreamingText((t) => t + d),
      onError: (m) => { alert('生成失败：' + m); setStreaming(false); },
      onDone: (e) => {
        setStreaming(false);
        alert('分部建议：\n' + (e.sections || ''));
      },
    });
  };

  return (
    <div className="layout">
      <Sidebar tree={tree} selection={selection}
        onSelect={setSelection}
        onAddSection={async () => { await api.addSection(bookId); await reload(bookId); }}
        onAddChapter={async (sid) => { const c = await api.addChapter(bookId, sid); await reload(bookId, { kind: 'chapter', sectionId: sid, chapterId: c.id }); }}
        onOpenSettings={() => setShowSettings(true)}
        onPlanSections={runSections} />
      <div className="content">
        <MainPanel tree={tree} selection={selection} streaming={streaming} streamingText={streamingText}
          onSaveChapter={async (content) => {
            if (selection.kind === 'chapter') { await api.saveChapter(bookId, selection.sectionId, selection.chapterId, content); await reload(bookId); }
          }}
          onRollback={async () => {
            if (selection.kind === 'chapter') { await api.rollbackChapter(bookId, selection.sectionId, selection.chapterId); await reload(bookId); }
          }}
          onSaveCore={async (core) => { await api.saveCore(bookId, core); await reload(bookId); }} />
        <Actions streaming={streaming}
          onRewrite={() => {
            if (selection.kind === 'outline') runOutline();
            else if (selection.kind === 'chapter') runChapter('rewrite');
            // core：忽略（core 用它自己的保存表单）
          }}
          onNext={() => runChapter('next')}
          onWhip={(t) => runChapter('whip', t)}
          onStop={() => { abortRef.current?.(); setStreaming(false); }} />
      </div>
    </div>
  );
}
