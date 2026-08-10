import {
  createContext, useCallback, useContext, useEffect, useReducer, useRef,
} from 'react';
import type { ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'info';
export interface ToastItem { id: number; type: ToastType; msg: string; }
export type ToastAction =
  | { kind: 'add'; toast: ToastItem }
  | { kind: 'remove'; id: number };

// 纯 reducer
export function toastReducer(state: ToastItem[], action: ToastAction): ToastItem[] {
  if (action.kind === 'add') return [...state, action.toast];
  return state.filter((t) => t.id !== action.id);
}

export interface ToastApi {
  success(msg: string): void;
  error(msg: string): void;
  info(msg: string): void;
}

export function toastAnnouncementRole(type: ToastType): 'alert' | 'status' {
  return type === 'error' ? 'alert' : 'status';
}

export function ToastMessage({
  toast, onClose,
}: {
  toast: ToastItem;
  onClose(): void;
}) {
  return (
    <div
      className={`toast sketch ${toast.type}`}
      role={toastAnnouncementRole(toast.type)}
      aria-atomic="true">
      <span>{toast.msg}</span>
      <button type="button" className="toast-x" aria-label="关闭通知" onClick={onClose}>×</button>
    </div>
  );
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useToast 必须在 ToastProvider 内使用');
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, dispatch] = useReducer(toastReducer, []);
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
  }, []);

  const push = useCallback((type: ToastType, msg: string) => {
    const id = ++seq.current;
    dispatch({ kind: 'add', toast: { id, type, msg } });
    // error 停留更久，需要用户注意
    const ttl = type === 'error' ? 6000 : 3500;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      dispatch({ kind: 'remove', id });
    }, ttl);
    timers.current.add(timer);
  }, []);

  const api = useRef<ToastApi>({
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  }).current;

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-stack">
        {items.map((t) => (
          <ToastMessage
            key={t.id}
            toast={t}
            onClose={() => dispatch({ kind: 'remove', id: t.id })} />
        ))}
      </div>
    </Ctx.Provider>
  );
}
