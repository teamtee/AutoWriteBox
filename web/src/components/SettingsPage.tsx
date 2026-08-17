import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '../types';
import {
  discoverApiModels, getConfig, isAmbiguousApiFailure, isApiErrorCode, saveConfig,
} from '../api';
import { createLatestAbortGate, runExclusiveAction } from '../asyncAction';
import { useToast } from './Toast';
import { useBeforeUnloadWarning } from './VersionedBox';
import { ApiProfilePanel } from './ApiProfilePanel';

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function loadSettingsConfig({
  load,
  onSuccess,
  onFailure,
  isCurrent = () => true,
}: {
  load: () => Promise<Config>;
  onSuccess: (config: Config) => void;
  onFailure: (message: string) => void;
  isCurrent?: () => boolean;
}) {
  try {
    const config = await load();
    if (!isCurrent()) return null;
    onSuccess(config);
    return config;
  } catch (error) {
    if (!isCurrent()) return null;
    onFailure(messageOf(error));
    return null;
  }
}

export async function saveSettingsConfig({
  config,
  save,
  isAmbiguousFailure,
}: {
  config: Config;
  save: (config: Config) => Promise<Config>;
  isAmbiguousFailure: (error: unknown) => boolean;
}) {
  try {
    return await save(config);
  } catch (error) {
    if (!isAmbiguousFailure(error)) throw error;
    // 响应可能在服务端落盘后丢失；服务端会把相同修订号和相同目标配置
    // 的重放识别为幂等成功。只重试一次，避免离线时无限请求。
    return save(config);
  }
}

const CONFIG_DRAFT_FIELDS: Array<keyof Config> = [
  'baseUrl', 'model', 'apiKey', 'chapterWordTarget', 'requestTimeoutMs',
  'modelContextChars',
];

export function hasSettingsDraft(config: Config, loaded: Config | null): boolean {
  return loaded !== null
    && CONFIG_DRAFT_FIELDS.some((field) => config[field] !== loaded[field]);
}

