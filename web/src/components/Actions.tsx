export function hasWhipInstructionDraft(whip: string) {
  return whip.trim().length > 0;
}

export function isSubmittedWhipDraft(draft: string, instruction: string) {
  return hasWhipInstructionDraft(draft) && draft.trim() === instruction.trim();
}

export function shouldDisableNextChapter(
  disabled: boolean,
  whip: string,
  chapterEmpty = false,
  hasExistingNextChapter = false,
) {
  return disabled || hasWhipInstructionDraft(whip)
    || (chapterEmpty && !hasExistingNextChapter);
}

// 章节专属动作条：已有后续章时只导航；当前章有正文且位于末尾时才允许生成下一章。
export function Actions({ streaming, disabled = false, hasExistingNextChapter = false, chapterEmpty = false, whip, onWhipChange, onNext, onWhip, onStop }: {
  streaming: boolean;
  disabled?: boolean;
  hasExistingNextChapter?: boolean;
  chapterEmpty?: boolean;
  whip: string;
  onWhipChange: (text: string) => void;
  onNext: () => void;
  onWhip: (text: string) => void;
  onStop: () => void;
}) {
  const hasWhipDraft = hasWhipInstructionDraft(whip);
  return (
    <div className="actions sketch">
      {streaming ? (
        <button className="hbtn stop" onClick={onStop}>⏹ 停止</button>
      ) : (
        <>
          <div className="btn-row">
            <button type="button" className="hbtn accent-2"
              disabled={shouldDisableNextChapter(disabled, whip, chapterEmpty, hasExistingNextChapter)}
              onClick={onNext}>
              {hasExistingNextChapter
                ? '➡️ 下一章'
                : chapterEmpty ? '请先生成本章' : '✍️ 生成下一章'}
            </button>
          </div>
          <div className="whip-row">
            <textarea className="whip-input" aria-label="抽打修改要求"
              maxLength={10000} placeholder="狠狠抽打：写下你的不满与要求…" value={whip}
              disabled={disabled || chapterEmpty}
              onChange={(e) => onWhipChange(e.target.value)} />
            <button className="hbtn accent whip-btn" disabled={disabled || chapterEmpty || !hasWhipDraft}
              onClick={() => { if (hasWhipDraft) onWhip(whip.trim()); }}>🗯️ 抽</button>
          </div>
        </>
      )}
    </div>
  );
}
