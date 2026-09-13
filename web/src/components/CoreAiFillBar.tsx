import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { StoryEngine, StoryEngineInput } from '../types';

export function CoreAiFillBar({
  bookId, engine, disabled = false, emptyFields = [], onEngineDraft, onRewrite,
}: {
  bookId: string;
  engine: StoryEngine;
  disabled?: boolean;
  emptyFields?: Array<{ path: string; label: string }>;
  onEngineDraft: (storyEngine: StoryEngineInput) => void;
  onRewrite?: (path: string) => void;
}) {
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const busy = Boolean(status);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = () => {
    abortRef.current?.abort();
    setNotice('已停止核心循环草稿生成，本次结果不会写盘。');
  };

  const fillEngine = async () => {
    if (disabled || busy || !engine.isEmpty) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('正在填充核心循环草稿…');
    setNotice('');
    try {
      const result = await api.generateStoryEngineDraft(
        bookId, engine.revision, controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.baseRevision !== engine.revision) {
        setNotice('核心循环在生成期间已变化，旧草稿未采用；请刷新后重试。');
        return;
      }
      onEngineDraft(result.storyEngine);
      setNotice('核心循环已填入并会自动保存；人物、关系和计划承诺也可在进阶资料中由 AI 直接生成并保存，不需要的再删除。');
    } catch (reason) {
      if (!controller.signal.aborted) {
        setNotice(reason instanceof Error ? reason.message : '核心循环草稿生成失败');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStatus('');
      }
    }
  };

  const noticeIsError = /失败|变化|停止/u.test(notice);
  return (
    <section className="ai-page-fill-bar sketch-alt" aria-label="核心设定 AI 填充">
      <div>
        <strong>AI 填充本页创作骨架</strong>
        <p>核心循环会先进入表单并自动保存；人物、关系和计划承诺也由 AI 直接保存，不需要的再删除。世界、文风等长字段使用下方独立生成按钮。</p>
        {status && <p role="status">{status}</p>}
        {notice && <p className={noticeIsError ? 'chapter-plan-error' : 'ai-fill-note'}
          role={noticeIsError ? 'alert' : 'status'}>{notice}</p>}
        {!!emptyFields.length && onRewrite && <div className="ai-fill-empty-fields">
          {emptyFields.map((field) => <button key={field.path} className="hbtn" type="button"
            disabled={disabled || busy}
            onClick={() => onRewrite(field.path)}>✨ {field.label}</button>)}
        </div>}
      </div>
      {busy
        ? <button className="hbtn" type="button" onClick={stop}>停止</button>
        : engine.isEmpty && <button className="hbtn accent" type="button" disabled={disabled}
            onClick={() => void fillEngine()}>✨ AI 填充核心循环草稿</button>}
    </section>
  );
}
