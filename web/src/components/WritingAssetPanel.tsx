import { useEffect, useState } from 'react';
import type {
  WritingAsset, WritingAssetBookBinding, WritingAssetLibrary, WritingAssetScene,
  WritingAssetSourceKind,
} from '../types';
import {
  createWritingAssetReference, deleteWritingAsset, extractWritingAsset,
  getWritingAssets, isApiErrorCode, saveWritingAssetBookBinding,
} from '../api';

export const MAX_WRITING_ASSET_FILE_BYTES = 512 * 1024;
export const MAX_WRITING_ASSET_SOURCE_CHARS = 100_000;
export const MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS = 10_000;

const SOURCE_KIND_LABELS: Record<WritingAssetSourceKind, string> = {
  self: '用户原创',
  'own-previous': '本人旧作',
  authorized: '已获授权',
  'public-domain': '公共领域',
  excerpt: '外部短摘录',
  'link-only': '仅登记链接',
  'book-native': '本书原生文风',
};
const IMPORT_SOURCE_KINDS: WritingAssetSourceKind[] = [
  'self', 'own-previous', 'authorized', 'public-domain', 'excerpt', 'link-only',
];

const RIGHTS_NOTE_REQUIRED = new Set<WritingAssetSourceKind>([
  'authorized', 'public-domain', 'excerpt',
]);
const SCENE_LABELS: Record<WritingAssetScene, string> = {
  battle: '战斗', dialogue: '对话', mystery: '悬疑',
  romance: '感情', daily: '日常', climax: '高潮',
};

function emptyBookBinding(): WritingAssetBookBinding {
  return {
    nativeAssetId: null, primaryAssetId: null, auxiliaryAssetIds: [],
    sceneAssetIds: {}, chapterScenes: {},
  };
}

export function isSupportedWritingAssetFile(file: Pick<File, 'name' | 'type'>) {
  const lower = file.name.toLowerCase();
  return lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.markdown')
    || file.type === 'text/plain' || file.type === 'text/markdown';
}

export async function readWritingAssetFile(file: File) {
  if (!isSupportedWritingAssetFile(file)) {
    throw new Error('第一版仅支持 UTF-8 编码的 TXT、MD 或 Markdown 文件');
  }
  if (file.size === 0) throw new Error('文件为空，请选择包含正文的文件');
  if (file.size > MAX_WRITING_ASSET_FILE_BYTES) {
    throw new Error('文件超过 512 KB，请截取有代表性的片段后再导入');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，请转换编码后重试');
  }
  text = text.replace(/^\uFEFF/u, '');
  if (!text.trim()) throw new Error('文件中没有可分析的正文');
  if (text.length > MAX_WRITING_ASSET_SOURCE_CHARS) {
    throw new Error('正文超过 10 万字符，请截取有代表性的片段后再提取');
  }
  return text;
}

function baseName(fileName: string) {
  return fileName.replace(/\.(?:txt|md|markdown)$/iu, '').trim();
}