export function shouldConfirmSettingsDiscard(dirty: boolean, confirmed: boolean): boolean {
  return dirty && !confirmed;
}

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<Config>({
    baseUrl: '', model: '', apiKey: '', chapterWordTarget: 3000,
    requestTimeoutMs: 300000, modelContextChars: 500000, revision: '',
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadedCfg, setLoadedCfg] = useState<Config | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const savingRef = useRef(false);
  const loadGate = useRef(createLatestAbortGate()).current;
  const toast = useToast();
  const loadConfig = useCallback(async () => {
    const { token, signal } = loadGate.begin();
    setLoading(true);
    setLoadError(null);
    await loadSettingsConfig({
      load: () => getConfig(signal),
      isCurrent: () => loadGate.owns(token),
      onSuccess: (config) => {
        setCfg(config);
        setLoadedCfg(config);
        setConfirmClose(false);
        setConfirmReload(false);
        setDiscoveredModels([]);
        setDiscoveryMessage(null);
      },
      onFailure: (message) => {
        setLoadError(message);
        toast.error('读取设置失败：' + message);
      },
    });
    if (loadGate.owns(token)) setLoading(false);
  }, [loadGate, toast]);
  useEffect(() => {
    void loadConfig();
    return () => loadGate.invalidate();
  }, [loadConfig, loadGate]);
  const dirty = hasSettingsDraft(cfg, loadedCfg);
  useBeforeUnloadWarning(dirty || saving);
  const set = (k: keyof Config) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = k === 'chapterWordTarget' || k === 'requestTimeoutMs'
      || k === 'modelContextChars' ? Number(e.target.value) : e.target.value;
    setConfirmClose(false);
    setConfirmReload(false);
    setDiscoveredModels([]);
    setDiscoveryMessage(null);
    setCfg((current) => {
      // 换 API 地址时不能沿用旧密钥，避免将密钥意外发给新服务。
      if (k === 'baseUrl' && value !== current.baseUrl && current.apiKey === 'sk-****') {
        return { ...current, baseUrl: String(value), apiKey: '' };
      }
      if (k === 'chapterWordTarget') return { ...current, chapterWordTarget: Number(value) };
      if (k === 'requestTimeoutMs') return { ...current, requestTimeoutMs: Number(value) };
      if (k === 'modelContextChars') return { ...current, modelContextChars: Number(value) };
      return { ...current, [k]: String(value) };
    });
  };
  const save = async () => {
    if (loading || loadError) return;
    const saved = await runExclusiveAction({
      isRunning: () => savingRef.current,
      setRunning: (running) => { savingRef.current = running; setSaving(running); },
      task: async () => {
        try {
          const s = await saveSettingsConfig({
            config: cfg,
            save: saveConfig,
            isAmbiguousFailure: isAmbiguousApiFailure,
          });
          setCfg(s);
          setLoadedCfg(s);
          toast.success('✓ 设置已保存');
          return true;
        } catch (e) {
          if (isApiErrorCode(e, 'CONFIG_CONFLICT')) {
            setLoadError('CONFIG_CONFLICT');
            toast.error('保存设置失败：' + messageOf(e));
          } else if (isAmbiguousApiFailure(e)) {
            setLoadError('SAVE_UNCONFIRMED');
            toast.error('保存结果连续未确认；请重新读取设置核对最终状态');
          } else {
            toast.error('保存设置失败：' + messageOf(e));
          }
          return false;
        }
      },
    });
    if (saved) onClose();
  };
  const close = () => {
    if (shouldConfirmSettingsDiscard(dirty, confirmClose)) {
      setConfirmClose(true);
      setConfirmReload(false);
      return;
    }
    onClose();
  };
  const reload = () => {
    if (shouldConfirmSettingsDiscard(dirty, confirmReload)) {
      setConfirmReload(true);
      setConfirmClose(false);
      return;
    }
    setConfirmReload(false);
    void loadConfig();
  };
  const discoverModels = async () => {
    if (!loadedCfg || dirty || discovering || loading || loadError || saving) return;
    setDiscovering(true);
    setDiscoveryMessage(null);
    try {
      const result = await discoverApiModels({
        target: 'current', expectedConfigRevision: loadedCfg.revision,
      });
      setDiscoveredModels(result.models);
      const suffix = result.truncated ? '（列表过长，只保留前 500 个）' : '';
      if (!result.models.length) {
        setDiscoveryMessage(`连接成功，但服务没有返回模型${suffix}`);
      } else if (!result.currentModelAvailable) {
        setDiscoveryMessage(`连接成功，发现 ${result.models.length} 个模型；当前模型不在服务列表中${suffix}`);
      } else {
        setDiscoveryMessage(`连接成功，发现 ${result.models.length} 个模型${suffix}`);
      }
    } catch (error) {
      setDiscoveryMessage(`连接检查失败：${messageOf(error)}`);
    } finally {
      setDiscovering(false);
    }
  };
  const formDisabled = loading || !!loadError || saving || discovering;
  return (
    <div className="settings-page">
      <article className="paper sketch">
        <h1 className="paper-title">API 设置</h1>
        <ApiProfilePanel
          config={loadedCfg}
          settingsDirty={dirty}
          disabled={loading || saving || !!loadError}
          onActivated={(config) => {
            setCfg(config);
            setLoadedCfg(config);
            setDiscoveredModels([]);
            setDiscoveryMessage(null);
            setConfirmClose(false);
            setConfirmReload(false);
          }} />
        <form className="core-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {loading && <div className="form-hint" role="status">正在读取已保存的设置…</div>}
          {loadError && <div className="settings-load-error sketch" role="alert">
            <span>{loadError === 'CONFIG_CONFLICT'
              ? '另一页面已经更新设置，已禁止用旧页面覆盖；请重新读取后再修改。'
              : loadError === 'SAVE_UNCONFIRMED'
                ? '保存结果连续未确认；已禁止继续保存，请重新读取服务器最终状态。'
              : '无法确认当前配置，已禁止保存以避免覆盖原有 API Key。'}</span>
            <button type="button" className={confirmReload ? 'hbtn mini accent' : 'hbtn mini'}
              disabled={loading} onClick={reload}>
              {confirmReload ? '确认丢弃并读取？' : '重新读取'}
            </button>
          </div>}
          <label>Base URL<input name="baseUrl" required maxLength={2048} disabled={formDisabled} value={cfg.baseUrl} onChange={set('baseUrl')} placeholder="https://api.deepseek.com/v1" spellCheck={false} autoCapitalize="none" /></label>
          <label>模型<input name="model" required maxLength={256} disabled={formDisabled} value={cfg.model} onChange={set('model')} placeholder="deepseek-chat" spellCheck={false} autoCapitalize="none" list="discovered-api-models" /></label>
          <datalist id="discovered-api-models">{discoveredModels.map((model) => <option key={model} value={model} />)}</datalist>
          <label>API Key<input name="apiKey" type="password" autoComplete="off" maxLength={8192} disabled={formDisabled} value={cfg.apiKey} onChange={set('apiKey')} placeholder="sk-..." spellCheck={false} autoCapitalize="none" /></label>
          <div className="form-hint">生成前必须填写 Base URL 和模型名；带 API Key 的远程服务必须使用 HTTPS，本地免密服务可不填 Key。</div>
          <label>每章目标字数<input name="chapterWordTarget" type="number" min="3000" max="50000" step="1" disabled={formDisabled} value={cfg.chapterWordTarget} onChange={set('chapterWordTarget')} /></label>
          <div className="form-hint">最低 3000 字。订阅分成按千字计算，短章几乎都是关键场景被压成概述的结果；它是体量下限，不是生成上限。</div>
          <label>API 超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="3600000" step="1" disabled={formDisabled} value={cfg.requestTimeoutMs} onChange={set('requestTimeoutMs')} /></label>
          <label>模型上下文窗口（字符）<input name="modelContextChars" type="number" min="16000" max="2000000" step="1000" disabled={formDisabled} value={cfg.modelContextChars} onChange={set('modelContextChars')} />
            <small>不知道时保留 500000；32k 窗口模型可填 32000。服务端仍以 500000 作为本地输入硬上限。</small>
          </label>
          <div className="btn-row">
            <button type="button" className="hbtn" disabled={formDisabled || dirty || !loadedCfg?.baseUrl || !loadedCfg.model}
              onClick={() => { void discoverModels(); }}>{discovering ? '检查中…' : '检查连接 / 发现模型'}</button>
            <button type="submit" className="hbtn accent-2" disabled={formDisabled}>{loading ? '读取中…' : saving ? '保存中…' : '保存'}</button>
            <button type="button" className={confirmClose ? 'hbtn accent' : 'hbtn'} disabled={saving}
              onClick={close}>{confirmClose ? '确认放弃并返回？' : '返回'}</button>
          </div>
          {dirty && <div className="form-hint">请先保存当前 API 设置，再检查连接；检查不会发起正文生成。</div>}
          {discoveryMessage && <div className="form-hint" role="status">{discoveryMessage}</div>}
        </form>
      </article>
    </div>
  );
}
