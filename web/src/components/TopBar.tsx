import { useState } from 'react';
import { getTheme, toggleTheme } from '../theme';
import type { Theme } from '../theme';

// 顶栏：左侧 📚 书架 返回按钮 + 书名 + 流式状态 + 主题/设置
export function TopBar({ title, streaming, busy = streaming, cancellable = streaming, statusText, onOpenSettings, onHome }: {
  title: string;
  streaming: boolean;
  busy?: boolean;
  cancellable?: boolean;
  statusText: string;
  onOpenSettings: () => void;
  onHome: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(getTheme());
  const label = theme === 'paper' ? '🌙 黑板' : '📄 白纸';
  return (
    <header className="topbar">
      {/* 可取消的模型请求仍允许回书架；其它不可中止的写操作完成前锁住导航。 */}
      <button className="hbtn mini topbar-home" disabled={busy && !cancellable} onClick={onHome}>📚 书架</button>
      <h1 className="topbar-title">📖 {title}</h1>
      {streaming && statusText && (
        <div className="topbar-status" role="status" aria-live="polite" aria-atomic="true">
          {statusText}<span className="dots" aria-hidden="true" />
        </div>
      )}
      <div className="topbar-actions">
        <button className="hbtn" onClick={() => setTheme(toggleTheme())}>{label}</button>
        <button className="hbtn" disabled={busy} onClick={onOpenSettings}>⚙️ 设置</button>
      </div>
    </header>
  );
}
