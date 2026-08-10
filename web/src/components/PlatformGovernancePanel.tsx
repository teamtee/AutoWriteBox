import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import type {
  PlatformApiStatus, PlatformConfirmation, PlatformConfirmationInput, SerializationSettings,
} from '../types';

const EMPTY_FORM: PlatformConfirmationInput = {
  platform: '', rulesUrl: '', aiPolicyUrl: '', contractReference: '',
  officialApiStatus: 'not-found', apiDocsUrl: '',
  confirmRules: false, confirmAiPolicy: false, confirmContract: false,
  confirmNoBypass: false,
};

const apiStatusLabels: Record<PlatformApiStatus, string> = {
  'not-found': '未找到官方发布接口',
  'not-authorized': '有接口，但未明确允许发布同步',
  authorized: '官方文档明确允许发布同步',
};

const syncReasonLabels: Record<string, string> = {
  OFFICIAL_API_REVIEW_REQUIRED_BEFORE_IMPLEMENTATION: '仅具备未来官方集成候选资格；当前仍不自动同步',
  PLATFORM_CONFIRMATION_STALE: '核对记录已过提醒周期，不能作为接口集成依据',
  OFFICIAL_API_NOT_FOUND: '没有官方接口证据，只能手动发布',
  OFFICIAL_API_NOT_AUTHORIZED: '接口未明确授权发布同步，只能手动发布',
  OFFICIAL_API_EVIDENCE_INCOMPLETE: '官方接口证据不完整，只能手动发布',
};

