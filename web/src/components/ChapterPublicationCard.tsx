import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { Chapter, ChapterPublicationPreflight } from '../types';
import { createLatestAbortGate } from '../asyncAction';

const preflightStatusLabels = {
  pass: '通过', risk: '风险', pending: '待检查', manual: '人工确认',
} as const;

export function ChapterPublicationCard({
  bookId, sectionId, chapter, disabled = false, publishing = false, onPublish,
}: {
  bookId: string;
  sectionId: string;
  chapter: Chapter;
  disabled?: boolean;
  publishing?: boolean;
  onPublish: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [preflight, setPreflight] = useState<ChapterPublicationPreflight | null>(null);
  const [preflightError, setPreflightError] = useState('');
  const preflightGate = useRef(createLatestAbortGate()).current;
  const published = chapter.published;
  const isCurrent = Boolean(published?.isCurrent);

  useEffect(() => {
    preflightGate.invalidate();
    setConfirming(false);
    setPreflighting(false);
    setPreflight(null);
    setPreflightError('');
    return () => preflightGate.invalidate();
  }, [bookId, sectionId, chapter.id, chapter.bodyFingerprint]);

  const requestPublish = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onPublish();
  };

  const runPreflight = async () => {
    if (preflighting || disabled || !chapter.content.trim()) return;
    const { token, signal } = preflightGate.begin();
    setPreflighting(true);
    setPreflightError('');
    try {
      const result = await api.getChapterPublicationPreflight(
        bookId, sectionId, chapter.id, chapter.bodyFingerprint, signal,
      );
      if (!preflightGate.owns(token)) return;
      setPreflight(result);
    } catch (error) {
      if (!preflightGate.owns(token) || signal.aborted) return;
      setPreflight(null);
      setPreflightError(api.readableApiError(error instanceof Error ? error.message : error));
    } finally {
      if (preflightGate.owns(token)) setPreflighting(false);
    }
  };

  return <section className={`chapter-publication ${published && !isCurrent ? 'has-unpublished-draft' : ''}`}>
    <header>
      <div>
        <h3>发布版本锁</h3>
        <p>{!published
          ? '尚未记录已发布正文。只有你确认读者已能看到这一版时才锁定。'
          : isCurrent
            ? `当前正文与第 ${published.publicationNumber} 次发布快照一致。`
            : '当前是未发布修改；长期记忆仍以读者看到的旧发布版为准。'}</p>
      </div>
      <span>{!published ? '未锁定' : isCurrent ? '已发布' : '有未发布修改'}</span>
    </header>
    {published && <details>
      <summary>查看已发布正文快照 · {published.publishedAt}</summary>
      <div>{published.content}</div>
    </details>}
    <div className="publication-preflight-actions">
      <button className="hbtn" disabled={disabled || preflighting || !chapter.content.trim()}
        onClick={() => { void runPreflight(); }}>
        {preflighting ? '检查中…' : preflight ? '重新运行发布前检查' : '运行发布前检查'}
      </button>
      <small>检查当前已保存正文；整书精确重复使用逐字复核。平台最新规则与合同始终需要人工确认。</small>
    </div>
    {preflightError && <p className="publication-preflight-error" role="alert">{preflightError}</p>}
    {preflight && <section className={`publication-preflight-result ${preflight.status}`}>
      <header>
        <strong>{preflight.status === 'risk'
          ? '发现发布风险'
          : preflight.status === 'attention'
            ? '工具项待补充 / 人工确认'
            : '工具检查已通过'}</strong>
        <span>约 {preflight.characterCount} 字符 · {preflight.paragraphCount} 个非空段落</span>
      </header>
      <ul>
        {preflight.checks.map((check) => <li key={check.id} className={check.status}>
          <div><strong>{check.label}</strong><span>{preflightStatusLabels[check.status]}</span></div>
          <p>{check.detail}</p>
        </li>)}
      </ul>
      {!!preflight.duplicateMatches.length && <details>
        <summary>查看重复章节位置</summary>
        <ol>{preflight.duplicateMatches.map((match) => <li key={`${match.sectionId}:${match.chapterId}`}>
          第 {match.chapterIndex} 章{match.title ? ` · ${match.title}` : ''}
        </li>)}</ol>
      </details>}
    </section>}
    {!isCurrent && <div className="chapter-publication-actions">
      <button className={confirming ? 'primary' : 'hbtn'}
        disabled={disabled || publishing || !chapter.content.trim()}
        onClick={requestPublish}>
        {publishing ? '锁定中…'
          : confirming ? '再次点击确认读者已看到此版'
            : published ? '锁定当前修改为发布新版' : '锁定当前版为已发布'}
      </button>
      <small>此操作只记录你在起点等平台已完成的发布，不会自动上传或替你点击平台后台。</small>
    </div>}
  </section>;
}
