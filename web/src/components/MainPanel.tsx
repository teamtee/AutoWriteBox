import { useEffect, useState } from 'react';
import type { BookTree } from '../types';
import type { Selection } from '../store';
import { findChapter } from '../store';

export function MainPanel({ tree, selection, streamingText, streaming, onSaveChapter, onRollback }: {
  tree: BookTree; selection: Selection;
  streamingText: string; streaming: boolean;
  onSaveChapter: (content: string) => void;
  onRollback: () => void;
}) {
  const chapter = findChapter(tree, selection);
  const [draft, setDraft] = useState('');
  useEffect(() => { setDraft(chapter?.content ?? ''); }, [chapter?.id, chapter?.content]);

  if (selection.kind === 'outline') return <main className="main"><h2>全书大纲</h2><pre>{tree.book.outline.content || '（尚未生成）'}</pre></main>;
  if (selection.kind === 'core') return <main className="main"><h2>核心设定</h2><pre>{JSON.stringify(tree.book.settings.core, null, 2)}</pre></main>;

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
