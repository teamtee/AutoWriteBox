import type { BookTree } from '../types';
import type { Selection } from '../store';
import { formatIndexedTitle } from '../titles';

export function Sidebar({ tree, selection, disabled, onSelect, onAddSection, onAddChapter, onPlanSections }: {
  tree: BookTree; selection: Selection; disabled: boolean;
  onSelect: (s: Selection) => void;
  onAddSection: () => void;
  onAddChapter: (sectionId: string) => void;
  onPlanSections: () => void;
}) {
  const active = (s: Selection) => JSON.stringify(s) === JSON.stringify(selection) ? 'active' : '';
  const go = (s: Selection) => { if (!disabled) onSelect(s); };
  const cls = (s: Selection) => `nav-item ${active(s)} ${disabled ? 'disabled' : ''}`;
  return (
    <aside className={`sidebar sketch ${disabled ? 'locked' : ''}`}>
      <div className="side-tabs">
        <div className={`side-tab ${active({ kind: 'outline' })} ${disabled ? 'disabled' : ''}`} onClick={() => go({ kind: 'outline' })}>📜 全书大纲</div>
        <div className={`side-tab ${active({ kind: 'core' })} ${disabled ? 'disabled' : ''}`} onClick={() => go({ kind: 'core' })}>🧭 核心设定</div>
      </div>
      {tree.sections.map((s) => (
        <div key={s.id} className="section">
          <div className="section-title">{formatIndexedTitle(s.index, '部', s.title)}</div>
          <div className="chapter-list">
            {s.chapters.map((c) => (
              <div key={c.id}
                className={`${cls({ kind: 'chapter', sectionId: s.id, chapterId: c.id })} chapter`}
                onClick={() => go({ kind: 'chapter', sectionId: s.id, chapterId: c.id })}>
                <span>{formatIndexedTitle(c.index, '章', c.title)}</span>{c.content ? <span className="done">✓</span> : null}
              </div>
            ))}
          </div>
          <button className="hbtn dashed mini" disabled={disabled} onClick={() => onAddChapter(s.id)}>＋ 加章</button>
        </div>
      ))}
      <div className="side-add">
        <button className="hbtn dashed mini" disabled={disabled} onClick={onAddSection}>＋ 新建部</button>
        <button className="hbtn dashed mini" disabled={disabled} onClick={onPlanSections}>🧩 AI 规划分部</button>
      </div>
    </aside>
  );
}
