import { useEffect, useRef } from 'react';
import { parseSectionTitles } from '../sections';
import type { SectionPlan } from '../types';

export function sectionPlanOutline(plan: SectionPlan): string {
  return [
    `【本部概述】${plan.summary || '待进一步明确'}`,
    `【阶段承诺 Promise】${plan.promise}`,
    `【本部目标】${plan.goal}`,
    `【主要阻力】${plan.obstacle}`,
    `【主线推进 Progress】${plan.progress}`,
    `【阶段高潮】${plan.climax}`,
    `【阶段兑现 Payoff】${plan.payoff}`,
    `【结束状态变化】${plan.stateChange}`,
  ].join('\n');
}

export function shouldDisableSectionAdoption({ streaming, adopting, parseError, titleCount }: {
  streaming: boolean;
  adopting: boolean;
  parseError: boolean;
  titleCount: number;
}) {
  return streaming || adopting || parseError || titleCount === 0;
}

export function shouldDisableSectionPlanClose({ adopting }: { adopting: boolean }) {
  return adopting;
}

export function shouldCloseSectionPlanOnEscape({ key, adopting }: {
  key: string;
  adopting: boolean;
}) {
  return key === 'Escape' && !adopting;
}

export function resolveSectionPlanTabTarget({ shiftKey, activeIndex, focusableCount }: {
  shiftKey: boolean;
  activeIndex: number;
  focusableCount: number;
}): number | null {
  if (focusableCount <= 0) return -1;
  if (shiftKey && activeIndex <= 0) return focusableCount - 1;
  if (!shiftKey && (activeIndex < 0 || activeIndex >= focusableCount - 1)) return 0;
  return null;
}

export function resolveSectionPlanTitles(text: string, titles?: string[]): string[] {
  return titles ?? parseSectionTitles(text);
}

export function SectionPlanPanel({ text, titles, plans, streaming, adopting = false, parseError = false, returnFocus, onAdopt, onRetry, onClose }: {
  text: string;
  titles?: string[];
  plans?: SectionPlan[];
  streaming: boolean;
  adopting?: boolean;
  parseError?: boolean;
  returnFocus?: HTMLElement | null;
  onAdopt: (titles: string[]) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  // 新协议由后端返回已清洗的 parsedTitles；未传时才兼容旧的逐行文本。
  const resolvedTitles = resolveSectionPlanTitles(text, titles);
  const disabled = shouldDisableSectionAdoption({ streaming, adopting, parseError, titleCount: resolvedTitles.length });
  const closeDisabled = shouldDisableSectionPlanClose({ adopting });
  const close = () => { if (!closeDisabled) onClose(); };
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef(returnFocus);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    panelRef.current?.focus();
    return () => {
      // 打开弹窗时触发按钮会随 streaming 一起变为 disabled，浏览器可能在
      // effect 执行前已把焦点移到 body。优先使用 App 在动作开始前保存的元素；
      // 延迟到本次 DOM 提交后恢复，确保按钮已经重新启用。
      queueMicrotask(() => {
        const preferred = returnFocusRef.current;
        const target = preferred?.isConnected ? preferred : previousFocus;
        if (!target?.isConnected) return;
        if (document.activeElement === document.body || !document.activeElement) target.focus();
      });
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldCloseSectionPlanOnEscape({ key: event.key, adopting })) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      const targetIndex = resolveSectionPlanTabTarget({
        shiftKey: event.shiftKey,
        activeIndex: focusable.indexOf(document.activeElement as HTMLElement),
        focusableCount: focusable.length,
      });
      if (targetIndex === null) return;
      event.preventDefault();
      if (targetIndex < 0) panelRef.current.focus();
      else focusable[targetIndex]?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [adopting, onClose]);
  return (
    <div className="modal-mask" onClick={close}>
      <section ref={panelRef} className="plan-panel sketch" role="dialog" aria-modal="true"
        aria-labelledby="section-plan-title" aria-describedby="section-plan-content"
        aria-busy={streaming || adopting} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <h2 id="section-plan-title">🧩 AI 分部规划</h2>
        {(streaming || parseError || !plans?.length) && (
          <pre id="section-plan-content" className="plan-text">
            {text || '正在思考…'}
            {streaming && <span className="cursor">▎</span>}
          </pre>
        )}
        {!streaming && parseError && (
          <div className="plan-parse-error" role="alert">格式不符合要求，无法解析</div>
        )}
        {!streaming && !parseError && resolvedTitles.length > 0 && (
          <div id={plans?.length ? 'section-plan-content' : undefined} className="plan-preview">
            将创建 {resolvedTitles.length} 个部，并把结构卡写入各部大纲：
            {plans?.length ? (
              <div className="section-plan-cards">
                {plans.map((plan, index) => (
                  <article key={`${plan.title}-${index}`} className="section-plan-card">
                    <h3>第 {index + 1} 部 · {plan.title}</h3>
                    <p><b>承诺：</b>{plan.promise}</p>
                    <p><b>目标：</b>{plan.goal}</p>
                    <p><b>阻力：</b>{plan.obstacle}</p>
                    <p><b>推进：</b>{plan.progress}</p>
                    <p><b>高潮：</b>{plan.climax}</p>
                    <p><b>兑现：</b>{plan.payoff}</p>
                    <p><b>状态变化：</b>{plan.stateChange}</p>
                  </article>
                ))}
              </div>
            ) : <ol>{resolvedTitles.map((t, i) => <li key={i}>{t}</li>)}</ol>}
          </div>
        )}
        <div className="plan-actions">
          {!streaming && parseError ? (
            <button type="button" className="hbtn accent" onClick={onRetry}>🔄 重新生成</button>
          ) : (
            <button type="button" className="hbtn accent-2" disabled={disabled}
              onClick={() => { if (!disabled) onAdopt(resolvedTitles); }}>{adopting ? '正在创建…' : '✓ 采纳并创建这些部'}</button>
          )}
          <button type="button" className="hbtn" disabled={closeDisabled} onClick={close}>取消</button>
        </div>
      </section>
    </div>
  );
}
