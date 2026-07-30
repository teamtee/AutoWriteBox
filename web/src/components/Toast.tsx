import { createContext, useCallback, useContext, useReducer, useRef } from 'react';
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

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useToast 必须在 ToastProvider 内使用');
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, dispatch] = useReducer(toastReducer, []);
  const seq = useRef(0);

  const push = useCallback((type: ToastType, msg: string) => {
    const id = ++seq.current;
    dispatch({ kind: 'add', toast: { id, type, msg } });
    // error 停留更久，需要用户注意
    const ttl = type === 'error' ? 6000 : 3500;
    setTimeout(() => dispatch({ kind: 'remove', id }), ttl);
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
          <div key={t.id} className={`toast sketch ${t.type}`}>
            <span>{t.msg}</span>
            <button className="toast-x" onClick={() => dispatch({ kind: 'remove', id: t.id })}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
