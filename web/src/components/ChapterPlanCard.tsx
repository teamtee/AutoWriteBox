import { useEffect, useRef, useState } from 'react';
import type {
  ChapterPlan, ChapterPlanDraftResult, ChapterPlanInput, ChapterPlanScene,
  ChapterPlanCarryoverItem, IncomingChapterPlanCarryover,
  ChapterPromiseActionOption, ChapterRhythmIntent,
} from '../types';

type ChapterPlanTextField = Exclude<
  keyof ChapterPlanInput,
  'scenes' | 'qualityProtocolVersion' | 'designProtocolVersion'
  | 'rhythmIntentVersion' | 'rhythmIntent'
>;
const FIELDS: Array<{
  key: ChapterPlanTextField;
  label: string;
  placeholder: string;
  maxLength: number;
}> = [
  { key: 'goal', label: '本章目标', placeholder: '谁想在本章完成什么？', maxLength: 500 },
  { key: 'obstacle', label: '主要阻碍', placeholder: '什么具体力量阻止目标？压力如何升级？', maxLength: 500 },
  { key: 'choice', label: '关键选择', placeholder: '人物必须主动做出什么选择，并承担什么代价？', maxLength: 500 },
  { key: 'payoff', label: '兑现 / 爽点', placeholder: '本章给读者兑现什么信息、情绪、能力或关系变化？', maxLength: 500 },
  { key: 'hook', label: '章末钩子', placeholder: '结尾留下哪一个真实矛盾、行动或信息差？', maxLength: 500 },
  { key: 'tensionArc', label: '张力曲线', placeholder: '按“压力来源；变化链（三个具体局势）；选择高点；兑现与余波”填写。', maxLength: 500 },
  { key: 'foreshadowing', label: '分层埋点', placeholder: '有任务时选一个叙事节拍，写认知变化、载体、行动后果、世界线作用和保留未知；无任务时说明聚焦边界。', maxLength: 500 },
  { key: 'worldExpansion', label: '世界边界扩张', placeholder: '按“展开前认知；既有依据；可验证证据；边界增量/机制深化；选择与代价；保留未知”填写。', maxLength: 500 },
  { key: 'decisionChain', label: '决策因果链', placeholder: '按“当前误判/未决；验证/争取行动；利益受损者；针对性反制；状态改写；后续索债”填写。', maxLength: 500 },
  { key: 'knowledgeDesign', label: '认知与证据边界', placeholder: '有判断任务时写问题、可见依据、允许结论、两个替代解释、两个交叉来源和保留未知；无任务时说明聚焦。', maxLength: 500 },
  { key: 'notes', label: '补充说明', placeholder: '必须出现或避免的场景、线索、人物状态等。', maxLength: 1000 },
];
const SCENE_FIELDS: Array<{
  key: Exclude<keyof ChapterPlanScene, 'title'>;
  label: string;
  placeholder: string;
}> = [
  { key: 'trigger', label: '承接触发', placeholder: '第1场承接上一章/直接诱因；后续场写上一场哪个结果迫使它发生？' },
  { key: 'desire', label: '人物欲望', placeholder: '谁此刻想得到什么？' },
  { key: 'obstacle', label: '现场阻碍', placeholder: '什么正在当场阻止他？' },
  { key: 'action', label: '人物行动', placeholder: '他具体做了什么，而不是想了什么？' },
  { key: 'turn', label: '局势转折', placeholder: '场景结束后，情况发生了什么变化？' },
  { key: 'cost', label: '代价 / 后果', placeholder: '选择造成什么损失、风险或新债务？' },
];
const MAX_SCENES = 12;
const BEAT_LABELS = {
  plant: '植入', pressure: '加压', misdirect: '公平误导',
  reinterpret: '变义', collide: '线索碰撞', payoff: '回收',
} as const;
const RHYTHM_FIELDS: Array<{
  key: keyof ChapterRhythmIntent; label: string; options: Array<[string, string]>;
}> = [
  { key: 'pressurePattern', label: '压力轨迹', options: [
    ['steady-rise', '单向升压'], ['wave-rise', '多轮起伏'],
    ['false-relief', '假缓解后反噬'], ['reversal-led', '关键反转主导'],
    ['choice-led', '关键选择抬压'], ['aftermath', '余波重组'],
  ] },
  { key: 'resolutionMethod', label: '破局方式', options: [
    ['none', '本章不破局'], ['force', '力量压制'], ['skill', '能力/技艺'],
    ['wit', '计谋判断'], ['negotiation', '谈判交换'], ['sacrifice', '主动牺牲'],
    ['cooperation', '协作'], ['endurance', '承受熬过'], ['discovery', '发现信息'],
    ['failure', '失败转场'], ['mixed', '混合'],
  ] },
  { key: 'payoffScale', label: '兑现规模', options: [
    ['none', '无兑现'], ['micro', '微兑现'], ['chapter', '本章兑现'],
    ['stage', '阶段兑现'], ['major', '重大兑现'],
  ] },
  { key: 'hookMechanism', label: '钩子机制', options: [
    ['none', '无钩子'], ['new-threat', '新威胁'], ['new-information', '新信息'],
    ['unfinished-action', '行动未完'], ['forced-choice', '被迫选择'],
    ['relationship-shift', '关系突变'], ['world-opening', '世界边界打开'],
    ['deadline', '期限逼近'], ['aftermath-question', '余波疑问'],
  ] },
  { key: 'costType', label: '关键代价', options: [
    ['none', '无新增代价'], ['physical', '身体'], ['resource', '资源'],
    ['identity', '身份'], ['relationship', '关系'], ['moral', '道德'],
    ['time', '时间'], ['position', '地位'], ['knowledge', '认知/秘密'], ['mixed', '混合'],
  ] },
];
const emptyRhythmIntent = (): ChapterRhythmIntent => ({
  pressurePattern: '', resolutionMethod: '', payoffScale: '', hookMechanism: '', costType: '',
});

