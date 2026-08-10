import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getApiProfiles, isAmbiguousApiFailure, isApiErrorCode, saveApiBookBinding,
} from '../api';
import type { ApiProfileLibrary, ApiTaskRoute } from '../types';
import { decodeTaskRoute, encodeTaskRoute } from './ApiProfilePanel';

const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function BookModelBindingPanel({
  bookId, disabled = false,
}: {
  bookId: string;
  disabled?: boolean;
}) {
  const [library, setLibrary] = useState<ApiProfileLibrary | null>(null);
  const [binding, setBinding] = useState<ApiTaskRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadToken = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const token = ++loadToken.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getApiProfiles(signal);
      if (token !== loadToken.current) return false;
      setLibrary(next);
      const saved = (next.bookBindings ?? []).find((item) => item.bookId === bookId);
      setBinding(saved ? { profileId: saved.profileId, model: saved.model } : null);
      return true;
    } catch (reason) {
      if (token !== loadToken.current || (reason instanceof DOMException
        && reason.name === 'AbortError')) return false;
      setError(messageOf(reason));
      return false;
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    const controller = new AbortController();
    setLibrary(null);
    setNotice(null);
    void load(controller.signal);
    return () => {
      controller.abort();
      loadToken.current += 1;
    };
  }, [load]);

  const savedBinding = library?.bookBindings?.find((item) => item.bookId === bookId);
  const savedRoute = savedBinding
    ? { profileId: savedBinding.profileId, model: savedBinding.model } : null;
  const dirty = encodeTaskRoute(binding) !== encodeTaskRoute(savedRoute);

  const save = async () => {
    if (!library || busy || !dirty) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveApiBookBinding(bookId, binding, library.revision);
      setLibrary(next);
      const stored = next.bookBindings.find((item) => item.bookId === bookId);
      setBinding(stored ? { profileId: stored.profileId, model: stored.model } : null);
      setNotice(stored
        ? `已固定为 ${stored.model}；本书所有模型任务都使用该模型。`
        : '已恢复跟随全局模型分工。');
    } catch (reason) {
      if (isApiErrorCode(reason, 'API_PROFILES_CONFLICT')
        || isApiErrorCode(reason, 'API_PROFILE_NOT_FOUND')
        || isAmbiguousApiFailure(reason)) await load();
      setError(messageOf(reason));
    } finally { setBusy(false); }
  };

  return <details className="book-model-binding sketch">
    <summary><strong>本书固定模型</strong><span>{savedBinding?.model ?? '跟随全局'}</span></summary>
    <p className="form-hint">
      固定后，正文、大纲、摘要、审稿和标题都使用同一模型，优先于全局分工；
      失败时不会自动回退。绑定保存在全局方案库，单书导出不携带 API Key。
    </p>
    {loading && !library && <p className="form-hint" role="status">正在读取模型方案…</p>}
    {error && <div className="settings-load-error sketch" role="alert">
      <span>{error}</span><button type="button" className="hbtn mini"
        onClick={() => { void load(); }}>刷新</button>
    </div>}
    {library && <div className="book-model-binding-form">
      <label>模型<select disabled={disabled || busy}
        value={encodeTaskRoute(binding)}
        onChange={(event) => {
          setBinding(decodeTaskRoute(event.target.value));
          setNotice(null);
        }}>
        <option value="">跟随全局模型分工</option>
        {library.profiles.flatMap((profile) => profile.models.map((model) =>
          <option key={`${profile.id}:${model}`}
            value={encodeTaskRoute({ profileId: profile.id, model })}>
            {profile.name} · {model}
          </option>))}
      </select></label>
      <button type="button" className="hbtn" disabled={disabled || busy || !dirty}
        onClick={() => { void save(); }}>{busy ? '保存中…' : '保存本书模型'}</button>
    </div>}
    {notice && <p className="form-hint" role="status">{notice}</p>}
  </details>;
}
