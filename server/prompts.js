function line(label, value) { return value ? `【${label}】${value}\n` : ''; }

// 读取可版本化字段的当前文本；兼容 {versions,cursor} / {content} / 字符串 / 空
function vtext(f) {
  if (!f) return '';
  if (Array.isArray(f.versions)) return f.versions[f.cursor] ?? '';
  if (typeof f.content === 'string') return f.content;
  return typeof f === 'string' ? f : '';
}

export function buildSystemPrompt(core = {}) {
  let s = '你是一位小说写手。严格遵守以下设定：\n';
  s += line('世界观', vtext(core.world));
  s += line('文风基调', vtext(core.style));
  s += line('禁忌约束', vtext(core.constraints));   // 硬约束，最高优先级
  s += line('篇幅节奏', vtext(core.pacing));
  return s.trim();
}

export function buildContext({ book = {}, section = {}, prevChapter = null }) {
  const chars = (arr) => {
    if (!Array.isArray(arr)) return '';
    return arr
      .filter((c) =>
        c &&
        typeof c.name === 'string' &&
        typeof c.role === 'string' &&
        typeof c.desc === 'string')
      .map((c) => `- ${c.name}（${c.role}）：${c.desc}`)
      .join('\n');
  };
  let s = '';
  s += line('全书大纲', vtext(book.outline));
  s += line('本部大纲', section.outline?.content);
  s += line('本部前情', section.summary);
  const mainC = chars(book.characters);
  const secC = chars(section.characters);
  if (mainC) s += `【主要人物】\n${mainC}\n`;
  if (secC) s += `【本部人物】\n${secC}\n`;
  if (prevChapter) {
    const lineC = chars(prevChapter.characters);
    if (lineC) s += `【本章相关龙套】\n${lineC}\n`;
    if (prevChapter.content) s += `【上一章结尾】${prevChapter.content.slice(-300)}\n`;
    s += line('接下来要写', prevChapter.progress);
  }
  return s.trim();
}

export function buildChapterInstruction({ chapterIndex, wordTarget, mode, whip, currentContent }) {
  const base = `请写第 ${chapterIndex} 章正文，约 ${wordTarget} 字，直接输出正文，不要标题和解说。`;
  if (mode === 'rewrite') return `重写第 ${chapterIndex} 章，保持大纲方向，换一种写法。${base}`;
  if (mode === 'whip') {
    const current = currentContent ? `\n【当前章原文】\n${currentContent}\n` : '';
    return `${current}用户对当前内容不满，最高优先级要求：『${whip}』。请据此重写。${base}`;
  }
  return base;
}

export function buildOutlineInstruction(premise) {
  return `用户想写的故事：『${premise}』。请生成一份全书总大纲，包含主要情节脉络与阶段划分，直接输出大纲。`;
}

export function buildSectionsInstruction(outline) {
  return `基于以下全书大纲，规划分部（卷）结构，每部给出标题与本部剧情走向。\n${outline}\n请按"第 N 部 · 标题：走向"逐行输出。`;
}

export const DIGEST_INSTRUCTION =
  '请阅读上文这一章正文，返回严格的 JSON（不要多余文字），格式：' +
  '{"chapterTitle":"本章10字内纯标题，不带第N章",' +
  '"sectionTitle":"本部10字内纯标题，不带第N部",' +
  '"summary":"本章50字内小结","progress":"下一步剧情走向",' +
  '"newCharacters":[{"name":"名","role":"身份","desc":"简述"}]}。' +
  '标题不要书名号、引号、序号或解释；若无新登场人物，newCharacters 为空数组。';

export function buildBookTitleInstruction(premise, outline) {
  return `故事设想：${premise || ''}\n全书大纲：${outline || ''}\n` +
    '请拟一个10字以内、有文学性的纯书名。不要书名号、引号、序号、冒号或解释，只输出书名。';
}

export function buildCoreFieldInstruction(field, book) {
  const names = { world: '世界观', style: '文风基调', constraints: '禁忌约束', pacing: '篇幅节奏' };
  const core = (book.settings && book.settings.core) || {};
  let others = '';
  for (const k of Object.keys(names)) {
    if (k === field) continue;
    others += line(names[k], vtext(core[k]));
  }
  return `这本书的故事设想：『${book.premise || ''}』。\n已有设定：\n${others}` +
    `请为这本书重新拟定『${names[field]}』，200 字内，与其它设定保持一致，只输出该项内容，不要解释、不要标题。`;
}
