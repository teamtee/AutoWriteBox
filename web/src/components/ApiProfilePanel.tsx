import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateApiProfile, deleteApiProfile, discoverApiModels, getApiProfiles, getConfig,
  isAmbiguousApiFailure, isApiErrorCode, saveApiProfile, saveApiTaskRoutes,
} from '../api';
import type {
  ApiModelTask, ApiProfileLibrary, ApiTaskRoute, ApiTaskRoutes, Config,
} from '../types';
import { useToast } from './Toast';

const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const TASK_LABELS: Record<ApiModelTask, string> = {
  chapter: '正文', outline: '大纲 / 设定', digest: '摘要 / 记忆',
  review: '审稿', title: '书名 / 章名',
};
const EMPTY_TASK_ROUTES: ApiTaskRoutes = {
  chapter: null, outline: null, digest: null, review: null, title: null,
};

export function encodeTaskRoute(route: ApiTaskRoute | null) {
  return route ? JSON.stringify([route.profileId, route.model]) : '';
}

export function decodeTaskRoute(value: string): ApiTaskRoute | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === 'string' && typeof parsed[1] === 'string'
      ? { profileId: parsed[0], model: parsed[1] } : null;
  } catch { return null; }
}

export function parseProfileModels(value: string) {
  return [...new Set(value.split(/[\n,，]/u).map((item) => item.trim()).filter(Boolean))];
}

export function mergeDiscoveredProfileModels(selectedModel: string, discovered: string[]) {
  return [selectedModel, ...discovered]
    .filter((model, index, all) => all.indexOf(model) === index)
    .slice(0, 50);
}

