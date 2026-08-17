import { useState } from 'react';
import { applyChapterReviewPromiseCandidate } from '../api';
import type { ChapterReviewPromiseCandidate } from '../types';

const actionLabels = {
  establish: '确认建立承诺',
  advance: '确认记录推进',
  pay: '确认已经兑现',
} as const;
const beatLabels = {
  plant: '植入', pressure: '加压', misdirect: '公平误导',
  reinterpret: '变义', collide: '线索碰撞', payoff: '回收',
} as const;

export function ChapterReviewPromiseCandidatesCard({
  bookId, sectionId, chapterId, candidates,
  bodyFingerprint, reviewRevision, initialPromiseLedgerRevision,
  disabled = false,
}: {
  bookId: string;
  sectionId: string;
  chapterId: string;
  candidates: ChapterReviewPromiseCandidate[];
  bodyFingerprint: string;
  reviewRevision: string;
  initialPromiseLedgerRevision: string;
  disabled?: boolean;
}) {
  const [ledgerRevision, setLedgerRevision] = useState(initialPromiseLedgerRevision);
  const [busyEntryId, setBusyEntryId] = useState<string>();
  const [appliedEntryIds, setAppliedEntryIds] = useState<string[]>([]);
  const [error, setError] = useState('');

  const apply = async (candidate: ChapterReviewPromiseCandidate) => {
    setBusyEntryId(candidate.entryId);
    setError('');
    try {
      const result = await applyChapterReviewPromiseCandidate(
        bookId, sectionId, chapterId, candidate.entryId,
        bodyFingerprint, reviewRevision, ledgerRevision,
      );
      setLedgerRevision(result.revision);
      setAppliedEntryIds((current) => [...current, candidate.entryId]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '候选未写入账本，请刷新后重试');
    } finally {
      setBusyEntryId(undefined);
    }
  };

  return (
    <section className="review-promise-candidates sketch" aria-label="审稿发现的阅读债务更新候选">
      <header>
        <div>
          <h3>审稿发现的账本候选</h3>
          <p>API 只提供正文证据；点击确认后才会改变长期承诺账本。</p>
        </div>
        <span>{candidates.length} 项待核对</span>
      </header>
      <div className="review-promise-candidate-list">
        {candidates.map((candidate) => {
          const applied = appliedEntryIds.includes(candidate.entryId);
          const busy = busyEntryId === candidate.entryId;
          return (
            <article key={candidate.entryId} className={applied ? 'applied' : ''}>
              <strong>{candidate.promise}</strong>
              <small>{beatLabels[candidate.beat]} · {candidate.readerBefore} → {candidate.readerAfter}</small>
              <p>{candidate.summary}</p>
              <p>行动后果：{candidate.actionConsequence}</p>
              <p>世界线：{candidate.worldEffect}</p>
              <blockquote>正文证据：{candidate.evidence}</blockquote>
              <button type="button" className="hbtn"
                disabled={disabled || Boolean(busyEntryId) || applied}
                onClick={() => apply(candidate)}>
                {applied ? '已写入账本' : busy ? '确认中…' : actionLabels[candidate.action]}
              </button>
            </article>
          );
        })}
      </div>
      {error && <p className="chapter-plan-error" role="alert">{error}</p>}
    </section>
  );
}
