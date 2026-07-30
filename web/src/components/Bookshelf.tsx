import { useState } from 'react';
import type { BookSummary } from '../types';
import { bookSpineColor } from '../versioned';

// 书架组件：微信读书风格的卡片概览，支持新建 / 打开 / 内联改名 / 两步删除
export function Bookshelf({ books, onOpen, onNew, onRename, onDelete }: {
  books: BookSummary[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  // 当前进入改名态的书 id
  const [renaming, setRenaming] = useState<string | null>(null);
  // 改名输入草稿
  const [draft, setDraft] = useState('');
  // 当前进入删除确认态的书 id
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  return (
    <div className="shelf">
      <h1 className="shelf-title">📚 我的书架</h1>
      <div className="shelf-grid">
        <button className="shelf-card new sketch" onClick={onNew}>＋ 新建一本</button>
        {books.map((b) => (
          <div key={b.id} className="shelf-card sketch">
            <div className="spine" style={{ background: bookSpineColor(b.id) }} />
            {renaming === b.id ? (
              <input className="shelf-rename" autoFocus value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { onRename(b.id, draft.trim()); setRenaming(null); } }} />
            ) : (
              <div className="shelf-name" onClick={() => onOpen(b.id)}>{b.title || '未命名'}</div>
            )}
            <div className="shelf-meta">{b.sectionCount} 部 · {b.chapterCount} 章</div>
            <div className="shelf-meta dim">{new Date(b.updatedAt).toLocaleString()}</div>
            <div className="shelf-ops">
              {renaming === b.id
                ? <button className="hbtn mini" onClick={() => { if (draft.trim()) { onRename(b.id, draft.trim()); } setRenaming(null); }}>保存</button>
                : <button className="hbtn mini" onClick={() => { setRenaming(b.id); setDraft(b.title); }}>✏️ 改名</button>}
              {confirmDel === b.id
                ? <button className="hbtn mini accent" onClick={() => { setConfirmDel(null); onDelete(b.id); }}>确认删除？</button>
                : <button className="hbtn mini" onClick={() => setConfirmDel(b.id)}>🗑 删除</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
