import type { ChapterReview } from '../types';

const checkLabels = {
  goldenChapter: '本章黄金职责',
  premisePromise: '前三章共同承诺',
  chapterGoal: '本章目标',
  obstacleEscalation: '阻碍与升级',
  characterChoice: '人物选择',
  effectiveIncrement: '有效增量',
  payoff: '铺垫与兑现',
  endingHook: '章末钩子',
  expressionBalance: '表达比例',
  repetitionRisk: '重复风险',
  longArcProgress: '长线推进',
  styleConsistency: '文风一致性',
  packagingPromise: '包装承诺一致性',
  contentRisk: '内容风险线索',
} as const;

const statusLabels = { pass: '通过', risk: '风险', na: '不适用' } as const;

export function ChapterReviewCard({
  review, stale, reviewing, empty = false, disabled = false, onReview, onStopReview, onUseSuggestion,
}: {
  review?: ChapterReview;
  stale: boolean;
  reviewing: boolean;
  empty?: boolean;
  disabled?: boolean;
  onReview: () => void;
  onStopReview?: () => void;
  onUseSuggestion: (instruction: string) => void;
}) {
  if (reviewing) {
    return (
      <div className="review-card sketch" aria-busy="true">
        <div className="review-header" role="status" aria-live="polite" aria-atomic="true">审稿中…</div>
        {onStopReview && <button type="button" className="hbtn stop review-btn" onClick={onStopReview}>⏹ 停止审稿</button>}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="review-card sketch">
        <div className="review-header">章节正文为空</div>
        <div className="review-verdict">写入正文后才能审稿。</div>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="review-card sketch">
        <div className="review-header">还没有审稿</div>
        <button className="hbtn review-btn" disabled={disabled} onClick={onReview}>审稿本章</button>
      </div>
    );
  }

  if (stale) {
    return (
      <div className="review-card sketch stale">
        <div className="review-header">这张审稿卡对应旧正文或旧故事设定</div>
        <div className="review-score">评分：{review.score}</div>
        <div className="review-verdict">{review.verdict}</div>
        <button className="hbtn review-btn" disabled={disabled} onClick={onReview}>重新审稿</button>
      </div>
    );
  }

  return (
    <div className="review-card sketch">
      <div className="review-header">章节审稿</div>
      <div className="review-score">综合评分：{review.score}</div>
      <div className="review-verdict">{review.verdict}</div>

      {review.webFictionSignals && (
        <div className="review-signals" aria-label="本章节奏记录">
          <span>功能：{review.webFictionSignals.chapterFunction}</span>
          <span>冲突：{review.webFictionSignals.conflictType}</span>
          <span>情绪：{review.webFictionSignals.emotionTone}</span>
          <span>兑现：{review.webFictionSignals.payoffType}</span>
          <span>表达：{review.webFictionSignals.dominantMode}</span>
        </div>
      )}

      {!!review.webFictionChecks?.length && (
        <div className="review-section">
          <div className="review-section-title">网文章法检查</div>
          <div className="review-checks">
            {review.webFictionChecks.map((check) => (
              <div key={check.id} className={`review-check ${check.status}`}>
                <div className="review-check-heading">
                  <span>{checkLabels[check.id]}</span>
                  <span className="review-check-status">{statusLabels[check.status]}</span>
                </div>
                <div className="review-check-detail">{check.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {review.issues.length > 0 && (
        <div className="review-section">
          <div className="review-section-title">主要问题</div>
          {review.issues.map((issue, i) => (
            <div key={i} className="review-issue">
              <div>{i + 1}. {issue.title}</div>
              <div className="review-issue-detail">{issue.detail}</div>
            </div>
          ))}
        </div>
      )}

      {review.suggestions.length > 0 && (
        <div className="review-section">
          <div className="review-section-title">建议抽打</div>
          <div className="review-suggestions">
            {review.suggestions.map((s, i) => (
              <button key={i} className="hbtn review-suggestion" disabled={disabled} onClick={() => onUseSuggestion(s.instruction)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <button className="hbtn review-btn" disabled={disabled} onClick={onReview}>重新审稿</button>
    </div>
  );
}