export function PlatformGovernancePanel({
  settings, disabled = false, onSave, onDelete,
}: {
  settings?: SerializationSettings;
  disabled?: boolean;
  onSave: (input: PlatformConfirmationInput) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const records = settings?.platformConfirmations ?? [];
  const [form, setForm] = useState<PlatformConfirmationInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState('');

  useEffect(() => {
    if (form.id && !records.some((record) => record.id === form.id)) setForm(EMPTY_FORM);
  }, [form.id, records]);

  const setText = (field: keyof PlatformConfirmationInput) => (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const setCheck = (field: keyof PlatformConfirmationInput) => (
    event: ChangeEvent<HTMLInputElement>,
  ) => setForm((current) => ({ ...current, [field]: event.target.checked }));
  const canSave = Boolean(settings?.revision)
    && form.platform.trim() && form.rulesUrl.trim() && form.aiPolicyUrl.trim()
    && form.contractReference.trim()
    && form.confirmRules && form.confirmAiPolicy && form.confirmContract && form.confirmNoBypass
    && (form.officialApiStatus !== 'authorized' || form.apiDocsUrl.trim());

  const submit = async () => {
    if (!canSave || saving || disabled) return;
    setSaving(true);
    try {
      if (await onSave(form)) setForm(EMPTY_FORM);
    } finally { setSaving(false); }
  };

  const edit = (record: PlatformConfirmation) => setForm({
    id: record.id,
    platform: record.platform,
    rulesUrl: record.rulesUrl,
    aiPolicyUrl: record.aiPolicyUrl,
    contractReference: record.contractReference,
    officialApiStatus: record.officialApiStatus,
    apiDocsUrl: record.apiDocsUrl,
    confirmRules: true,
    confirmAiPolicy: true,
    confirmContract: true,
    confirmNoBypass: true,
  });

  const remove = async (id: string) => {
    if (confirmingDeleteId !== id) {
      setConfirmingDeleteId(id);
      return;
    }
    setConfirmingDeleteId('');
    setSaving(true);
    try { await onDelete(id); }
    finally { setSaving(false); }
  };

  return <section className="serialization-section platform-governance">
    <header>
      <div>
        <h3>平台规则与合同核对</h3>
        <p>记录作者亲自打开官方页面核对的证据。30 天只是复查提醒，不代表平台规则在此期间不会变化，也不构成合规结论。</p>
      </div>
      <span>{records.filter((record) => record.reviewStatus === 'current').length} 条近期记录</span>
    </header>
    <aside className="platform-sync-policy">
      <strong>同步策略：仅手动</strong>
      <span>当前没有登录、验证码处理或自动上传功能。未来也只有“平台官方提供且明确允许发布”的 API 才能进入集成评估；不会绕过登录、验证码或平台限制。</span>
    </aside>

    {!!records.length && <div className="platform-records">{records.map((record) =>
      <article key={record.id} className={record.reviewStatus}>
        <header>
          <div><strong>{record.platform}</strong><span>{record.reviewStatus === 'current' ? '近期已核对' : '需要重新核对'}</span></div>
          <small>{new Date(record.checkedAt).toLocaleString()}</small>
        </header>
        <p>{record.contractReference}</p>
        <div className="platform-links">
          <a href={record.rulesUrl} target="_blank" rel="noreferrer">官方规则</a>
          <a href={record.aiPolicyUrl} target="_blank" rel="noreferrer">官方 AI 内容政策</a>
          {record.apiDocsUrl && <a href={record.apiDocsUrl} target="_blank" rel="noreferrer">官方 API 文档</a>}
        </div>
        <footer>
          <span>{apiStatusLabels[record.officialApiStatus]}；{syncReasonLabels[record.syncGate.reason] ?? record.syncGate.reason}</span>
          <div>
            <button className="hbtn" disabled={disabled || saving} onClick={() => edit(record)}>重新核对 / 编辑</button>
            <button className="hbtn" disabled={disabled || saving}
              onClick={() => { void remove(record.id); }}>
              {confirmingDeleteId === record.id ? '再次点击删除' : '删除记录'}
            </button>
          </div>
        </footer>
      </article>)}</div>}

    <div className="platform-confirmation-form">
      <h4>{form.id ? '更新核对记录' : '新增核对记录'}</h4>
      <div className="platform-fields">
        <label>平台名称<input maxLength={80} disabled={disabled || saving}
          value={form.platform} onChange={setText('platform')} placeholder="例如：起点读书" /></label>
        <label>官方作者规则链接<input type="url" maxLength={2048} disabled={disabled || saving}
          value={form.rulesUrl} onChange={setText('rulesUrl')} placeholder="https://…" /></label>
        <label>官方 AI 内容政策链接<input type="url" maxLength={2048} disabled={disabled || saving}
          value={form.aiPolicyUrl} onChange={setText('aiPolicyUrl')} placeholder="https://…" /></label>
        <label>官方接口状态<select disabled={disabled || saving}
          value={form.officialApiStatus} onChange={setText('officialApiStatus')}>
          {(Object.keys(apiStatusLabels) as PlatformApiStatus[]).map((status) =>
            <option key={status} value={status}>{apiStatusLabels[status]}</option>)}
        </select></label>
        {form.officialApiStatus === 'authorized' && <label>官方 API 文档链接<input type="url"
          maxLength={2048} disabled={disabled || saving} value={form.apiDocsUrl}
          onChange={setText('apiDocsUrl')} placeholder="必须能证明允许发布同步" /></label>}
      </div>
      <label className="platform-contract-reference">合同核对说明
        <textarea maxLength={500} disabled={disabled || saving}
          value={form.contractReference} onChange={setText('contractReference')}
          placeholder="例如：已在作者后台核对当前签约合同第 X 条；不要粘贴身份证、账号或合同全文。" />
      </label>
      <div className="platform-confirmations">
        <label><input type="checkbox" disabled={disabled || saving}
          checked={form.confirmRules} onChange={setCheck('confirmRules')} />我已打开并核对官方作者规则</label>
        <label><input type="checkbox" disabled={disabled || saving}
          checked={form.confirmAiPolicy} onChange={setCheck('confirmAiPolicy')} />我已打开并核对官方 AI 内容政策</label>
        <label><input type="checkbox" disabled={disabled || saving}
          checked={form.confirmContract} onChange={setCheck('confirmContract')} />我已核对自己当前适用的合同条款</label>
        <label><input type="checkbox" disabled={disabled || saving}
          checked={form.confirmNoBypass} onChange={setCheck('confirmNoBypass')} />我不会绕过登录、验证码或平台限制</label>
      </div>
      <div className="platform-form-actions">
        <button className="primary" disabled={disabled || saving || !canSave}
          onClick={() => { void submit(); }}>{saving ? '保存中…' : form.id ? '保存并刷新核对时间' : '保存人工核对记录'}</button>
        {form.id && <button className="hbtn" disabled={disabled || saving}
          onClick={() => setForm(EMPTY_FORM)}>取消编辑</button>}
      </div>
    </div>
  </section>;
}