const QUALITY_FORMATS = {
  tensionArc: '压力来源：；变化链：→→；选择高点：；兑现与余波：',
  foreshadowing: '旧线/阅读债务：；叙事节拍：；认知变化：→；具体载体：；当下作用：；行动影响：；世界线作用：；保留未知：',
  worldExpansion: '展开前认知：；既有依据：；可验证证据：；边界增量/机制深化：；选择与代价：；保留未知：',
} as const;
const DESIGN_FORMATS = {
  decisionChain: '当前误判/未决：；验证/争取行动：；利益受损者：；针对性反制：；状态改写：→；后续索债：',
  knowledgeDesign: '当前问题：；可见依据：；允许结论：；替代解释：｜；交叉验证：＋；保留未知：',
} as const;
const NO_FORESHADOWING_TASK_FORMAT =
  '无埋点理由：；本章聚焦：；既有未知处理：';
const NO_KNOWLEDGE_TASK_FORMAT =
  '无认知任务理由：；本章聚焦：；既有判断处理：';

const emptyScene = (): ChapterPlanScene => ({
  title: '', trigger: '', desire: '', obstacle: '', action: '', turn: '', cost: '',
});

export function chapterPlanInput(plan: ChapterPlan): ChapterPlanInput {
  return {
    qualityProtocolVersion: plan.qualityProtocolVersion,
    designProtocolVersion: plan.designProtocolVersion,
    rhythmIntentVersion: plan.rhythmIntentVersion,
    rhythmIntent: { ...plan.rhythmIntent },
    goal: plan.goal,
    obstacle: plan.obstacle,
    choice: plan.choice,
    payoff: plan.payoff,
    hook: plan.hook,
    tensionArc: plan.tensionArc,
    foreshadowing: plan.foreshadowing,
    worldExpansion: plan.worldExpansion,
    decisionChain: plan.decisionChain,
    knowledgeDesign: plan.knowledgeDesign,
    notes: plan.notes,
    scenes: plan.scenes.map((scene) => ({ ...scene, trigger: scene.trigger ?? '' })),
  };
}

export function chapterPlanDraftIsDirty(
  draft: ChapterPlanInput, plan: ChapterPlan,
): boolean {
  if (draft.qualityProtocolVersion !== plan.qualityProtocolVersion) return true;
  if (draft.designProtocolVersion !== plan.designProtocolVersion) return true;
  if (draft.rhythmIntentVersion !== plan.rhythmIntentVersion) return true;
  if (RHYTHM_FIELDS.some(({ key }) =>
    draft.rhythmIntent[key] !== plan.rhythmIntent[key])) return true;
  if (FIELDS.some(({ key }) => draft[key].trim() !== plan[key])) return true;
  if (draft.scenes.length !== plan.scenes.length) return true;
  return draft.scenes.some((scene, index) => {
    const saved = plan.scenes[index];
    return Object.keys(scene).some((field) =>
      (scene[field as keyof ChapterPlanScene] ?? '').trim()
        !== (saved[field as keyof ChapterPlanScene] ?? ''));
  });
}

