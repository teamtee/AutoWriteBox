import { useEffect, useState } from 'react';
import type {
  MemoryCandidate, MemoryCandidateStatus, MemoryDecisionAction,
} from '../types';
import { decideMemoryCandidate, isApiErrorCode } from '../api';
import { memoryDetailEntries } from '../memoryDetails';

const KIND_LABELS: Record<MemoryCandidate['kind'], string> = {
  character: '人物', relationship: '关系', ability: '能力', item: '物品',
  location: '地点', timeline: '时间线', faction: '势力',
  foreshadowing: '伏笔', knowledge: '知识边界', other: '其它',
};
const STATUS_LABELS: Record<MemoryCandidateStatus, string> = {
  pending: '待确认', accepted: '已确认', rejected: '已忽略',
  stale: '来源已失效', superseded: '已被替换',
};

export function MemoryCandidateCard({
  bookId, sectionId, chapterId, bodyFingerprint,
  initialMemoryRevision, initialCandidates, confirmationBlocked = false,
}: {
  bookId: string;
  sectionId: string;
  chapterId: string;
  bodyFingerprint: string;
  initialMemoryRevision: string;
  initialCandidates: MemoryCandidate[];
  confirmationBlocked?: boolean;
}) {
  const [memoryRevision, setMemoryRevision] = useState(initialMemoryRevision);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setMemoryRevision(initialMemoryRevision);
    setCandidates(initialCandidates);
    setReplaceId(null);
    setError(null);
    setNotice(null);
  }, [bodyFingerprint, initialMemoryRevision, initialCandidates]);

  if (!candidates.length) return null;

  const decide = async (candidate: MemoryCandidate, action: MemoryDecisionAction) => {
    if (busyId) return;
    setBusyId(candidate.id);
    setError(null);
    setNotice(null);
    try {
      const result = await decideMemoryCandidate(
        bookId, sectionId, chapterId, candidate.id, action,
        bodyFingerprint, memoryRevision,
      );
      setMemoryRevision(result.memoryRevision);
      setCandidates(result.candidates);
      setReplaceId(null);
      setNotice(action === 'reject'
        ? '已忽略该候选，它不会进入后续生成上下文'
        : action === 'replace'
          ? '已显式替换冲突事实；旧事实保留为历史记录'
          : '已确认，后续生成会按相关度和预算选取这条事实');
    } catch (reason) {
      if (isApiErrorCode(reason, 'MEMORY_CONFLICT')) setReplaceId(candidate.id);
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="memory-card sketch">
      <header>
        <div><h3>长期记忆候选</h3><p>正文中主体和值均可精确定位的最高重要度事实会自动采纳；其余仍需确认，自动项可随时否决。</p></div>
        <span>{candidates.filter((candidate) => candidate.status === 'pending').length} 条待确认</span>
      </header>
      {error && <div className="memory-message error" role="alert">{error}</div>}
      {notice && <div className="memory-message" role="status">{notice}</div>}
      {confirmationBlocked && <div className="memory-message" role="status">
        当前正文是未发布修改。可先忽略无效候选；要确认为长期事实，需先锁定发布新版。
      </div>}
      <div className="memory-list">{candidates.map((candidate) => (
        <article className={`memory-row memory-${candidate.status}`} key={candidate.id}>
          <div className="memory-row-head">
            <span className="memory-kind">{KIND_LABELS[candidate.kind]}</span>
            <strong>{candidate.subject}</strong>
            {!!candidate.aliases?.length && <span>别名：{candidate.aliases.join('、')}</span>}
            <span>{candidate.predicate}</span>
            <span className="memory-status">
              {candidate.autoAccepted && candidate.status === 'accepted'
                ? '自动采纳' : STATUS_LABELS[candidate.status]}
            </span>
          </div>
          <p>{candidate.object}</p>
          {candidate.evidence && <small>依据：{candidate.evidence}</small>}
          {!!candidate.details && <dl className="memory-detail-grid">
            {memoryDetailEntries(candidate.details).map((detail) => <div key={detail.field}>
              <dt>{detail.label}</dt><dd>{detail.value}</dd>
            </div>)}
          </dl>}
          {candidate.status === 'pending' && <div className="memory-actions">
            {replaceId === candidate.id
              ? <button className="hbtn accent" disabled={busyId === candidate.id || confirmationBlocked}
                  onClick={() => { void decide(candidate, 'replace'); }}>
                  {busyId === candidate.id ? '替换中…' : '确认替换冲突事实？'}
                </button>
              : <button className="hbtn accent" disabled={!!busyId || confirmationBlocked}
                  onClick={() => { void decide(candidate, 'accept'); }}>确认事实</button>}
            <button className="hbtn" disabled={!!busyId}
              onClick={() => { void decide(candidate, 'reject'); }}>忽略候选</button>
          </div>}
          {candidate.status === 'accepted' && candidate.autoAccepted && <div className="memory-actions">
            <button className="hbtn" disabled={!!busyId}
              onClick={() => { void decide(candidate, 'reject'); }}>
              {busyId === candidate.id ? '否决中…' : '否决自动采纳'}
            </button>
          </div>}
        </article>
      ))}</div>
    </section>
  );
}
