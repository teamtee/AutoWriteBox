import type {
  GoldenThreeCheckId, GoldenThreeFixTarget, GoldenThreeReviewState,
} from '../types';

const checkLabels: Record<GoldenThreeCheckId, string> = {
  premisePromise: '题材与包装承诺', protagonistAttachment: '人物依恋',
  protagonistDrive: '主角驱动力', coreLoop: '核心循环', centralConflict: '主要矛盾',
  differentiation: '差异化卖点', firstPayoff: '第一次有效兑现',
  threeChapterEscalation: '三章递进', continuationPull: '第三章后追读力',
};
const targetLabels: Record<GoldenThreeFixTarget, string> = {
  'chapter-1': '第 1 章', 'chapter-2': '第 2 章', 'chapter-3': '第 3 章', all: '三章整体',
};

export function GoldenThreeReviewCard({
  state, reviewing, disabled = false, onReview, onStopReview, onOpenChapter,
}: {
  state: GoldenThreeReviewState;
  reviewing: boolean;
  disabled?: boolean;
  onReview: () => void;
  onStopReview?: () => void;
  onOpenChapter?: (sectionId: string, chapterId: string) => void;
}) {
  if (reviewing) return (
    <section className="review-card golden-three-card sketch" aria-busy="true">
      <div className="review-header" role="status" aria-live="polite">黄金三章联合审稿中…</div>
      {onStopReview && <button type="button" className="hbtn stop review-btn"
        onClick={onStopReview}>⏹ 停止联合审稿</button>}
    </section>
  );

  if (!state.ready) return (
    <section className="review-card golden-three-card sketch">
      <div className="review-header">黄金三章联合审稿</div>
      <div className="review-verdict">前三章已完成 {state.completedChapterCount}/3 章正文。</div>
      {!!state.missingChapterIndexes.length && <div className="review-verdict">
        还需写入：{state.missingChapterIndexes.map((index) => `第 ${index} 章`).join('、')}
      </div>}
    </section>
  );

  const review = state.review;
  if (!review) return (
    <section className="review-card golden-three-card sketch">
      <div className="review-header">黄金三章总检</div>
      <div className="review-verdict">三章正文已齐。联合检查承诺、人物依恋、核心循环、首次兑现与追读力。</div>
      <button type="button" className="hbtn review-btn" disabled={disabled}
        onClick={onReview}>联合审稿前三章</button>
    </section>
  );

  if (!state.isCurrent) return (
    <section className="review-card golden-three-card sketch stale">
      <div className="review-header">黄金三章总检已过期</div>
      <div className="review-score">旧评分：{review.score}</div>
      <div className="review-verdict">前三章正文或作品承诺已经变化，请用当前版本重新总检。</div>
      <button type="button" className="hbtn review-btn" disabled={disabled}
        onClick={onReview}>重新联合审稿</button>
    </section>
  );

  return (
    <section className="review-card golden-three-card sketch">
      <div className="review-header">黄金三章总检</div>
      <div className="review-score">整体评分：{review.score}</div>
      <div className="review-verdict">{review.verdict}</div>
      <div className="review-section">
        <div className="review-section-title">跨三章检查</div>
        <div className="review-checks">
          {review.checks.map((check) => <div key={check.id}
            className={`review-check ${check.status}`}>
            <div className="review-check-heading"><span>{checkLabels[check.id]}</span>
              <span className="review-check-status">{check.status === 'pass' ? '通过' : '风险'}</span></div>
            <div className="review-check-detail">{check.summary}</div>
            <ul className="golden-evidence">{check.evidence.map((item) =>
              <li key={item.chapter}><strong>第 {item.chapter} 章：</strong>
                {item.quote ? <><q>{item.quote}</q>{item.analysis && <> — {item.analysis}</>}</>
                  : item.detail}</li>)}</ul>
          </div>)}
        </div>
      </div>
      <div className="review-section">
        <div className="review-section-title">最有杠杆的修复</div>
        <div className="review-suggestions">{review.fixes.map((fix, index) => {
          const chapterIndex = fix.target === 'all' ? null : Number(fix.target.slice(-1));
          const source = chapterIndex ? state.sources[chapterIndex - 1] : null;
          return <div className="review-suggestion golden-fix" key={`${fix.target}:${index}`}>
            <div><strong>{targetLabels[fix.target]} · {fix.label}</strong></div>
            <p>{fix.problem}</p><p>{fix.instruction}</p>
            {source && onOpenChapter && <button type="button" className="hbtn"
              disabled={disabled} onClick={() => onOpenChapter(source.sectionId, source.chapterId)}>
              打开第 {chapterIndex} 章处理
            </button>}
          </div>;
        })}</div>
      </div>
    </section>
  );
}