export function activateChapterPlanQualityProtocol(
  current: ChapterPlanInput, field: keyof typeof QUALITY_FORMATS, value: string,
): ChapterPlanInput {
  return {
    ...current,
    // 编辑质量字段即进入当前协议，避免 v1 五栏校验与六栏界面提示错位。
    qualityProtocolVersion: 3,
    [field]: value,
  };
}

export function activateChapterPlanDesignProtocol(
  current: ChapterPlanInput, field: keyof typeof DESIGN_FORMATS, value: string,
): ChapterPlanInput {
  return { ...current, designProtocolVersion: 1, [field]: value };
}

export function chapterPlanQualityTemplate(current: ChapterPlanInput): ChapterPlanInput {
  const seed = <K extends keyof typeof QUALITY_FORMATS>(field: K): string => {
    const value = current[field].trim();
    const format = QUALITY_FORMATS[field];
    if (field === 'foreshadowing' && /^无埋点理由\s*[:：]/u.test(value)) return value;
    const firstLabel = format.slice(0, format.indexOf('：') + 1);
    if (!value) return format;
    return value.includes(firstLabel) ? value : format.replace('：；', `：${value}；`);
  };
  const legacyWorldExpansion = current.worldExpansion.trim();
  const worldExpansion = current.qualityProtocolVersion === 1
    && legacyWorldExpansion.startsWith('既有依据：')
    ? `${QUALITY_FORMATS.worldExpansion.slice(
      0, QUALITY_FORMATS.worldExpansion.indexOf('；') + 1,
    )}${legacyWorldExpansion}`
    : seed('worldExpansion');
  const seedDesign = <K extends keyof typeof DESIGN_FORMATS>(field: K): string => {
    const value = current[field].trim();
    const format = DESIGN_FORMATS[field];
    if (field === 'knowledgeDesign'
      && /^无认知任务理由\s*[:：]/u.test(value)) return value;
    const firstLabel = format.slice(0, format.indexOf('：') + 1);
    if (!value) return format;
    return value.includes(firstLabel) ? value : format.replace('：；', `：${value}；`);
  };
  return {
    ...current,
    qualityProtocolVersion: 3,
    designProtocolVersion: 1,
    tensionArc: seed('tensionArc'),
    foreshadowing: seed('foreshadowing'),
    worldExpansion,
    decisionChain: seedDesign('decisionChain'),
    knowledgeDesign: seedDesign('knowledgeDesign'),
  };
}

export function chapterPlanWithoutForeshadowingTask(
  current: ChapterPlanInput,
): ChapterPlanInput | null {
  const value = current.foreshadowing.trim();
  // 空字段或尚未填写的任务模板可安全切换；已有具体内容时不静默覆盖作者判断。
  if (value && value !== QUALITY_FORMATS.foreshadowing
    && value !== NO_FORESHADOWING_TASK_FORMAT) return null;
  return {
    ...current,
    qualityProtocolVersion: 3,
    foreshadowing: NO_FORESHADOWING_TASK_FORMAT,
  };
}

export function chapterPlanWithoutKnowledgeTask(
  current: ChapterPlanInput,
): ChapterPlanInput | null {
  const value = current.knowledgeDesign.trim();
  if (value && value !== DESIGN_FORMATS.knowledgeDesign
    && value !== NO_KNOWLEDGE_TASK_FORMAT) return null;
  return {
    ...current,
    designProtocolVersion: 1,
    knowledgeDesign: NO_KNOWLEDGE_TASK_FORMAT,
  };
}

export function generatedChapterPlanIsCurrent(
  result: ChapterPlanDraftResult, plan: Pick<ChapterPlan, 'revision'>,
): boolean {
  return result.basePlanRevision === plan.revision;
}

