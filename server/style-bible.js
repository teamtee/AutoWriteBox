export const STYLE_BIBLE_SECTION_LABELS = Object.freeze([
  '叙事视角与距离',
  '场景镜头与细节选择',
  '句式、段落与节奏',
  '对话、潜台词与人物声音',
  '情绪呈现与内心活动',
  '设定信息与世界展示',
  '冲突、爽点与余波',
  '开篇、转场与章尾',
  '词汇、意象与修辞边界',
  '稳定锚点、可变范围与禁止表达',
]);

export const MIN_GENERATED_STYLE_BIBLE_CHARS = 1_000;

export const STYLE_BIBLE_EXECUTION_GUIDANCE = [
  '【文风执行边界】\n',
  '文风圣经是全书稳定的表达总则，不是要求每一段逐项展示的打卡清单。先内化规则，',
  '再按当前场景只调用真正有用的镜头、节奏、对话和情绪手段；不要为了证明遵守文风而写得机械。\n',
  '“稳定锚点”和“禁止表达”属于全局硬边界；其它维度可随战斗、对话、悬疑、感情、日常或高潮在规定范围内变化。',
  '绑定创作资产只作为局部抽象参考：可以细化当前场景的可变维度，不能覆盖文风圣经的稳定锚点、禁止表达、故事事实或人物知识边界。\n',
  '正文中不得复述、解释或暗示这些规则的存在，只呈现人物、行动、感官证据、对话与后果。\n',
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

export function styleBibleDiagnostics(value) {
  const source = text(value);
  const sections = STYLE_BIBLE_SECTION_LABELS.map((label, index) => ({
    label,
    content: sectionContent(source, label, STYLE_BIBLE_SECTION_LABELS[index + 1]),
  }));
  const missingSections = sections.filter((entry) => !entry.content).map((entry) => entry.label);
  const thinSections = sections.filter((entry) => entry.content && entry.content.length < 24)
    .map((entry) => entry.label);
  const issues = [];
  if (source.length < MIN_GENERATED_STYLE_BIBLE_CHARS) issues.push('too-short');
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

// 版本链可回退，因此一份偏短或漏栏的文风圣经不会造成不可逆损失；
// 拒绝它只会让作者白付一次 API 费用且什么都拿不到。这里只拦截输出格式
// 损坏的结果，完整度问题交由核心设定页和章节上下文体检显示。
export function assertGeneratedStyleBible(value) {
  const diagnostics = styleBibleDiagnostics(value);
  if (diagnostics.malformed) throw new Error('STYLE_BIBLE_FAILED');
  return diagnostics;
}
