import { useEffect, useRef, useState } from 'react';
import type {
  ChapterRevisionCandidateResult, ChapterRevisionStage,
} from '../types';

const STAGES: Array<{
  id: ChapterRevisionStage; label: string; description: string;
}> = [
  { id: 'scene-grounding', label: '概述化', description: '把被一笔带过的关键过程还原成行动、对话、反应和后果。' },
  { id: 'abstract-summary', label: '抽象总结', description: '减少作者代替人物和读者下结论，用当下反应承载意义。' },
  { id: 'rhetoric-repetition', label: '模板修辞', description: '清理重复比喻、排比、金句和同构句式，保留真正有效的表达。' },
  { id: 'character-voice', label: '人物同声', description: '按身份、欲望、压力和关系分化说话方式与潜台词。' },
  { id: 'intensity-shape', label: '节奏同强度', description: '让蓄力、冲突、反应、决定和余波形成自然张弛。' },
  { id: 'low-value-paragraphs', label: '无效段落', description: '合并重复说明和空转段落，同时保留呼吸感与因果桥梁。' },
];

export function revisionCandidateIsCurrent(
  candidate: ChapterRevisionCandidateResult, bodyFingerprint: string,
  contextRevision: string,
) {
  return candidate.sourceBodyFingerprint === bodyFingerprint
    && candidate.sourceContextRevision === contextRevision;
}

export function chapterRevisionCandidatePreview(text: string) {
  if (text.length <= 1_800) return text;
  return `${text.slice(0, 1_200)}\n\n……中间内容在采用后于正文编辑器完整核对……\n\n${text.slice(-600)}`;
}

export function ChapterRevisionCandidate({
  label, candidate, currentLength, onAdopt, onDiscard,
}: {
  label: string;
  candidate: ChapterRevisionCandidateResult;
  currentLength: number;
  onAdopt: () => void;
  onDiscard: () => void;
}) {
  return <section className="chapter-revision-candidate" aria-label="分项修订候选">
    <header><div><h4>{label}候选</h4>
      <p>{candidate.changed
        ? `原文 ${currentLength} 字符 → 候选 ${candidate.candidate.length} 字符。`
        : '模型判断本阶段无需修改；候选与当前正文一致。'}</p></div></header>
    <pre>{chapterRevisionCandidatePreview(candidate.candidate)}</pre>
    <p className="chapter-revision-warning">采用后请在上方正文编辑器通读完整候选，核对事实、人物声音和节奏；仍需手动保存。</p>
    <div><button type="button" className="hbtn primary" disabled={!candidate.changed}
        onClick={onAdopt}>采用为未保存正文草稿</button>
      <button type="button" className="hbtn" onClick={onDiscard}>丢弃候选</button></div>
  </section>;
}

export function ChapterRevisionPipelineCard({
  bodyFingerprint, contextRevision, currentText, disabled = false,
  onGenerate, onAdopt, onDirtyChange,
}: {
  bodyFingerprint: string;
  contextRevision: string;
  currentText: string;
  disabled?: boolean;
  onGenerate: (
    stage: ChapterRevisionStage, expectedBodyFingerprint: string,
    expectedContextRevision: string, signal: AbortSignal,
  ) => Promise<ChapterRevisionCandidateResult>;
  onAdopt: (text: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [stage, setStage] = useState<ChapterRevisionStage>('scene-grounding');
  const [generating, setGenerating] = useState(false);
  const [candidate, setCandidate] = useState<ChapterRevisionCandidateResult>();
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const dirtyChangeRef = useRef(onDirtyChange);
  dirtyChangeRef.current = onDirtyChange;
  const latestAnchors = useRef({ bodyFingerprint, contextRevision });
  latestAnchors.current = { bodyFingerprint, contextRevision };
  const pending = generating || Boolean(candidate);

  useEffect(() => dirtyChangeRef.current?.(pending), [pending]);
  useEffect(() => () => {
    abortRef.current?.abort();
    dirtyChangeRef.current?.(false);
  }, []);
  useEffect(() => {
    if (candidate && !revisionCandidateIsCurrent(
      candidate, bodyFingerprint, contextRevision,
    )) {
      setCandidate(undefined);
      setError('正文或故事上下文已变化，旧修订候选已作废。');
    }
  }, [candidate, bodyFingerprint, contextRevision]);

  const generate = async () => {
    if (disabled || generating || candidate) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requested = { bodyFingerprint, contextRevision };
    setGenerating(true);
    setError('');
    try {
      const result = await onGenerate(
        stage, requested.bodyFingerprint, requested.contextRevision, controller.signal,
      );
      if (controller.signal.aborted) return;
      const latest = latestAnchors.current;
      if (!revisionCandidateIsCurrent(result, latest.bodyFingerprint, latest.contextRevision)
        || latest.bodyFingerprint !== requested.bodyFingerprint
        || latest.contextRevision !== requested.contextRevision) {
        setError('生成期间正文或故事上下文发生变化，旧候选未保留。');
        return;
      }
      setCandidate(result);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '分项修订候选生成失败');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setGenerating(false);
      }
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setError('已停止生成；当前正文没有改动。');
  };
  const discard = () => {
    setCandidate(undefined);
    setError('');
  };
  const adopt = () => {
    if (!candidate || !revisionCandidateIsCurrent(
      candidate, bodyFingerprint, contextRevision,
    )) return;
    onAdopt(candidate.candidate);
    setCandidate(undefined);
    setError('候选已放入正文编辑器，尚未保存；请通读并手动保存。');
  };
  const selected = STAGES.find((item) => item.id === stage)!;

  return <section className="chapter-revision-card sketch-alt">
    <header><div><h3>去 AI 味 · 分项修订流水线</h3>
      <p>一次只处理一类问题；候选先预览，再进入未保存正文草稿，不会自动覆盖。</p></div>
      <span>{generating ? '生成中' : candidate ? '候选待确认' : '正文安全'}</span></header>
    <div className="chapter-revision-stages" role="radiogroup" aria-label="修订阶段">
      {STAGES.map((item) => <button type="button" role="radio"
        aria-checked={stage === item.id} className={stage === item.id ? 'selected' : ''}
        key={item.id} disabled={generating || Boolean(candidate)}
        onClick={() => { setStage(item.id); setError(''); }}>
        <strong>{item.label}</strong><span>{item.description}</span>
      </button>)}
    </div>
    <div className="chapter-revision-action">
      <div><strong>当前阶段：{selected.label}</strong><p>{selected.description}</p></div>
      {generating
        ? <button type="button" className="hbtn stop" onClick={stop}>停止生成</button>
        : <button type="button" className="hbtn accent" disabled={disabled || !!candidate}
            onClick={() => void generate()}>生成本阶段候选</button>}
    </div>
    {error && <p className="chapter-revision-error" role="status">{error}</p>}
    {candidate && <ChapterRevisionCandidate label={selected.label} candidate={candidate}
      currentLength={currentText.length} onAdopt={adopt} onDiscard={discard} />}
  </section>;
}