export function chapterPlanWithCarryover(
  draft: ChapterPlanInput, item: ChapterPlanCarryoverItem,
): ChapterPlanInput | null {
  const field = FIELDS.find(({ key }) => key === item.suggestedField);
  if (!field) return null;
  const line = `[承接上章] ${item.text}`;
  if (draft[item.suggestedField].includes(line)) return draft;
  const current = draft[item.suggestedField].trim();
  const next = current ? `${current}\n${line}` : line;
  return next.length > field.maxLength
    ? null
    : { ...draft, [item.suggestedField]: next };
}

export type ChapterPromiseAction = '推进债务' | '兑现债务' | '建立承诺' | '延期债务';

export function chapterPlanWithPromiseAction(
  draft: ChapterPlanInput, option: ChapterPromiseActionOption,
  action: ChapterPromiseAction,
): ChapterPlanInput | null {
  if (option.status === 'planned' && action !== '建立承诺') return null;
  if (option.status === 'open' && action === '建立承诺') return null;
  const token = `[${action}:${option.id}]`;
  if (`${draft.foreshadowing}\n${draft.notes}`.includes(`:${option.id}]`)) return draft;
  const target = action === '延期债务' ? 'notes' : 'foreshadowing';
  const suffix = action === '延期债务'
    ? `${token} 延期原因：；下一检查点：`
    : `${token} ${option.promise}`;
  const current = draft[target].trim();
  const debtLabel = '旧线/阅读债务：';
  const noTaskContract = /^无埋点理由\s*[:：]/u.test(current);
  const qualityForeshadowing = target === 'foreshadowing' && !current.includes(debtLabel)
    ? `旧线/阅读债务：${token}${current && !noTaskContract ? ` ${current}` : ''}；叙事节拍：；认知变化：→；具体载体：；当下作用：；行动影响：；世界线作用：；保留未知：`
    : '';
  const value = qualityForeshadowing || (target === 'foreshadowing'
    ? current.replace(debtLabel, `${debtLabel}${token} `)
    : current ? `${current}\n${suffix}` : suffix);
  const maxLength = FIELDS.find(({ key }) => key === target)?.maxLength ?? 0;
  return value.length > maxLength ? null : {
    ...draft,
    qualityProtocolVersion: target === 'foreshadowing' ? 3 : draft.qualityProtocolVersion,
    [target]: value,
  };
}

export function AiPlanCandidate({ result, replacingDirtyDraft, onAdopt, onDiscard }: {
  result: ChapterPlanDraftResult;
  replacingDirtyDraft: boolean;
  onAdopt: () => void;
  onDiscard: () => void;
}) {
  return (
    <section className="chapter-plan-ai-candidate" aria-label="AI 策划候选">
      <header>
        <div>
          <h4>AI 策划候选</h4>
          <p>先核对场景承接、状态变化与人物动机。采用后只会填入上方编辑草稿，仍需手动保存。</p>
        </div>
        <span>{result.plan.scenes.length} 个场景</span>
      </header>
      <dl className="chapter-plan-ai-summary">
        {FIELDS.map(({ key, label }) => result.plan[key] ? <div key={key}>
          <dt>{label}</dt><dd>{result.plan[key]}</dd>
        </div> : null)}
      </dl>
      <dl className="chapter-plan-ai-summary" aria-label="AI 节奏意图">
        {RHYTHM_FIELDS.map(({ key, label, options }) => <div key={key}>
          <dt>{label}</dt><dd>{options.find(([value]) =>
            value === result.plan.rhythmIntent[key])?.[1] ?? '未选择'}</dd>
        </div>)}
      </dl>
      <div className="chapter-plan-ai-scenes">
        {result.plan.scenes.map((scene, index) => (
          <article key={index}>
            <strong>场景 {index + 1}{scene.title ? ` · ${scene.title}` : ''}</strong>
            <dl>{SCENE_FIELDS.map(({ key, label }) => <div key={key}>
              <dt>{label}</dt><dd>{scene[key] ?? ''}</dd>
            </div>)}</dl>
          </article>
        ))}
      </div>
      <p className="chapter-plan-ai-warning">
        {replacingDirtyDraft
          ? '采用会替换当前未保存表单；候选已参考发起生成时的表单内容，请仍逐项核对。'
          : '采用不会写入磁盘，也不会触发正文生成。'}
      </p>
      <div className="chapter-plan-actions">
        <button className="hbtn primary" type="button" onClick={onAdopt}>
          采用为编辑草稿
        </button>
        <button className="hbtn" type="button" onClick={onDiscard}>丢弃候选</button>
      </div>
    </section>
  );
}

