import { useState } from 'react';
import { getTheme, toggleTheme } from '../theme';
import type { Theme } from '../theme';

export function TopBar({ title, streaming, statusText, onOpenSettings }: {
  title: string;
  streaming: boolean;
  statusText: string;
  onOpenSettings: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(getTheme());
  const label = theme === 'paper' ? '🌙 黑板' : '📄 白纸';
  return (
    <header className="topbar">
      <div className="topbar-title">📖 {title}</div>
      {streaming && statusText && (
        <div className="topbar-status">{statusText}<span className="dots" /></div>
      )}
      <div className="topbar-actions">
        <button className="hbtn" onClick={() => setTheme(toggleTheme())}>{label}</button>
        <button className="hbtn" onClick={onOpenSettings}>⚙️ 设置</button>
      </div>
    </header>
  );
}