export function ApiProfilePanel({
  config, settingsDirty, disabled, onActivated,
}: {
  config: Config | null;
  settingsDirty: boolean;
  disabled: boolean;
  onActivated: (config: Config) => void;
}) {
  const [library, setLibrary] = useState<ApiProfileLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [confirmActivateId, setConfirmActivateId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const [taskRoutes, setTaskRoutes] = useState<ApiTaskRoutes>(EMPTY_TASK_ROUTES);
  const loadToken = useRef(0);
  const toast = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    const token = ++loadToken.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getApiProfiles(signal);
      if (token !== loadToken.current) return false;
      setLibrary(next);
      setSelectedModels(Object.fromEntries(
        next.profiles.map((profile) => [profile.id, profile.selectedModel]),
      ));
      setTaskRoutes(next.taskRoutes ?? EMPTY_TASK_ROUTES);
      return true;
    } catch (reason) {
      if (token !== loadToken.current || (reason instanceof DOMException
        && reason.name === 'AbortError')) return false;
      setError(messageOf(reason));
      return false;
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      loadToken.current += 1;
    };
  }, [load]);

  const saveCurrent = async () => {
    if (!library || !config || busy || settingsDirty) return;
    const models = parseProfileModels(modelsText || config.model);
    if (!models.includes(config.model)) models.unshift(config.model);
    setBusy(true); setError(null);
    try {
      await saveApiProfile({
        name, note, models, selectedModel: config.model, useCurrentConfig: true,
      }, library.revision, config.revision);
      setName(''); setNote(''); setModelsText('');
      await load();
      toast.success('✓ 当前 API 设置已保存为方案');
    } catch (reason) {
      if (isApiErrorCode(reason, 'API_PROFILES_CONFLICT')
        || isApiErrorCode(reason, 'CONFIG_CONFLICT')
        || isAmbiguousApiFailure(reason)) await load();
      setError(messageOf(reason));
    }
    finally { setBusy(false); }
  };

  const activate = async (profileId: string) => {
    if (!library || !config || busy) return;
    if (settingsDirty && confirmActivateId !== profileId) {
      setConfirmActivateId(profileId);
      setConfirmDeleteId(null);
      return;
    }
    setBusy(true); setError(null);
    try {
      const result = await activateApiProfile(
        profileId, selectedModels[profileId], library.revision, config.revision,
      );
      setLibrary(result.library);
      setTaskRoutes(result.library.taskRoutes ?? EMPTY_TASK_ROUTES);
      onActivated(result.config);
      setConfirmActivateId(null);
      toast.success(`✓ 已切换到 ${result.config.model}`);
    } catch (reason) {
      if (isApiErrorCode(reason, 'API_PROFILES_CONFLICT')
        || isApiErrorCode(reason, 'CONFIG_CONFLICT')
        || isAmbiguousApiFailure(reason)) {
        const [nextConfig] = await Promise.all([
          getConfig().catch(() => null), load(),
        ]);
        if (nextConfig) onActivated(nextConfig);
      }
      setConfirmActivateId(null);
      setError(messageOf(reason));
    }
    finally { setBusy(false); }
  };

  const remove = async (profileId: string) => {
    if (!library || busy) return;
    if (confirmDeleteId !== profileId) {
      setConfirmDeleteId(profileId);
      setConfirmActivateId(null);
      return;
    }
    setBusy(true); setError(null);
    try {
      await deleteApiProfile(profileId, library.revision);
      setConfirmDeleteId(null);
      await load();
      toast.success('API 方案已删除；当前正在使用的配置不会被清空');
    } catch (reason) {
      if (isApiErrorCode(reason, 'API_PROFILES_CONFLICT')
        || isAmbiguousApiFailure(reason)) await load();
      setError(messageOf(reason));
    }
    finally { setBusy(false); }
  };

  const discover = async (profileId: string) => {
    if (!library || busy) return;
    const profile = library.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    setBusy(true); setDiscoveringId(profileId); setError(null);
    try {
      const result = await discoverApiModels({
        target: 'profile', profileId, expectedProfilesRevision: library.revision,
      });
      if (!result.models.length) {
        toast.success('✓ 连接成功；服务没有返回可同步的模型');
        return;
      }
      const selectedModel = selectedModels[profileId] ?? profile.selectedModel;
      const models = mergeDiscoveredProfileModels(selectedModel, result.models);
      await saveApiProfile({
        id: profile.id,
        name: profile.name,
        note: profile.note,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        models,
        selectedModel,
      }, library.revision);
      await load();
      const omitted = result.truncated || result.models.length + 1 > models.length;
      toast.success(`✓ 连接成功，已同步 ${models.length} 个模型${omitted ? '（已按方案上限截断）' : ''}`);
    } catch (reason) {
      if (isApiErrorCode(reason, 'API_PROFILES_CONFLICT')
        || isAmbiguousApiFailure(reason)) await load();
      setError(messageOf(reason));
    } finally {
      setDiscoveringId(null);
      setBusy(false);
    }
  };

  const saveRouting = async () => {
    if (!library || busy) return;
    setBusy(true); setError(null);
    try {
      const next = await saveApiTaskRoutes(taskRoutes, library.revision);
      setLibrary(next);
      setTaskRoutes(next.taskRoutes);
      toast.success('✓ 模型分工已保存');
    } catch (reason) {
      if (isApiErrorCode(reason, 'API_PROFILES_CONFLICT')
        || isAmbiguousApiFailure(reason)) await load();
      setError(messageOf(reason));
    } finally { setBusy(false); }
  };

  const routingDirty = library
    ? JSON.stringify(taskRoutes) !== JSON.stringify(library.taskRoutes ?? EMPTY_TASK_ROUTES)
    : false;

  return <details className="api-profiles sketch">
    <summary><strong>API 快速切换</strong><span>{library?.profiles.length ?? 0} 个服务方案</span></summary>
    <p className="form-hint">一个服务可登记多个模型；切换只使用你明确选择的模型，失败时不会静默改用其它模型。</p>
    {loading && !library && <p className="form-hint" role="status">正在读取 API 方案…</p>}
    {error && <div className="settings-load-error sketch" role="alert"><span>{error}</span><button type="button" className="hbtn mini" onClick={() => { void load(); }}>刷新</button></div>}
    {library && <>
      <div className="api-profile-list">{library.profiles.map((profile) => <article
        className={library.activeProfileId === profile.id ? 'api-profile active' : 'api-profile'} key={profile.id}>
        <header><div><strong>{profile.name}</strong><span>{profile.baseUrl}</span></div>{library.activeProfileId === profile.id && <b>当前</b>}</header>
        {profile.note && <p>{profile.note}</p>}
        <label>模型<select disabled={disabled || busy} value={selectedModels[profile.id] ?? profile.selectedModel}
          onChange={(event) => setSelectedModels((current) => ({ ...current, [profile.id]: event.target.value }))}>
          {profile.models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select></label>
        <footer><button type="button" className="hbtn accent-2" disabled={disabled || busy}
          onClick={() => { void activate(profile.id); }}>
          {confirmActivateId === profile.id ? '确认丢弃草稿并切换？' : '应用此方案'}
        </button><button type="button" className="hbtn" disabled={disabled || busy}
          onClick={() => { void discover(profile.id); }}>
          {discoveringId === profile.id ? '检查中…' : '检查并同步模型'}
        </button><button type="button" className="hbtn" disabled={disabled || busy}
          onClick={() => { void remove(profile.id); }}>
          {confirmDeleteId === profile.id ? '再次点击确认删除' : '删除方案'}
        </button></footer>
      </article>)}</div>
      <section className="api-task-routing">
        <h3>模型分工</h3>
        <p className="form-hint">未指定的任务使用当前默认连接；指定模型失败时不会静默回退。</p>
        <div>{(Object.entries(TASK_LABELS) as Array<[ApiModelTask, string]>).map(([task, label]) =>
          <label key={task}>{label}<select disabled={disabled || busy}
            value={encodeTaskRoute(taskRoutes[task])}
            onChange={(event) => setTaskRoutes((current) => ({
              ...current, [task]: decodeTaskRoute(event.target.value),
            }))}>
            <option value="">当前默认{config?.model ? ` · ${config.model}` : ''}</option>
            {library.profiles.flatMap((profile) => profile.models.map((model) =>
              <option key={`${profile.id}:${model}`} value={encodeTaskRoute({ profileId: profile.id, model })}>
                {profile.name} · {model}
              </option>))}
          </select></label>)}</div>
        <button type="button" className="hbtn" disabled={disabled || busy || !routingDirty}
          onClick={() => { void saveRouting(); }}>保存模型分工</button>
      </section>
      <div className="api-profile-create">
        <h3>保存当前连接为方案</h3>
        <label>方案名称<input maxLength={80} disabled={disabled || busy || settingsDirty} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：DeepSeek 主力" /></label>
        <label>模型列表<textarea disabled={disabled || busy || settingsDirty} value={modelsText} onChange={(event) => setModelsText(event.target.value)} placeholder={config?.model ? `${config.model}\n另一个模型` : '每行一个模型'} /></label>
        <label>用途备注<input maxLength={200} disabled={disabled || busy || settingsDirty} value={note} onChange={(event) => setNote(event.target.value)} placeholder="正文、大纲或低成本摘要" /></label>
        <button type="button" className="hbtn" disabled={disabled || busy || settingsDirty || !name.trim() || !config?.baseUrl || !config.model}
          onClick={() => { void saveCurrent(); }}>保存当前设置为方案</button>
        {settingsDirty && <p className="form-hint">请先保存或重新读取上方 API 设置，再把已确认连接加入方案库。</p>}
      </div>
    </>}
  </details>;
}
