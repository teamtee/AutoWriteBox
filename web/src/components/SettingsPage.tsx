import { useEffect, useState } from 'react';
import type { Config } from '../types';
import { getConfig, saveConfig } from '../api';
import { useToast } from './Toast';

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<Config>({ baseUrl: '', model: '', apiKey: '', chapterWordTarget: 2000 });
  const toast = useToast();
  useEffect(() => { getConfig().then(setCfg); }, []);
  const set = (k: keyof Config) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg({ ...cfg, [k]: k === 'chapterWordTarget' ? Number(e.target.value) : e.target.value });
  return (
    <div className="settings-page">
      <article className="paper sketch">
        <h2 className="paper-title">API 设置</h2>
        <div className="core-form">
          <label>Base URL<input value={cfg.baseUrl} onChange={set('baseUrl')} placeholder="https://api.deepseek.com/v1" /></label>
          <label>模型<input value={cfg.model} onChange={set('model')} placeholder="deepseek-chat" /></label>
          <label>API Key<input value={cfg.apiKey} onChange={set('apiKey')} placeholder="sk-..." /></label>
          <label>每章目标字数<input type="number" value={cfg.chapterWordTarget} onChange={set('chapterWordTarget')} /></label>
          <div className="btn-row">
            <button className="hbtn accent-2" onClick={async () => { const s = await saveConfig(cfg); setCfg(s); toast.success('✓ 设置已保存'); onClose(); }}>保存</button>
            <button className="hbtn" onClick={onClose}>返回</button>
          </div>
        </div>
      </article>
    </div>
  );
}