function AssetDetail({ asset }: { asset: WritingAsset }) {
  if (!asset.style || !asset.story) return null;
  const rows = ([
    ['叙事视角', asset.style.narrative], ['句式节奏', asset.style.sentenceRhythm],
    ['词汇语言', asset.style.vocabulary], ['对话', asset.style.dialogue],
    ['对话比例', asset.style.dialogueRatio], ['描写', asset.style.description],
    ['幽默感', asset.style.humor], ['情绪', asset.style.emotion],
    ['情绪温度', asset.style.emotionTemperature],
    ['冲突频率', asset.style.conflictFrequency], ['爽点类型', asset.style.payoffType],
    ['冲突与兑现', asset.style.conflictAndPayoff], ['章节牵引', asset.style.chapterHooks],
    ['题材承诺', asset.story.premisePattern], ['主角驱力', asset.story.protagonistDrive],
    ['冲突引擎', asset.story.conflictEngine], ['升级方式', asset.story.escalation],
    ['阶段结构', asset.story.arcStructure], ['单章模式', asset.story.chapterPattern],
    ['兑现模式', asset.story.payoffPattern], ['追读模式', asset.story.hookPattern],
  ] as [string, string][]).filter((row) => row[1]);
  return (
    <details className="asset-detail">
      <summary>查看完整提取结果</summary>
      <dl>{rows.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}</dl>
      <h4>可直接使用的文风指令</h4>
      <p>{asset.style.prompt}</p>
      {!!asset.style.avoid.length && <><h4>避免</h4><ul>{asset.style.avoid.map((item) => <li key={item}>{item}</li>)}</ul></>}
      {!!asset.story.reusableTechniques.length && <><h4>可复用技法</h4><ul>{asset.story.reusableTechniques.map((item) => <li key={item}>{item}</li>)}</ul></>}
      {!!asset.story.uncertainties.length && <><h4>不确定项</h4><ul>{asset.story.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></>}
    </details>
  );
}

export function WritingAssetPanel({ bookId, applyDisabled = false, onApplyStyle }: {
  bookId: string;
  applyDisabled?: boolean;
  onApplyStyle: (asset: WritingAsset) => boolean;
}) {
  const [library, setLibrary] = useState<WritingAssetLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [savingBinding, setSavingBinding] = useState(false);
  const [name, setName] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceKind, setSourceKind] = useState<WritingAssetSourceKind>('self');
  const [sourceText, setSourceText] = useState('');
  const [workNote, setWorkNote] = useState('');
  const [rightsNote, setRightsNote] = useState('');
  const [genres, setGenres] = useState('');
  const [sceneTags, setSceneTags] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');

  const linkOnly = sourceKind === 'link-only';
  const rightsNoteRequired = RIGHTS_NOTE_REQUIRED.has(sourceKind);

  const reload = async (signal?: AbortSignal) => {
    const next = await getWritingAssets(signal);
    setLibrary(next);
    setError(null);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    reload(controller.signal)
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason?.message ?? reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const text = await readWritingAssetFile(file);
      const inferredName = baseName(file.name);
      setSourceText(text);
      setSourceName(file.name);
      if (!name.trim()) setName(inferredName);
      setError(null);
      setNotice(`已读取 ${file.name}，确认名称后即可提取`);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  };

  const extract = async () => {
    if (extracting) return;
    if (!name.trim() || !sourceName.trim()) {
      setError('请填写资产名称和来源说明');
      return;
    }
    if (linkOnly && !referenceUrl.trim()) {
      setError('仅链接记录必须填写参考链接');
      return;
    }
    if (!linkOnly && !sourceText.trim()) {
      setError('请粘贴创作样本或导入文档');
      return;
    }
    if (rightsNoteRequired && !rightsNote.trim()) {
      setError('该来源类型需要填写权利说明');
      return;
    }
    if (sourceText.length > MAX_WRITING_ASSET_SOURCE_CHARS) {
      setError('正文超过 10 万字符，请截取有代表性的片段后再提取');
      return;
    }
    if (sourceKind === 'excerpt'
      && sourceText.length > MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS) {
      setError('外部短摘录最多 1 万字符，请只保留分析所需片段');
      return;
    }
    setExtracting(true);
    setError(null);
    setNotice(null);
    try {
      const metadata = {
        workNote: workNote.trim(),
        rightsNote: rightsNote.trim(),
        genres: genres.split(/[，,]/u).map((item) => item.trim()).filter(Boolean),
        sceneTags: sceneTags.split(/[，,]/u).map((item) => item.trim()).filter(Boolean),
        referenceUrl: referenceUrl.trim(),
      };
      const result = linkOnly
        ? await createWritingAssetReference({
          name: name.trim(), sourceName: sourceName.trim(), sourceKind: 'link-only',
          ...metadata,
        })
        : await extractWritingAsset({
          name: name.trim(), sourceName: sourceName.trim(), sourceKind, sourceText,
          ...metadata,
        });
      setLibrary((current) => ({
        revision: result.revision,
        assets: [result.asset, ...(current?.assets ?? [])],
        bookBindings: current?.bookBindings ?? {},
      }));
      setName('');
      setSourceName('');
      setSourceText('');
      setWorkNote('');
      setRightsNote('');
      setGenres('');
      setSceneTags('');
      setReferenceUrl('');
      setNotice(linkOnly
        ? `已登记参考链接“${result.asset.name}”，未调用模型`
        : `已生成资产“${result.asset.name}”`);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setExtracting(false);
    }
  };

  const remove = async (asset: WritingAsset) => {
    if (!library || deletingId) return;
    setDeletingId(asset.id);
    setError(null);
    try {
      await deleteWritingAsset(asset.id, library.revision);
      await reload();
      setConfirmDeleteId(null);
      setNotice(`已删除资产“${asset.name}”；已应用到书籍的文风不会变化`);
    } catch (reason) {
      if (isApiErrorCode(reason, 'ASSET_CONFLICT') || isApiErrorCode(reason, 'ASSET_NOT_FOUND')) {
        try { await reload(); } catch { /* 保留原始冲突提示 */ }
      }
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setDeletingId(null);
    }
  };

  const saveBinding = async (binding: WritingAssetBookBinding) => {
    if (!library || savingBinding) return;
    setSavingBinding(true);
    setError(null);
    try {
      const result = await saveWritingAssetBookBinding(bookId, binding, library.revision);
      setLibrary((current) => current ? {
        ...current,
        revision: result.revision,
        bookBindings: { ...(current.bookBindings ?? {}), [bookId]: result.binding },
      } : current);
      setNotice('本书资产绑定已保存；生成时只发送所选资产的结构化卡片。');
    } catch (reason) {
      if (isApiErrorCode(reason, 'ASSET_CONFLICT')) {
        try { await reload(); } catch { /* 保留冲突提示 */ }
      }
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSavingBinding(false);
    }
  };

  const binding = library?.bookBindings?.[bookId] ?? emptyBookBinding();
  const usableAssets = library?.assets.filter(
    (asset) => asset.style && asset.source.kind !== 'book-native',
  ) ?? [];
  const nativeAssets = library?.assets.filter(
    (asset) => asset.style && asset.source.kind === 'book-native'
      && asset.source.bookId === bookId,
  ) ?? [];

  return (
    <details className="writing-assets sketch">
      <summary><strong>创作资产库</strong><span>从片段或文档提取文风与故事结构</span></summary>
      <div className="asset-extractor">
        <div className="asset-form-grid">
          <label>资产名称<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例：克制冷硬·快节奏" /></label>
          <label>来源说明<input maxLength={200} value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="例：本人创作的第一章" /></label>
          <label>来源类型<select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as WritingAssetSourceKind)}>
            {IMPORT_SOURCE_KINDS.map((value) => <option key={value} value={value}>{SOURCE_KIND_LABELS[value]}</option>)}
          </select></label>
          {!linkOnly && <label className="asset-file">导入文档<input aria-label="导入文档" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></label>}
        </div>
        <div className="asset-metadata-grid">
          <label>作品/章节备注<input maxLength={500} value={workNote} onChange={(event) => setWorkNote(event.target.value)} placeholder="例：旧作第二卷，第 18 章" /></label>
          <label>权利说明{rightsNoteRequired ? '（必填）' : ''}<input maxLength={500} value={rightsNote} onChange={(event) => setRightsNote(event.target.value)} placeholder="例：本人作品；或已获何种授权" /></label>
          <label>适用题材<input maxLength={500} value={genres} onChange={(event) => setGenres(event.target.value)} placeholder="都市，悬疑（逗号分隔）" /></label>
          <label>场景标签<input maxLength={500} value={sceneTags} onChange={(event) => setSceneTags(event.target.value)} placeholder="战斗，对话，高潮（逗号分隔）" /></label>
        </div>
        <label>参考链接{linkOnly ? '（必填）' : '（可选）'}<input type="url" maxLength={2048} value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="https://…（只登记地址，不抓取网页）" /></label>
        {!linkOnly && <label>创作样本<textarea aria-label="创作样本" maxLength={sourceKind === 'excerpt' ? MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS : MAX_WRITING_ASSET_SOURCE_CHARS} value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="粘贴有代表性的正文片段，或导入 UTF-8 TXT/Markdown 文件…" /></label>}
        <div className="asset-extractor-foot">
          <span>{linkOnly
            ? '仅保存链接和备注，不抓取网页、不调用模型。'
            : '点击提取后，样本会进入当前 API 请求；本地只保存短预览、长度和指纹，不保存全文。'}</span>
          <button className="hbtn accent" disabled={extracting || (linkOnly ? !referenceUrl.trim() : !sourceText.trim())} onClick={() => { void extract(); }}>{extracting ? '处理中…' : linkOnly ? '登记参考链接' : '✨ 一键提取资产'}</button>
        </div>
      </div>
      {error && <div className="asset-message error" role="alert">{error}</div>}
      {notice && <div className="asset-message" role="status">{notice}</div>}
      {loading ? <div className="empty-hint">正在读取资产库…</div>
        : !library?.assets.length ? <div className="empty-hint">还没有资产。粘贴片段或导入文档即可开始。</div>
          : <><section className="asset-bindings sketch-alt"><h3>本书文风绑定</h3><p>本书原生文风优先于外部主文风；辅助资产最多 3 个。场景资产只在章节选择了对应场景时进入生成上下文。</p><div className="asset-binding-grid">
            <label>本书原生文风<select disabled={savingBinding} value={binding.nativeAssetId ?? ''} onChange={(event) => { void saveBinding({ ...binding, nativeAssetId: event.target.value || null }); }}><option value="">尚未绑定</option>{nativeAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
            <label>主文风<select disabled={savingBinding} value={binding.primaryAssetId ?? ''} onChange={(event) => { void saveBinding({ ...binding, primaryAssetId: event.target.value || null }); }}><option value="">不绑定</option>{usableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
            <label>辅助文风（按住 Ctrl/⌘ 多选）<select multiple size={Math.min(4, Math.max(2, usableAssets.length))} disabled={savingBinding} value={binding.auxiliaryAssetIds} onChange={(event) => {
              const selected = Array.from(event.currentTarget.selectedOptions, (option) => option.value)
                .filter((id) => id !== binding.primaryAssetId).slice(0, 3);
              void saveBinding({ ...binding, auxiliaryAssetIds: selected });
            }}>{usableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
          </div><div className="asset-scene-grid">{Object.entries(SCENE_LABELS).map(([scene, label]) => <label key={scene}>{label}参考<select disabled={savingBinding} value={binding.sceneAssetIds[scene as WritingAssetScene] ?? ''} onChange={(event) => {
            const sceneAssetIds = { ...binding.sceneAssetIds };
            if (event.target.value) sceneAssetIds[scene as WritingAssetScene] = event.target.value;
            else delete sceneAssetIds[scene as WritingAssetScene];
            void saveBinding({ ...binding, sceneAssetIds });
          }}><option value="">不绑定</option>{usableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>)}</div></section><div className="asset-library-tools"><a className="hbtn" href="/api/writing-assets/export" download="auto-novel-box-writing-assets.json">导出资产 JSON</a><span>导出包含结构化卡片、来源、链接和书籍绑定，不包含原始样本全文。</span></div><div className="asset-list">{library.assets.map((asset) => (
            <article className="asset-card sketch-alt" key={asset.id}>
              <header><div><h3>{asset.name}</h3><span>{SOURCE_KIND_LABELS[asset.source.kind]} · {asset.source.name}{asset.source.length ? ` · ${asset.source.length.toLocaleString()} 字符` : ''}</span></div>
                {asset.story && <span className={`asset-evidence evidence-${asset.story.evidenceLevel}`}>结构证据 {asset.story.evidenceLevel}</span>}</header>
              {asset.source.workNote && <p><strong>作品/章节：</strong>{asset.source.workNote}</p>}
              {asset.source.rightsNote && <p><strong>权利说明：</strong>{asset.source.rightsNote}</p>}
              {!!asset.source.genres.length && <p><strong>题材：</strong>{asset.source.genres.join('、')}</p>}
              {!!asset.source.sceneTags.length && <p><strong>场景：</strong>{asset.source.sceneTags.join('、')}</p>}
              {asset.source.referenceUrl && <p><strong>参考链接：</strong><a href={asset.source.referenceUrl} target="_blank" rel="noreferrer">打开原始页面</a></p>}
              {asset.style && asset.story
                ? <><p><strong>文风：</strong>{asset.style.summary}</p><p><strong>结构：</strong>{asset.story.summary}</p></>
                : <p>该记录仅作来源索引，未提取或保存网页正文。</p>}
              <AssetDetail asset={asset} />
              <div className="asset-actions">
                {asset.style && <button className="hbtn accent" disabled={applyDisabled} title={applyDisabled ? '请先保存或放弃当前文风草稿' : '填入文风基调框，检查后再保存'} onClick={() => {
                  const applied = onApplyStyle(asset);
                  setNotice(applied ? `已把“${asset.name}”填入文风基调，请检查后点击保存` : '当前文风有未保存修改，请先保存或放弃');
                }}>填入本书文风（待保存）</button>}
                {confirmDeleteId === asset.id
                  ? <button className="hbtn" disabled={deletingId === asset.id} onClick={() => { void remove(asset); }}>{deletingId === asset.id ? '删除中…' : '确认删除？'}</button>
                  : <button className="hbtn" disabled={!!deletingId} onClick={() => setConfirmDeleteId(asset.id)}>删除资产</button>}
              </div>
            </article>
          ))}</div></>}
    </details>
  );
}
