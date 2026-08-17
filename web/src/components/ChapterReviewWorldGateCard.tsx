import { useState } from 'react';
import { applyChapterReviewWorldGateCandidate } from '../api';
import type { ChapterReviewWorldGateCandidate } from '../types';

export function ChapterReviewWorldGateCard({
  bookId, sectionId, chapterId, candidate,
  bodyFingerprint, reviewRevision, initialWorldProgressRevision,
  onConfirmed, disabled = false,
}: {
  bookId: string;
  sectionId: string;
  chapterId: string;
  candidate: ChapterReviewWorldGateCandidate;
  bodyFingerprint: string;
  reviewRevision: string;
  initialWorldProgressRevision: string;
  onConfirmed?: () => Promise<void>;
  disabled?: boolean;
}) {
  const [worldProgressRevision, setWorldProgressRevision] = useState(
    initialWorldProgressRevision,
  );
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState('');

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await applyChapterReviewWorldGateCandidate(
        bookId, sectionId, chapterId, bodyFingerprint, reviewRevision,
        worldProgressRevision,
      );
      setWorldProgressRevision(result.revision);
      setApplied(true);
      void onConfirmed?.().catch(() => {
        setError('世界门槛已确认，但页面刷新失败；请重新打开作品查看最新层级');
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界门槛未确认，请刷新后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="review-promise-candidates sketch" aria-label="审稿发现的世界门槛候选">
      <header>
        <div>
          <h3>世界层级解锁候选</h3>
          <p>API 只能提交正文证据；你确认后，后续规划才会进入下一层。</p>
        </div>
        <span>{candidate.fromLayer} → {candidate.toLayer}</span>
      </header>
      <div className="review-promise-candidate-list">
        <article className={applied ? 'applied' : ''}>
          <strong>门槛：{candidate.gateCondition}</strong>
          <p>{candidate.summary}</p>
          <blockquote>正文证据：{candidate.evidence}</blockquote>
          <button type="button" className="hbtn"
            disabled={disabled || busy || applied} onClick={apply}>
            {applied ? '已确认解锁' : busy ? '确认中…' : '确认进入下一层'}
          </button>
        </article>
      </div>
      {error && <p className="chapter-plan-error" role="alert">{error}</p>}
    </section>
  );
}
