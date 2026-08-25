import { useEffect, useRef, useState } from 'react';
import type {
  ChapterReview, ChapterReviewRevisionCandidateResult,
  ChapterReviewRevisionVerificationResult,
} from '../types';
import { chapterRevisionCandidatePreview } from './ChapterRevisionPipelineCard';
import { useDirtyReporter } from '../useDirtyReporter';

const excludedAutomaticChecks = new Set(['contentRisk']);

export function chapterReviewRevisionRiskCount(review: ChapterReview): number {
  const checks = review.webFictionChecks?.filter((item) =>
    item.status === 'risk' && !excludedAutomaticChecks.has(item.id)).length ?? 0;
  const plan = review.planComparison?.items.filter((item) =>
    item.outcome === 'missed' || item.outcome === 'unclear').length ?? 0;
  return checks + plan;
}

export function reviewRevisionVerificationRisks(review: ChapterReview) {
  return {
    checks: review.webFictionChecks?.filter((item) =>
      item.status === 'risk' && item.id !== 'contentRisk') ?? [],
    planItems: review.planComparison?.items.filter((item) =>
      item.outcome === 'missed' || item.outcome === 'unclear') ?? [],
  };
}

export function reviewRevisionVerificationIsConsistent(
  verification: ChapterReviewRevisionVerificationResult,
  candidate?: ChapterReviewRevisionCandidateResult,
) {
  const risks = reviewRevisionVerificationRisks(verification.review);
  const derivedVerified = risks.checks.length === 0 && risks.planItems.length === 0;
  return (!candidate || (verification.candidateFingerprint === candidate.candidateFingerprint
    && verification.sourceBodyFingerprint === candidate.sourceBodyFingerprint
    && verification.sourceContextRevision === candidate.sourceContextRevision
    && verification.sourceReviewRevision === candidate.sourceReviewRevision))
    && verification.remainingRiskCount === risks.checks.length
    && verification.remainingPlanRiskCount === risks.planItems.length
    && verification.verified === derivedVerified;
}

export function reviewRevisionCandidateIsCurrent(
  candidate: ChapterReviewRevisionCandidateResult,
  bodyFingerprint: string, contextRevision: string, reviewRevision: string,
) {
  return candidate.sourceBodyFingerprint === bodyFingerprint
    && candidate.sourceContextRevision === contextRevision
    && candidate.sourceReviewRevision === reviewRevision;
}