export function ChapterPlanCard({
  plan, incomingPlanCarryover, promiseActions = [], disabled = false,
  onSave, onGenerateDraft, onDirtyChange,
}: {
  plan: ChapterPlan;
  incomingPlanCarryover?: IncomingChapterPlanCarryover | null;
  promiseActions?: ChapterPromiseActionOption[];
  disabled?: boolean;
  onSave: (plan: ChapterPlanInput, expectedRevision: string) => Promise<ChapterPlan>;
  onGenerateDraft?: (
    seedPlan: ChapterPlanInput, expectedPlanRevision: string, signal: AbortSignal,
  ) => Promise<ChapterPlanDraftResult>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<ChapterPlanInput>(() => chapterPlanInput(plan));
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [candidate, setCandidate] = useState<ChapterPlanDraftResult>();
  const [error, setError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const previousPlan = useRef(plan);
  const generationAbort = useRef<AbortController | null>(null);
  const latestPlanRevision = useRef(plan.revision);
  latestPlanRevision.current = plan.revision;
  const dirty = chapterPlanDraftIsDirty(draft, plan);
  const pending = dirty || generating || Boolean(candidate);

  useEffect(() => {
    setDraft((current) => chapterPlanDraftIsDirty(current, previousPlan.current)
      ? current
      : chapterPlanInput(plan));
    previousPlan.current = plan;
  }, [plan]);
  useEffect(() => {
    if (candidate && !generatedChapterPlanIsCurrent(candidate, plan)) {
      setCandidate(undefined);
      setError('已保存策划在 AI 生成后发生变化，旧候选已作废；请基于最新版重新生成。');
    }
  }, [candidate, plan]);
  useEffect(() => onDirtyChange?.(pending), [pending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => () => generationAbort.current?.abort(), []);

  const generateDraft = async () => {
    if (!onGenerateDraft || disabled || saving || generating) return;
    const controller = new AbortController();
    generationAbort.current = controller;
    const requestedRevision = plan.revision;
    setGenerating(true);
    setCandidate(undefined);
    setError('');
    setConfirmDiscard(false);
    try {
      const result = await onGenerateDraft(draft, requestedRevision, controller.signal);
      if (controller.signal.aborted) return;
      if (result.basePlanRevision !== requestedRevision
        || latestPlanRevision.current !== result.basePlanRevision) {
        setError('策划卡在 AI 生成期间发生变化，旧候选未采用；请核对最新版后重试。');
        return;
      }
      setCandidate(result);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'AI 策划生成失败');
      }
    } finally {
      if (generationAbort.current === controller) {
        generationAbort.current = null;
        setGenerating(false);
      }
    }
  };

  const stopGeneration = () => {
    generationAbort.current?.abort();
    setError('已停止 AI 策划；当前编辑草稿没有被改动。');
  };

  const save = async () => {
    if (!dirty || disabled || saving || generating) return;
    setSaving(true);
    setError('');
    try {
      const saved = await onSave(draft, plan.revision);
      setDraft(chapterPlanInput(saved));
      previousPlan.current = saved;
      setConfirmDiscard(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '策划卡保存失败');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setDraft(chapterPlanInput(plan));
    setError('');
    setConfirmDiscard(false);
  };

  const updateScene = (
    index: number, field: keyof ChapterPlanScene, value: string,
  ) => {
    setDraft((current) => ({
      ...current,
      scenes: current.scenes.map((scene, sceneIndex) =>
        sceneIndex === index ? { ...scene, [field]: value } : scene),
    }));
    setConfirmDiscard(false);
    setError('');
  };

  const moveScene = (index: number, offset: number) => {
    setDraft((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.scenes.length) return current;
      const scenes = [...current.scenes];
      [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
      return { ...current, scenes };
    });
    setConfirmDiscard(false);
  };

  const addCarryover = (item: ChapterPlanCarryoverItem) => {
    const field = FIELDS.find(({ key }) => key === item.suggestedField);
    if (!field) return;
    const next = chapterPlanWithCarryover(draft, item);
    if (!next) {
      setError(`「${field.label}」空间不足，请先精简当前草稿再加入。`);
      return;
    }
    setDraft(next);
    setError('');
    setConfirmDiscard(false);
  };

  const addPromiseAction = (
    option: ChapterPromiseActionOption, action: ChapterPromiseAction,
  ) => {
    const next = chapterPlanWithPromiseAction(draft, option, action);
    if (!next) {
      setError(action === '延期债务'
        ? '补充说明空间不足，或该动作与债务状态不一致。'
        : '分层埋点空间不足，或该动作与债务状态不一致。');
      return;
    }
    setDraft(next);
    setError('');
    setConfirmDiscard(false);
  };

  return (
    <section className="chapter-plan-card sketch-alt">
      <header>
        <div>
          <h3>章节策划卡</h3>
          <p>生成与审稿都会读取已保存的作者意图；AI 候选需先采用、再保存才会生效。</p>
        </div>
        <span>{generating ? 'AI 策划中' : candidate ? 'AI 候选待确认'
          : plan.isEmpty && !dirty ? '未策划' : dirty ? '未保存' : '已保存'}</span>
      </header>
      <div className="chapter-plan-ai-actions">
        <div>
          <strong>先策划，再写正文</strong>
          <p>AI 会参考全书、本部、前情、核心循环和当前表单，只生成可比较的候选。</p>
          <p>{draft.qualityProtocolVersion === 3
            ? '质量合同 v3 已启用：伏笔按叙事节拍与认知变化推进，并与人物行动、世界线和正文证据相连。'
            : draft.qualityProtocolVersion === 2
              ? '质量合同 v2 兼容模式：已有认知边界继续可用；填入新版模板后升级伏笔节拍链。'
            : draft.qualityProtocolVersion === 1
              ? '质量合同 v1 兼容模式：已有结构继续可用；填入新版模板或采用 AI 候选后升级认知边界。'
              : '旧策划兼容模式：填入新版模板或采用 AI 候选后，会升级为可校验的质量合同。'}</p>
          <p>{draft.designProtocolVersion === 1
            ? '叙事设计合同 v1 已启用：要求人物误判、主动验证、利益受损者、针对性反制、状态改写，以及有限结论和交叉证据。'
            : '旧策划未记录叙事设计合同；升级后会防止反派送证据、万能解法和章尾外挂事故。'}</p>
        </div>
        {generating
          ? <button className="hbtn" type="button" onClick={stopGeneration}>停止 AI 策划</button>
          : <><button className="hbtn" type="button"
              disabled={disabled || saving}
              onClick={() => setDraft((current) => chapterPlanQualityTemplate(current))}>
              填入完整写作合同模板
            </button><button className="hbtn" type="button"
              disabled={disabled || saving}
              onClick={() => setDraft((current) => {
                const next = chapterPlanWithoutForeshadowingTask(current);
                if (!next) {
                  setError('分层埋点已有具体内容；请先核对并手动清空，避免误删作者策划。');
                  return current;
                }
                setError('');
                return next;
              })}>
              本章无埋点任务
            </button><button className="hbtn" type="button"
              disabled={disabled || saving}
              onClick={() => setDraft((current) => {
                const next = chapterPlanWithoutKnowledgeTask(current);
                if (!next) {
                  setError('认知与证据边界已有具体内容；请先核对并手动清空，避免误删作者策划。');
                  return current;
                }
                setError('');
                return next;
              })}>
              本章无认知任务
            </button><button className="hbtn accent" type="button"
              disabled={disabled || saving || !onGenerateDraft}
              onClick={() => void generateDraft()}>✨ AI 生成策划候选</button></>}
      </div>
      {plan.readiness && <section className={`chapter-plan-readiness ${plan.readiness.ready ? 'ready' : 'attention'}`}
        aria-label="写前判断状态">
        <header>
          <strong>{plan.readiness.ready ? '✓ 写前判断已齐备' : '写前判断仍有留白'}</strong>
          <span>{dirty ? '当前草稿尚未保存'
            : plan.readiness.ready ? '这些意图会作为明确要求发送'
              : '未填栏目会交给模型自行决定'}</span>
        </header>
        <div>{plan.readiness.checks.map((check) => <p key={check.id}
          className={check.pass ? 'pass' : check.advisory ? 'advisory' : 'risk'}>
          <b>{check.pass ? '✓' : check.advisory ? '△' : '○'} {check.label}</b>
          <span>{check.detail}</span>
        </p>)}</div>
      </section>}
      {!!promiseActions.length && <section className="chapter-promise-actions" aria-label="当前阅读债务">
        <header><div><h4>当前阅读债务</h4>
          <p>选择后只把后台锚点加入策划草稿；正文 API 不得把 ID 写进小说。</p></div></header>
        <div>{promiseActions.map((option) => {
          const actionTokens = option.status === 'planned'
            ? (['建立承诺'] as ChapterPromiseAction[])
            : (['推进债务', '兑现债务', '延期债务'] as ChapterPromiseAction[]);
          return <article key={option.id} className={option.urgent ? 'urgent' : ''}>
            <div><strong>{option.promise}</strong><p>
              {option.status === 'planned' ? '计划中，尚未向读者建立'
                : option.overdue ? '已逾期' : option.urgent ? '已进入兑现窗口' : '已建立，尚未到窗口'}
              {' · '}预计第 {option.expectedStartChapter}–{option.expectedEndChapter} 章
            </p>{option.lastBeat && <small>
              上一有效节拍：{BEAT_LABELS[option.lastBeat]}
              {option.lastReaderAfter ? `；当前读者判断：${option.lastReaderAfter}` : ''}
              {option.recentBeatPattern?.length
                ? `；近三拍：${option.recentBeatPattern.map((beat) => BEAT_LABELS[beat]).join(' → ')}`
                : ''}
            </small>}</div>
            <div>{actionTokens.map((action) => {
              const added = `${draft.foreshadowing}\n${draft.notes}`.includes(`:${option.id}]`);
              return <button key={action} className="hbtn" type="button"
                disabled={disabled || saving || generating || added}
                onClick={() => addPromiseAction(option, action)}>{added ? '已安排' : action}</button>;
            })}</div>
          </article>;
        })}</div>
      </section>}
      {!!incomingPlanCarryover?.items.length && (
        <section className="incoming-plan-carryover" aria-label="上章未决策划项">
          <header>
            <div>
              <h4>上章未决策划项</h4>
              <p>来自「{incomingPlanCarryover.sourceChapterTitle || '上一完成章'}」的差异回顾。它们不是已发生事实，只有手动加入并保存后才成为本章策划。</p>
            </div>
          </header>
          <p className="incoming-plan-carryover-summary">{incomingPlanCarryover.summary}</p>
          <div className="incoming-plan-carryover-list">
            {incomingPlanCarryover.items.map((item) => {
              const line = `[承接上章] ${item.text}`;
              const added = draft[item.suggestedField].includes(line);
              const field = FIELDS.find(({ key }) => key === item.suggestedField);
              return <article key={item.sourceTarget}>
                <div><strong>{item.text}</strong><p>{item.reason}</p>
                  <small>建议放入：{field?.label ?? item.suggestedField}</small></div>
                <button className="hbtn" type="button"
                  disabled={disabled || saving || generating || added}
                  onClick={() => addCarryover(item)}>{added ? '已加入草稿' : '加入本章草稿'}</button>
              </article>;
            })}
          </div>
        </section>
      )}
      <section className="chapter-rhythm-intent" aria-label="写前节奏意图">
        <header><div><h4>写前节奏意图</h4>
          <p>选的是本章准备怎样制造起伏和兑现，不是正文措辞。系统会与最近五章比较，只提示有证据的重复风险。</p>
        </div></header>
        <div className="chapter-plan-fields">
          {RHYTHM_FIELDS.map(({ key, label, options }) => <label key={key}>{label}
            <select aria-label={label} disabled={disabled || saving || generating}
              value={draft.rhythmIntent[key]}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current, rhythmIntentVersion: 1,
                  rhythmIntent: { ...current.rhythmIntent, [key]: event.target.value },
                } as ChapterPlanInput));
                setConfirmDiscard(false);
                setError('');
              }}>
              <option value="">请选择</option>
              {options.map(([value, optionLabel]) =>
                <option key={value} value={value}>{optionLabel}</option>)}
            </select>
          </label>)}
        </div>
        {draft.rhythmIntentVersion === 0 && <button className="hbtn" type="button"
          disabled={disabled || saving || generating}
          onClick={() => setDraft((current) => ({
            ...current, rhythmIntentVersion: 1, rhythmIntent: emptyRhythmIntent(),
          }))}>升级为节奏意图 v1</button>}
      </section>
      <div className="chapter-plan-fields">
        {FIELDS.map((field) => (
          <label key={field.key}>{field.label}
            <textarea
              aria-label={field.label}
              disabled={disabled || saving || generating}
              maxLength={field.maxLength}
              value={draft[field.key]}
              placeholder={field.placeholder}
              onChange={(event) => {
                setDraft((current) => field.key in QUALITY_FORMATS
                  ? activateChapterPlanQualityProtocol(
                    current, field.key as keyof typeof QUALITY_FORMATS, event.target.value,
                  )
                  : field.key in DESIGN_FORMATS
                    ? activateChapterPlanDesignProtocol(
                      current, field.key as keyof typeof DESIGN_FORMATS,
                      event.target.value,
                    )
                    : { ...current, [field.key]: event.target.value });
                setConfirmDiscard(false);
                setError('');
              }} />
          </label>
        ))}
      </div>
      <section className="chapter-scene-plan" aria-label="场景链">
        <header>
          <div>
            <h4>场景链</h4>
            <p>按发生顺序拆开关键戏。第一场承接前情，后续场必须由上一场结果触发，并让局势发生变化。</p>
          </div>
          <button className="hbtn" type="button"
            disabled={disabled || saving || generating || draft.scenes.length >= MAX_SCENES}
            onClick={() => setDraft((current) => ({
              ...current, scenes: [...current.scenes, emptyScene()],
            }))}>＋ 添加场景</button>
        </header>
        {draft.scenes.length === 0
          ? <p className="chapter-scene-empty">正文生成前至少补一个完整场景，避免把关键选择和兑现写成概述。</p>
          : <div className="chapter-scene-list">
            {draft.scenes.map((scene, index) => (
              <article className="chapter-scene" key={index}>
                <header>
                  <strong>场景 {index + 1}</strong>
                  <input aria-label={`场景 ${index + 1} 名称`} maxLength={80}
                    disabled={disabled || saving || generating} value={scene.title}
                    placeholder="可选名称，如：第一次分火"
                    onChange={(event) => updateScene(index, 'title', event.target.value)} />
                  <div className="chapter-scene-actions">
                    <button className="hbtn" type="button" aria-label={`上移场景 ${index + 1}`}
                      disabled={disabled || saving || generating || index === 0}
                      onClick={() => moveScene(index, -1)}>↑</button>
                    <button className="hbtn" type="button" aria-label={`下移场景 ${index + 1}`}
                      disabled={disabled || saving || generating || index === draft.scenes.length - 1}
                      onClick={() => moveScene(index, 1)}>↓</button>
                    <button className="hbtn" type="button" aria-label={`删除场景 ${index + 1}`}
                      disabled={disabled || saving || generating}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        scenes: current.scenes.filter((_, sceneIndex) => sceneIndex !== index),
                      }))}>删除</button>
                  </div>
                </header>
                <div className="chapter-scene-fields">
                  {SCENE_FIELDS.map((field) => (
                    <label key={field.key}>{field.label}
                      <textarea aria-label={`场景 ${index + 1} ${field.label}`}
                        disabled={disabled || saving || generating} maxLength={300}
                        value={scene[field.key] ?? ''} placeholder={field.placeholder}
                        onChange={(event) => updateScene(index, field.key, event.target.value)} />
                    </label>
                  ))}
                </div>
              </article>
            ))}
          </div>}
      </section>
      {error && <p className="chapter-plan-error" role="alert">{error}</p>}
      {candidate && <AiPlanCandidate
        result={candidate}
        replacingDirtyDraft={dirty}
        onAdopt={() => {
          setDraft({ ...candidate.plan, scenes: candidate.plan.scenes.map((scene) => ({ ...scene })) });
          setCandidate(undefined);
          setError('');
          setConfirmDiscard(false);
        }}
        onDiscard={() => {
          setCandidate(undefined);
          setError('');
        }} />}
      <div className="chapter-plan-actions">
        <button className="hbtn primary" type="button"
          disabled={!dirty || disabled || saving || generating} onClick={() => void save()}>
          {saving ? '保存中…' : '保存策划卡'}
        </button>
        {dirty && <button className="hbtn" type="button"
          disabled={disabled || saving || generating}
          onClick={discard}>{confirmDiscard ? '确认放弃？' : '放弃修改'}</button>}
      </div>
    </section>
  );
}
