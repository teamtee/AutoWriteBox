export const WORLD_BIBLE_SECTION_LABELS = Object.freeze([
  '一句话世界钩子',
  '独特机制',
  '底层规则与代价',
  '空间层级与可达边界',
  '社会生态与日常后果',
  '势力与利益冲突',
  '历史伤口与当前火药桶',
  '主角切口与升级路径',
  '持续看点与标志性场面',
  '分阶段揭示路线',
  '秘密分层与认知边界',
  '禁止便利设定与保留未知',
]);

export const MIN_GENERATED_WORLD_BIBLE_CHARS = 1_800;
export const MIN_WORLD_BIBLE_SECTION_CHARS = 50;
export const WORLD_APPEAL_SCENE_LABELS = Object.freeze([
  '日常生计', '规则博弈', '关系交换', '势力冲突', '探索发现', '阶段兑现',
]);
export const WORLD_APPEAL_SCENE_FIELDS = Object.freeze([
  '看点', '行动', '阻碍', '代价', '变奏边界',
]);
export const WORLD_KNOWLEDGE_BOUNDARY_LABELS = Object.freeze([
  '作者底层真相', '当前读者已知', '当前主角已知',
  '关键势力认知差', '下一阶段可验证', '保留未知',
]);
export const WORLD_REVEAL_STAGE_LABELS = Object.freeze([
  '当前生活圈', '中期势力与地域', '长线文明与历史',
]);
export const WORLD_REVEAL_STAGE_FIELDS = Object.freeze([
  '阅读承诺', '可验证证据', '人物行动', '选择与代价',
  '认知增量', '保留未知', '进入下一层门槛',
]);
const EMPTY_CONTRACT_TEXT = /^(?:待定|待补充|待完善|暂无|不知道|具体内容|略|无)[。！!？?]?$/u;

export const WORLD_BIBLE_EXECUTION_GUIDANCE = [
  '【世界圣经使用边界】\n',
  '世界圣经是作者后台全貌，不等于读者或角色已经知道。底层真相、历史答案、势力秘密、',
  '分阶段揭示路线与保留未知只能约束因果、潜台词和伏笔，不能被旁白、角色或全知切镜提前说破。\n',
  '写正文前先从已发生摘要、已确认长期记忆、人物知识边界和本章策划判断“当前已知”；',
  '本章若展开世界，只能让人物通过行动中可触碰、可核验的证据，从当前已知推进一层，并让新认知改变选择或代价。',
  '先对照“分阶段揭示路线”判断当前层级；没有在正文中完成上一层的进入门槛，就不得越级调用中期或长线真相。',
  '章序只能帮助判断进度，不能机械规定第几章自动解锁下一层；解锁必须由人物行动和已发生证据证明。',
  '已经揭示的规则应直接用于行动，不重复当作新谜底讲解；尚未揭示的内容只留下符合当前视角的结果、矛盾或痕迹。\n',
].join('');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sectionContent(source, label, nextLabel) {
  const startMarker = `【${label}】`;
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const contentStart = start + startMarker.length;
  const end = nextLabel ? source.indexOf(`【${nextLabel}】`, contentStart) : source.length;
  return source.slice(contentStart, end < 0 ? source.length : end).trim();
}

function markedSegments(source, labels) {
  const markers = labels.map((label) => `〔${label}〕`);
  const indexes = markers.map((marker) => source.indexOf(marker));
  if (indexes.some((index) => index < 0)
    || indexes.some((index, offset) => offset > 0 && indexes[offset - 1] >= index)
    || markers.some((marker) => source.split(marker).length !== 2)) return null;
  return markers.map((marker, index) => source.slice(
    indexes[index] + marker.length, indexes[index + 1] ?? source.length,
  ).trim());
}

function markedFieldValues(source, fields) {
  const markers = fields.map((field) => `${field}：`);
  const indexes = markers.map((marker) => source.indexOf(marker));
  if (indexes.some((index) => index < 0)
    || indexes.some((index, offset) => offset > 0 && indexes[offset - 1] >= index)
    || markers.some((marker) => source.split(marker).length !== 2)) return null;
  const values = markers.map((marker, index) => source.slice(
    indexes[index] + marker.length, indexes[index + 1] ?? source.length,
  ).replace(/^[；;\s]+|[；;\s]+$/gu, ''));
  return values.every((value) => Array.from(value).length >= 4
    && !EMPTY_CONTRACT_TEXT.test(value)) ? values : null;
}

