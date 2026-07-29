import { useState } from 'react';

export function Actions({ streaming, onRewrite, onNext, onWhip, onStop }: {
  streaming: boolean;
  onRewrite: () => void;
  onNext: () => void;
  onWhip: (text: string) => void;
  onStop: () => void;
}) {
  const [whip, setWhip] = useState('');
  return (
    <div className="actions">
      {streaming ? (
        <button className="stop" onClick={onStop}>⏹ 停止</button>
      ) : (
        <>
          <div className="btn-row">
            <button onClick={onRewrite}>🔄 重写</button>
            <button onClick={onNext}>➡️ 下一章</button>
          </div>
          <div className="whip-row">
            <textarea placeholder="狠狠抽打：写下你的不满与要求…" value={whip}
              onChange={(e) => setWhip(e.target.value)} />
            <button onClick={() => { if (whip.trim()) { onWhip(whip); setWhip(''); } }}>🗯️ 抽</button>
          </div>
        </>
      )}
    </div>
  );
}
