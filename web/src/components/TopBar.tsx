import { useState } from 'react';
import { getTheme, toggleTheme } from '../theme';
import type { Theme } from '../theme';

// 顶栏：左侧 📚 书架 返回按钮 + 书名 + 流式状态 + 主题/设置
export function TopBar({ title, streaming, statusText, onOpenSettings, onHome }: {
  title: string;
  streaming: boolean;
  statusText: string;
  onOpenSettings: () => void;
  onHome: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(getTheme());
  const label = theme === 'paper' ? '🌙 黑板' : '📄 白纸';
  return (
    <header className="topbar">
      <button className="hbtn mini" onClick={onHome}>📚 书架</button>
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
