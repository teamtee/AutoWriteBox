import { useEffect, useState } from 'react';
import type { Versioned } from '../types';
import { currentText, canPrev, canNext, versionLabel } from '../versioned';

// 通用「版本化框」：标题 + 行内工具条（上一版/重写(或停止)/下一版/删除）+ 主体（流式 pre / 可编辑 textarea）+ 版本徽标
// size 控制主体高度与字号：sm=紧凑（核心设定子框）/ md=中等 / lg=大（全书大纲、章节正文）
export function VersionedBox({ title, versioned, streaming, streamingText, size = 'md', onMove, onRewrite, onClear, onSave, onStop }: {
  title: string;
  versioned: Versioned;
  streaming: boolean;
  streamingText: string;
  size?: 'sm' | 'md' | 'lg';
  onMove: (delta: number) => void;
  onRewrite: () => void;
  onClear: () => void;
  onSave: (text: string) => void;
  onStop: () => void;
}) {
  const cur = currentText(versioned);
  // 本地草稿：与当前版本文本双向同步，仅在失焦时若变更才 onSave
  const [draft, setDraft] = useState(cur);
  // 内联二次确认（不使用系统 alert）
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => { setDraft(cur); }, [cur]);

  return (
    <section className={`vbox vbox-${size} sketch`}>
      <div className="vbox-head">
        <h3 className="vbox-title">{title}</h3>
        <div className="vbox-tools">
          <button className="hbtn mini" disabled={streaming || !canPrev(versioned)} onClick={() => onMove(-1)}>◀ 上一个</button>
          {streaming
            ? <button className="hbtn mini stop" onClick={onStop}>⏹ 停止</button>
            : <button className="hbtn mini" onClick={onRewrite}>🔄 重写</button>}
          <button className="hbtn mini" disabled={streaming || !canNext(versioned)} onClick={() => onMove(1)}>下一个 ▶</button>
          {confirmClear
            ? <button className="hbtn mini accent" onClick={() => { setConfirmClear(false); onClear(); }}>确认清空？</button>
            : <button className="hbtn mini" disabled={streaming} onClick={() => setConfirmClear(true)}>🗑 删除</button>}
        </div>
      </div>
      {streaming
        ? <pre className="vbox-body">{streamingText}<span className="cursor">▎</span></pre>
        : <textarea className="vbox-body editor" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (draft !== cur) onSave(draft); }} />}
      <div className="vbox-foot">{versionLabel(versioned)}</div>
    </section>
  );
}
