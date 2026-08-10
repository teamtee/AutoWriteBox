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
        <button type="button"
          className={`side-tab ${active({ kind: 'outline' })} ${disabled ? 'disabled' : ''}`}
          disabled={disabled}
          aria-current={selection.kind === 'outline' ? 'page' : undefined}
          onClick={() => go({ kind: 'outline' })}>📜 全书大纲</button>
        <button type="button"
          className={`side-tab ${active({ kind: 'core' })} ${disabled ? 'disabled' : ''}`}
          disabled={disabled}
          aria-current={selection.kind === 'core' ? 'page' : undefined}
          onClick={() => go({ kind: 'core' })}>🧭 核心设定</button>
        <button type="button"
          className={`side-tab ${active({ kind: 'serialization' })} ${disabled ? 'disabled' : ''}`}
          disabled={disabled}
          aria-current={selection.kind === 'serialization' ? 'page' : undefined}
          onClick={() => go({ kind: 'serialization' })}>📅 连载管理</button>
      </div>
      {tree.sections.map((s) => (
        <div key={s.id} className="section">
          <div className="section-title">{formatIndexedTitle(s.index, '部', s.title)}</div>
          <div className="chapter-list">
            {s.chapters.map((c) => (
              <button type="button" key={c.id}
                className={`${cls({ kind: 'chapter', sectionId: s.id, chapterId: c.id })} chapter`}
                disabled={disabled}
                aria-current={selection.kind === 'chapter'
                  && selection.sectionId === s.id && selection.chapterId === c.id
                  ? 'page' : undefined}
                onClick={() => go({ kind: 'chapter', sectionId: s.id, chapterId: c.id })}>
                <span>{formatIndexedTitle(c.index, '章', c.title)}</span>{c.hasContent ? <span className="done">✓</span> : null}
              </button>
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
