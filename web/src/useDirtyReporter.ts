import { useEffect, useRef } from 'react';

export interface DirtyReportState { reported: boolean }

export function reportDirtyTransition(
  state: DirtyReportState, dirty: boolean, callback?: (dirty: boolean) => void,
) {
  if (state.reported === dirty) return;
  state.reported = dirty;
  callback?.(dirty);
}

export function clearDirtyReport(
  state: DirtyReportState, callback?: (dirty: boolean) => void,
) {
  if (!state.reported) return;
  state.reported = false;
  callback?.(false);
}

// 页面容器常用内联函数把局部 dirty 映射到全局路径。回调身份会随父组件
// 每次渲染变化，不能放进“上报 + cleanup”effect 的依赖，否则 dirty=true 时
// cleanup(false) 与新 effect(true) 会驱动父组件无限来回渲染。
export function useDirtyReporter(
  dirty: boolean,
  onDirtyChange?: (dirty: boolean) => void,
) {
  const callbackRef = useRef(onDirtyChange);
  const stateRef = useRef<DirtyReportState>({ reported: false });
  callbackRef.current = onDirtyChange;

  useEffect(() => {
    reportDirtyTransition(stateRef.current, dirty, callbackRef.current);
  }, [dirty]);

  useEffect(() => () => {
    clearDirtyReport(stateRef.current, callbackRef.current);
  }, []);
}
