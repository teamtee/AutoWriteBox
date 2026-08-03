import { parseSectionTitles } from '../sections';

export function shouldDisableSectionAdoption({ streaming, adopting, titleCount }: {
  streaming: boolean;
  adopting: boolean;
  titleCount: number;
}) {
  return streaming || adopting || titleCount === 0;
}

export function shouldDisableSectionPlanClose({ adopting }: { adopting: boolean }) {
  return adopting;
}

export function SectionPlanPanel({ text, streaming, adopting = false, onAdopt, onClose }: {
  text: string;
  streaming: boolean;
  adopting?: boolean;
  onAdopt: (titles: string[]) => void;
  onClose: () => void;
}) {
  const titles = parseSectionTitles(text);
  const disabled = shouldDisableSectionAdoption({ streaming, adopting, titleCount: titles.length });
  const closeDisabled = shouldDisableSectionPlanClose({ adopting });
  const close = () => { if (!closeDisabled) onClose(); };
  return (
    <div className="modal-mask" onClick={close}>
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
          <button className="hbtn accent-2" disabled={disabled}
            onClick={() => { if (!disabled) onAdopt(titles); }}>{adopting ? '正在创建…' : '✓ 采纳并创建这些部'}</button>
          <button className="hbtn" disabled={closeDisabled} onClick={close}>取消</button>
        </div>
      </div>
    </div>
  );
}
