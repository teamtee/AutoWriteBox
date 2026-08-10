export function MemoryRecomputeCard({
  bodyFingerprint, recomputing = false, disabled = false, onRecompute,
}: {
  bodyFingerprint: string;
  recomputing?: boolean;
  disabled?: boolean;
  onRecompute: () => void;
}) {
  return (
    <section className="memory-recompute sketch-alt">
      <div>
        <strong>记忆来源追踪</strong>
        <span>候选锚定当前已保存正文指纹 {bodyFingerprint.slice(0, 12)}…；重算后仍需逐条确认才会成为长期事实。</span>
      </div>
      <button className="hbtn" disabled={disabled || recomputing} onClick={onRecompute}>
        {recomputing ? '重新提取中…' : '重新提取摘要 / 人物 / 记忆'}
      </button>
    </section>
  );
}