export function ChapterReviewRevisionCard({
  review, reviewRevision, bodyFingerprint, contextRevision, currentText, disabled = false,
  onGenerate, onVerify, onAdopt, onDirtyChange,
}: {
  review: ChapterReview;
  reviewRevision: string;
  bodyFingerprint: string;
  contextRevision: string;
  currentText: string;
  disabled?: boolean;
  onGenerate: (
    expectedBodyFingerprint: string, expectedContextRevision: string,
    expectedReviewRevision: string, signal: AbortSignal,
  ) => Promise<ChapterReviewRevisionCandidateResult>;
  onVerify: (
    candidate: string, expectedBodyFingerprint: string, expectedContextRevision: string,
    expectedReviewRevision: string, signal: AbortSignal,
  ) => Promise<ChapterReviewRevisionVerificationResult>;
  onAdopt: (text: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const riskCount = chapterReviewRevisionRiskCount(review);
  const [generating, setGenerating] = useState(false);
  const [candidate, setCandidate] = useState<ChapterReviewRevisionCandidateResult>();
  const [verification, setVerification] = useState<ChapterReviewRevisionVerificationResult>();
  const verificationRisks = verification
    ? reviewRevisionVerificationRisks(verification.review) : undefined;
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const latest = useRef({ bodyFingerprint, contextRevision, reviewRevision });
  latest.current = { bodyFingerprint, contextRevision, reviewRevision };
  const pending = generating || Boolean(candidate);

  useDirtyReporter(pending, onDirtyChange);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => {
    if (candidate && !reviewRevisionCandidateIsCurrent(
      candidate, bodyFingerprint, contextRevision, reviewRevision,
    )) {
      setCandidate(undefined); setVerification(undefined);
      setError('正文、故事上下文或审稿已变化，旧精修候选已作废。');
    }
  }, [candidate, bodyFingerprint, contextRevision, reviewRevision]);

  if (!riskCount) return null;

  const generate = async () => {
    if (disabled || generating || candidate) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requested = { ...latest.current };
    setGenerating(true); setError('');
    try {
      const result = await onGenerate(
        requested.bodyFingerprint, requested.contextRevision,
        requested.reviewRevision, controller.signal,
      );
      if (controller.signal.aborted) return;
      const current = latest.current;
      if (!reviewRevisionCandidateIsCurrent(
        result, current.bodyFingerprint, current.contextRevision, current.reviewRevision,
      )) {
        setError('生成期间正文、上下文或审稿发生变化，旧候选未保留。');
        return;
      }
      setCandidate(result); setVerification(undefined);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'API 审稿精修候选生成失败');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null; setGenerating(false);
      }
    }
  };
  const verify = async () => {
    if (!candidate || disabled || generating) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requested = { ...latest.current };
    setGenerating(true); setError(''); setVerification(undefined);
    try {
      const result = await onVerify(
        candidate.candidate, requested.bodyFingerprint, requested.contextRevision,
        requested.reviewRevision, controller.signal,
      );
      if (!controller.signal.aborted) {
        if (!reviewRevisionVerificationIsConsistent(result, candidate)) {
          setError('复审返回的风险明细与汇总不一致，候选不可采用。');
          return;
        }
        setVerification(result);
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '精修候选复审失败');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null; setGenerating(false);
      }
    }
  };
  const adopt = () => {
    if (!candidate || !reviewRevisionCandidateIsCurrent(
      candidate, bodyFingerprint, contextRevision, reviewRevision,
    ) || !verification?.verified) return;
    onAdopt(candidate.candidate);
    setCandidate(undefined);
    setError('精修候选已放入正文编辑器，尚未保存；请通读后手动保存。');
  };

  return <section className="chapter-revision-card review-revision-card sketch-alt">
    <header><div><h3>API 审稿 → 定向精修</h3>
      <p>把当前审稿的 {riskCount} 项正文风险交给写作模型；保护已通过内容，不自动覆盖正文。</p></div>
      <span>{generating ? '精修中' : candidate ? '候选待确认' : '可精修'}</span></header>
    <div className="chapter-revision-action">
      <div><strong>只修证据明确的风险</strong>
        <p>内容合规风险不会被模型擅自删改；候选必须先通过复审才能采用；正文、上下文或审稿变化会使候选失效。</p></div>
      {generating
        ? <button type="button" className="hbtn stop" onClick={() => {
          abortRef.current?.abort(); setError('已停止精修；当前正文没有改动。');
        }}>停止精修</button>
        : <button type="button" className="hbtn accent" disabled={disabled || !!candidate}
            onClick={() => void generate()}>按当前审稿生成精修候选</button>}
    </div>
    {error && <p className="chapter-revision-error" role="status">{error}</p>}
    {candidate && <section className="chapter-revision-candidate" aria-label="审稿精修候选">
      <header><div><h4>审稿精修候选</h4><p>{candidate.changed
        ? `原文 ${currentText.length} 字符 → 候选 ${candidate.candidate.length} 字符。`
        : '模型判断无需改动；候选与当前正文一致。'}</p></div></header>
      <pre>{chapterRevisionCandidatePreview(candidate.candidate)}</pre>
      <p className="chapter-revision-warning">采用后只进入未保存正文草稿；请通读核对事实、已通过场景与章末因果。</p>
      {verification && <div className={verification.verified
        ? 'chapter-revision-verification pass' : 'chapter-revision-verification risk'}>
        <p>{verification.verified ? '候选复审通过：未发现新的正文风险或未落地策划。'
          : `候选复审仍有 ${verification.remainingRiskCount} 项正文风险、${verification.remainingPlanRiskCount} 项策划未落地。`}</p>
        {!verification.verified && <details open><summary>查看复审依据</summary>
          <ul>{verificationRisks?.checks.map((item) => <li key={item.id}>
              <strong>{item.id}</strong>：{item.detail}
              {item.evidence && <blockquote>{item.evidence}</blockquote>}
            </li>)}</ul>
          {!!verificationRisks?.planItems.length && <ul>
            {verificationRisks.planItems.map((item) => <li key={item.target}>
              <strong>{item.target}</strong>：{item.evidence}</li>)}</ul>}
        </details>}
      </div>}
      <div><button type="button" className="hbtn accent" disabled={generating}
          onClick={() => void verify()}>{generating ? '复审中' : '复审精修候选'}</button>
        <button type="button" className="hbtn primary"
          disabled={!candidate.changed || !verification?.verified}
          title={verification?.verified ? undefined : '候选必须先通过复审'}
          onClick={adopt}>采用为未保存正文草稿</button>
        <button type="button" className="hbtn" onClick={() => {
          setCandidate(undefined); setVerification(undefined); setError('');
        }}>丢弃候选</button></div>
    </section>}
  </section>;
}
