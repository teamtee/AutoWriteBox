import type { BookTree } from '../types';
import type { Selection } from '../store';

export function Sidebar({ tree, selection, onSelect, onAddSection, onAddChapter, onOpenSettings, onPlanSections }: {
  tree: BookTree; selection: Selection;
  onSelect: (s: Selection) => void;
  onAddSection: () => void;
  onAddChapter: (sectionId: string) => void;
  onOpenSettings: () => void;
  onPlanSections: () => void;
}) {
  const active = (s: Selection) => JSON.stringify(s) === JSON.stringify(selection) ? 'active' : '';
  return (
    <aside className="sidebar">
      <div className="book-title">📖 {tree.book.title}</div>
      <div className={`nav-item ${active({ kind: 'outline' })}`} onClick={() => onSelect({ kind: 'outline' })}>全书大纲</div>
      <div className={`nav-item ${active({ kind: 'core' })}`} onClick={() => onSelect({ kind: 'core' })}>核心设定</div>
      {tree.sections.map((s) => (
        <div key={s.id} className="section">
          <div className="section-title">{s.title}</div>
          {s.chapters.map((c) => (
            <div key={c.id}
              className={`nav-item chapter ${active({ kind: 'chapter', sectionId: s.id, chapterId: c.id })}`}
              onClick={() => onSelect({ kind: 'chapter', sectionId: s.id, chapterId: c.id })}>
              · {c.title} {c.content ? '✓' : ''}
            </div>
          ))}
          <button className="mini" onClick={() => onAddChapter(s.id)}>＋ 加章</button>
        </div>
      ))}
      <div className="btn-row">
        <button className="mini" onClick={onAddSection}>＋ 新建部</button>
        <button className="mini" onClick={onPlanSections}>🧩 让 AI 规划分部</button>
      </div>
      <div className="nav-item settings" onClick={onOpenSettings}>⚙️ API 设置</div>
    </aside>
  );
}
