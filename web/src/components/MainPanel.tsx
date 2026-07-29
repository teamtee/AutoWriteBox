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

  if (selection.kind === 'outline') return <main className="main"><h2>全书大纲</h2><pre>{tree.book.outline.content || '（尚未生成）'}</pre></main>;
  if (selection.kind === 'core') return <CoreEditor core={tree.book.settings.core} onSave={onSaveCore} />;

  const text = streaming ? streamingText : draft;
  return (
    <main className="main">
      <div className="main-head">
        <h2>{chapter?.title}</h2>
        {chapter && chapter.history.length > 0 && !streaming &&
          <button className="mini" onClick={onRollback}>↩ 上一版</button>}
      </div>
      <textarea className="editor" value={text} readOnly={streaming}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (!streaming && draft !== chapter?.content) onSaveChapter(draft); }} />
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
      <h2>核心设定</h2>
      <div className="core-form">
        <label>世界观
          <textarea value={world} onChange={(e) => setWorld(e.target.value)} rows={4} />
        </label>
        <label>文风基调
          <textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={3} />
        </label>
        <label>禁忌约束
          <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} rows={3} />
        </label>
        <label>篇幅节奏
          <textarea value={pacing} onChange={(e) => setPacing(e.target.value)} rows={3} />
        </label>
        <button onClick={() => onSave({ world, style, constraints, pacing })}>保存</button>
      </div>
    </main>
  );
}
