import { MAX_CHAPTER_HANDOFF_FIELD_CHARS } from './limits.js';

export const CHAPTER_HANDOFF_FIELDS = Object.freeze([
  'viewpoint', 'time', 'location', 'ongoingAction', 'immediatePressure',
  'characterState', 'resourceState', 'knowledgeBoundary', 'unresolvedCausality',
]);

export const CHAPTER_HANDOFF_LABELS = Object.freeze({
  viewpoint: '章末视角/叙事焦点',
  time: '章末时间',
  location: '章末地点',
  ongoingAction: '正在进行的动作',
  immediatePressure: '尚未解除的即时压力',
  characterState: '在场人物末态',
  resourceState: '关键物品/资源末态',
  knowledgeBoundary: '读者与视角人物知识边界',
  unresolvedCausality: '仍在生效的未完因果',
});

export function emptyChapterHandoff() {
  return Object.fromEntries(CHAPTER_HANDOFF_FIELDS.map((field) => [field, '']));
}

export function normalizeChapterHandoff(value, {
  errorCode = 'BAD_CHAPTER_HANDOFF',
  sizeErrorCode = 'CHAPTER_HANDOFF_TOO_LARGE',
} = {}) {
  if (value === undefined) return emptyChapterHandoff();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  const normalized = emptyChapterHandoff();
  for (const field of CHAPTER_HANDOFF_FIELDS) {
    const raw = value[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') throw new Error(errorCode);
    const text = raw.trim();
    if (raw.length > MAX_CHAPTER_HANDOFF_FIELD_CHARS * 2
      || Array.from(text).length > MAX_CHAPTER_HANDOFF_FIELD_CHARS) {
      throw new Error(sizeErrorCode);
    }
    normalized[field] = text;
  }
  return normalized;
}

export function chapterHandoffHasContent(value) {
  const normalized = normalizeChapterHandoff(value);
  return CHAPTER_HANDOFF_FIELDS.some((field) => normalized[field]);
}

export function formatChapterHandoff(value) {
  // 这是提示词只读格式化路径。旧数据或外部调用可能显式传 null；写入路径
  // 仍由 normalizeChapterHandoff 严格拒绝，但读取不能因此让整次生成失败。
  if (value === null || value === undefined) return '';
  const normalized = normalizeChapterHandoff(value);
  return CHAPTER_HANDOFF_FIELDS.flatMap((field) => normalized[field]
    ? [`- ${CHAPTER_HANDOFF_LABELS[field]}：${normalized[field]}`]
    : []).join('\n');
}