function appealContractValid(source) {
  const segments = markedSegments(source, WORLD_APPEAL_SCENE_LABELS);
  if (!segments) return false;
  return segments.every((segment) => markedFieldValues(
    segment, WORLD_APPEAL_SCENE_FIELDS,
  ));
}

function knowledgeBoundaryContractValid(source) {
  const segments = markedSegments(source, WORLD_KNOWLEDGE_BOUNDARY_LABELS);
  return Boolean(segments?.every((segment) => Array.from(segment).length >= 8
    && !EMPTY_CONTRACT_TEXT.test(segment)));
}

function revealRouteContractValid(source) {
  const segments = markedSegments(source, WORLD_REVEAL_STAGE_LABELS);
  return Boolean(segments?.every((segment) => markedFieldValues(
    segment, WORLD_REVEAL_STAGE_FIELDS,
  )));
}

export function worldRevealRoute(value) {
  const source = text(value);
  const route = sectionContent(source, '分阶段揭示路线', '秘密分层与认知边界');
  const segments = markedSegments(route, WORLD_REVEAL_STAGE_LABELS);
  if (!segments) return [];
  const fields = segments.map((segment) => markedFieldValues(
    segment, WORLD_REVEAL_STAGE_FIELDS,
  ));
  if (fields.some((values) => !values)) return [];
  return fields.map((values, index) => ({
    layer: WORLD_REVEAL_STAGE_LABELS[index],
    readingPromise: values[0],
    verifiableEvidence: values[1],
    characterAction: values[2],
    choiceAndCost: values[3],
    knowledgeGain: values[4],
    protectedUnknown: values[5],
    nextLayerGate: values[6],
  }));
}

export function worldBibleDiagnostics(value) {
  const source = text(value);
  const sections = WORLD_BIBLE_SECTION_LABELS.map((label, index) => ({
    label,
    content: sectionContent(source, label, WORLD_BIBLE_SECTION_LABELS[index + 1]),
  }));
  const missingSections = sections.filter((entry) => !entry.content).map((entry) => entry.label);
  const thinLabels = new Set(sections.filter((entry) => entry.content
    && entry.content.length < (entry.label === '一句话世界钩子'
      ? 20 : MIN_WORLD_BIBLE_SECTION_CHARS))
    .map((entry) => entry.label));
  const appeal = sections.find((entry) => entry.label === '持续看点与标志性场面');
  if (appeal?.content && !appealContractValid(appeal.content)) {
    thinLabels.add(appeal.label);
  }
  const boundary = sections.find((entry) => entry.label === '秘密分层与认知边界');
  if (boundary?.content && !knowledgeBoundaryContractValid(boundary.content)) {
    thinLabels.add(boundary.label);
  }
  const revealRoute = sections.find((entry) => entry.label === '分阶段揭示路线');
  if (revealRoute?.content && !revealRouteContractValid(revealRoute.content)) {
    thinLabels.add(revealRoute.label);
  }
  const thinSections = sections.filter((entry) => thinLabels.has(entry.label))
    .map((entry) => entry.label);
  const issues = [];
  if (source.length < MIN_GENERATED_WORLD_BIBLE_CHARS) issues.push('too-short');
  if (missingSections.length) issues.push('missing-sections');
  if (thinSections.length) issues.push('thin-sections');
  if (/```/u.test(source)) issues.push('code-fence');
  return {
    valid: issues.length === 0,
    // 只有代码围栏属于输出格式损坏；短、漏栏和薄栏是内容完整度问题，
    // 由作者看诊断后决定，不在这里拒绝落盘。
    malformed: issues.includes('code-fence'),
    characters: source.length,
    sectionCount: sections.length - missingSections.length,
    missingSections,
    thinSections,
    issues,
  };
}

// 版本链可回退，因此一份偏短或漏栏的世界圣经不会造成不可逆损失；
// 拒绝它只会让作者白付一次 API 费用且什么都拿不到。这里只拦截输出格式
// 损坏的结果，完整度问题交由核心设定页和章节上下文体检显示。
export function assertGeneratedWorldBible(value) {
  const diagnostics = worldBibleDiagnostics(value);
  if (diagnostics.malformed) throw new Error('WORLD_BIBLE_FAILED');
  return diagnostics;
}
