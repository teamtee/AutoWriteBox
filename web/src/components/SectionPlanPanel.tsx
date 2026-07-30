import { parseSectionTitles } from '../sections';

export function SectionPlanPanel({ text, streaming, onAdopt, onClose }: {
  text: string;
  streaming: boolean;
  onAdopt: (titles: string[]) => void;
  onClose: () => void;
}) {
  const titles = parseSectionTitles(text);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="plan-panel sketch" onClick={(e) => e.stopPropagation()}>
        <h2>🧩 AI 分部规划</h2>
        <pre className="plan-text">
          {text || '正在思考…'}
          {streaming && <span className="cursor">▎</span>}
        </pre>
        {!streaming && titles.length > 0 && (
          <div className="plan-preview">
            将创建 {titles.length} 个部：
            <ol>{titles.map((t, i) => <li key={i}>{t}</li>)}</ol>
          </div>
        )}
        <div className="plan-actions">
          <button className="hbtn accent-2" disabled={streaming || titles.length === 0}
            onClick={() => onAdopt(titles)}>✓ 采纳并创建这些部</button>
          <button className="hbtn" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
