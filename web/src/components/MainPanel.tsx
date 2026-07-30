import { useEffect, useState } from 'react';
import type { BookTree, CoreSettings } from '../types';
import type { Selection } from '../store';
import { findChapter } from '../store';

export function MainPanel({ tree, selection, streamingText, streaming, onSaveChapter, onRollback, onSaveCore }: {
  tree: BookTree; selection: Selection;
  streamingText: string; streaming: boolean;
  onSaveChapter: (content: string) => void;
  onRollback: () => void;
  onSaveCore: (core: CoreSettings) => void;
}) {
  const chapter = findChapter(tree, selection);
  const [draft, setDraft] = useState('');
  useEffect(() => { setDraft(chapter?.content ?? ''); }, [chapter?.id, chapter?.content]);

  if (selection.kind === 'core') return <CoreEditor core={tree.book.settings.core} onSave={onSaveCore} />;

  if (selection.kind === 'outline') {
    const body = streaming ? streamingText : tree.book.outline.content;
    return (
      <main className="main">
        <article className="paper sketch">
          <h2 className="paper-title">全书大纲</h2>
          {body
            ? <pre>{body}{streaming && <span className="cursor">▎</span>}</pre>
            : <div className="empty-hint">尚未生成。点下方 <b>🔄 重写</b> 让 AI 起草全书大纲。</div>}
        </article>
      </main>
    );
  }

  // chapter
  if (!chapter) {
    return (
      <main className="main">
        <div className="empty-hint big">
          还没有章节。点左侧 <b>＋ 新建部</b> 或 <b>🧩 AI 规划分部</b> 开始，再 <b>＋ 加章</b>。
        </div>
      </main>
    );
  }
  const text = streaming ? streamingText : draft;
  return (
    <main className="main">
      <article className="paper sketch">
        <div className="paper-head">
          <h2 className="paper-title">{chapter.title}</h2>
          {chapter.history.length > 0 && !streaming &&
            <button className="hbtn mini" onClick={onRollback}>↩ 上一版</button>}
        </div>
        {streaming
          ? <pre>{text}<span className="cursor">▎</span></pre>
          : <textarea className="editor" value={text}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { if (draft !== chapter.content) onSaveChapter(draft); }} />}
      </article>
    </main>
  );
}

function CoreEditor({ core, onSave }: { core: CoreSettings; onSave: (core: CoreSettings) => void }) {
  const [world, setWorld] = useState('');
  const [style, setStyle] = useState('');
  const [constraints, setConstraints] = useState('');
  const [pacing, setPacing] = useState('');
  useEffect(() => {
    setWorld(core?.world ?? '');
    setStyle(core?.style ?? '');
    setConstraints(core?.constraints ?? '');
    setPacing(core?.pacing ?? '');
  }, [core?.world, core?.style, core?.constraints, core?.pacing]);

  return (
    <main className="main">
      <article className="paper sketch">
        <h2 className="paper-title">核心设定</h2>
        <div className="core-form">
          <label>世界观<textarea value={world} onChange={(e) => setWorld(e.target.value)} rows={4} /></label>
          <label>文风基调<textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={3} /></label>
          <label>禁忌约束<textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} rows={3} /></label>
          <label>篇幅节奏<textarea value={pacing} onChange={(e) => setPacing(e.target.value)} rows={3} /></label>
          <button className="hbtn accent-2" onClick={() => onSave({ world, style, constraints, pacing })}>保存设定</button>
        </div>
      </article>
    </main>
  );
}
