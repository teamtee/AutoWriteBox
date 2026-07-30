import { useState } from 'react';

// 章节专属动作条：仅保留「下一章 / 抽打」；重写与上一版已内置进版本化框工具条
export function Actions({ streaming, onNext, onWhip, onStop }: {
  streaming: boolean;
  onNext: () => void;
  onWhip: (text: string) => void;
  onStop: () => void;
}) {
  const [whip, setWhip] = useState('');
  return (
    <div className="actions sketch">
      {streaming ? (
        <button className="hbtn stop" onClick={onStop}>⏹ 停止</button>
      ) : (
        <>
          <div className="btn-row">
            <button className="hbtn accent-2" onClick={onNext}>➡️ 下一章</button>
          </div>
          <div className="whip-row">
            <textarea className="whip-input" placeholder="狠狠抽打：写下你的不满与要求…" value={whip}
              onChange={(e) => setWhip(e.target.value)} />
            <button className="hbtn accent whip-btn" onClick={() => { if (whip.trim()) { onWhip(whip); setWhip(''); } }}>🗯️ 抽</button>
          </div>
        </>
      )}
    </div>
  );
}
