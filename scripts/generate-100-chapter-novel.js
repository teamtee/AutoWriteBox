#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as store from '../server/store.js';
import { nonStreamChat, extractChapterReview, extractDigest } from '../server/llm.js';
import {
  buildSystemPrompt, buildContext, buildChapterInstruction,
  buildChapterReviewInstruction, DIGEST_INSTRUCTION,
} from '../server/prompts.js';
import {
  chapterPlanReadiness, chapterPlanRevision, normalizeChapterPlan,
} from '../server/chapter-plan-schema.js';
import { worldBibleDiagnostics } from '../server/world-bible.js';
import { styleBibleDiagnostics } from '../server/style-bible.js';
import { storyEngineView } from '../server/story-engine-schema.js';
import { assertChapterOutputClean } from '../server/chapter-output-guard.js';
import {
  chapterRevisionImprovement, normalizeChapterRevisionCandidate,
} from '../server/chapter-revision-schema.js';
import {
  buildChapterReviewRevisionInstruction, chapterReviewRevision,
  chapterReviewRevisionTargets, CHAPTER_REVIEW_REVISION_SYSTEM_APPENDIX,
} from '../server/chapter-review-revision-prompt.js';
import {
  apiEditorialDraftMetrics, apiEditorialCandidatePasses,
  buildApiEditorialReviewerInstruction, buildApiEditorialRewriteInstruction,
  extractApiEditorialJson, selectBestApiEditorialCandidate,
  validateApiEditorialReview,
} from '../server/api-editorial-loop.js';

const DATA_ROOT = path.resolve(process.cwd(), 'data');
const RUN_DIR = path.resolve(process.cwd(), 'data', '.generation-runs', 'hundred-chapter-demo');
const STATE_PATH = path.join(RUN_DIR, 'state.json');
const PACKAGE_PATH = path.join(RUN_DIR, 'book-package-v2.json');
const RESTRUCTURE_ACCEPTANCE_PATH = path.join(RUN_DIR, 'restructure-acceptance.json');
const REQUESTED_BOOK_ID = 'book_39b13a8d853fc8e41e57ade2046227a8';
const CHAPTERS = 100;
const SECTIONS = 10;
const TARGET_CHARS = 3600;
const MIN_CHARS = 2600;
const MAX_CHARS = 6200;
const MAX_ATTEMPTS = 3;
const REQUIRED_RESTRUCTURE_PHASES = Object.freeze(['A', 'B', 'C', 'D', 'E']);
const APPROVED_TRIAL_RANGE = Object.freeze({ start: 5, end: 10 });
const EDITORIAL_SPEC = Object.freeze({
  minCharacters: MIN_CHARS, maxCharacters: MAX_CHARS,
  maxShortParagraphRatio: 0.4, minimumReviewScore: 78,
});

const PREMISE = [
  '现代都市职业悬疑长篇。29岁的殡仪馆夜班遗物整理师许停舟，触碰与死者最后执念直接相关的遗物时，只能听到一句残缺委托或短暂的主观感官残响。',
  '残响不是客观录像，可能错序、误解或被污染，也不能提供死者不知道的密码、姓名、坐标和幕后结论；每件核心遗物最多深读两次。',
  '深读前，许停舟必须明确押上一段具体共同记忆；使用后，他和与该记忆相关的活人都会逐渐失去那段共同经历。七日内完成委托后，他只能短暂借用死者真实拥有的一个程序性身体习惯，不产生万能技能。',
  '一次无名女尸的残缺委托是“别让许知夏下葬”——许知夏是他三年前已经火化的妹妹，但空骨灰盒和错误记录不能直接证明她仍活着。',
  '全书以殡仪馆职业流程、可复核物证、不可靠残响和活人谎言构成公平悬疑；每卷完成一宗死者委托案，只推进妹妹旧案的一个认知层级。',
  '前三章必须完成：第一章建立残缺委托和日期矛盾；第二章以真实暴露风险查验骨灰盒并支付首次具体记忆代价；第三章由主角设局获得有限证据，同时失去合法调查权限。',
  '计划100章、10卷；第90章后不再新增幕后层级，终局兑现记忆主体的知情、拒绝与选择权，而不是用神迹恢复姓名或由亲属替意识残片决定去留。',
].join('');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function trimFence(value) {
  return String(value ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
}
function extractJson(value) {
  let text = trimFence(value);
  // 长JSON偶尔在最后一个章节对象漏掉 brief 键，但正文字符串和后续
  // rhythm 对象都完整。只修复 title 后直接跟长章纲字符串这一种窄形态。
  text = text.replace(
    /("title"\s*:\s*"[^"]+"\s*,\s*)("(?:承接|延续|本章)[\s\S]*?")(\s*,\s*"rhythm"\s*:)/gu,
    '$1"brief": $2$3',
  );
  try { return JSON.parse(text); } catch {}
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}
async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return fallback; }
}
async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, filePath);
}
async function fileFingerprint(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('base64url');
}
function restructureApprovalError() {
  const error = new Error('HUNDRED_CHAPTER_RESTRUCTURE_NOT_APPROVED');
  error.code = 'HUNDRED_CHAPTER_RESTRUCTURE_NOT_APPROVED';
  return error;
}
async function assertRestructureApproved() {
  const acceptance = await readJson(RESTRUCTURE_ACCEPTANCE_PATH, null);
  try {
    const phaseStatuses = new Map(
      (Array.isArray(acceptance?.phases) ? acceptance.phases : [])
        .map((phase) => [phase?.id, phase?.status]),
    );
    const allowedStart = acceptance?.allowedChapterRange?.start;
    const allowedEnd = acceptance?.allowedChapterRange?.end;
    if (acceptance?.schemaVersion !== 2
      || acceptance?.bookId !== REQUESTED_BOOK_ID
      || acceptance?.status !== 'approved'
      || acceptance?.generationApproved !== true
      || acceptance?.approvedPackageFile !== path.basename(PACKAGE_PATH)
      || typeof acceptance?.approvedPackageFingerprint !== 'string'
      || !acceptance.approvedPackageFingerprint
      || allowedStart !== APPROVED_TRIAL_RANGE.start
      || allowedEnd !== APPROVED_TRIAL_RANGE.end
      || REQUIRED_RESTRUCTURE_PHASES.some(
        (id) => phaseStatuses.get(id) !== 'approved'
      )) {
      throw restructureApprovalError();
    }
    if (await fileFingerprint(PACKAGE_PATH) !== acceptance.approvedPackageFingerprint) {
      throw restructureApprovalError();
    }
    const approvedPackage = await readJson(PACKAGE_PATH, null);
    const packageObject = validatePackage(approvedPackage?.package);
    if (!approvedPackage?.world || !worldBibleDiagnostics(approvedPackage.world).valid
      || !approvedPackage?.style || !styleBibleDiagnostics(approvedPackage.style).valid
      || typeof approvedPackage?.constraints !== 'string'
      || approvedPackage.constraints.trim().length < 80
      || typeof approvedPackage?.pacing !== 'string'
      || approvedPackage.pacing.trim().length < 80
      || packageObject.chapters.length !== CHAPTERS) {
      throw restructureApprovalError();
    }
    const artifactFingerprints = acceptance.artifactFingerprints;
    if (!artifactFingerprints || typeof artifactFingerprints !== 'object') {
      throw restructureApprovalError();
    }
    const requiredArtifacts = ['restructure-v2.json', 'mystery-ledger-v2.json'];
    for (const filename of requiredArtifacts) {
      const expected = artifactFingerprints[filename];
      if (typeof expected !== 'string' || !expected
        || await fileFingerprint(path.join(RUN_DIR, filename)) !== expected) {
        throw restructureApprovalError();
      }
    }
    return acceptance;
  } catch (error) {
    if (error?.code === 'HUNDRED_CHAPTER_RESTRUCTURE_NOT_APPROVED') throw error;
    throw restructureApprovalError();
  }
}
async function ai(config, system, prompt, label, attempts = 6) {
  let lastError;
  const requestConfig = {
    ...config,
    requestTimeoutMs: Math.max(config.requestTimeoutMs ?? 0, 900_000),
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = await nonStreamChat({
        config: requestConfig, system, messages: [{ role: 'user', content: prompt }],
      });
      if (!output?.trim()) throw new Error('EMPTY_AI_OUTPUT');
      return output.trim();
    } catch (error) {
      lastError = error;
      process.stderr.write(`[${label}] attempt ${attempt} failed: ${error?.message || error}\n`);
      if (attempt < attempts) await sleep(Math.min(60_000, 5_000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
function worldBiblePrompt() {
  return `为以下100章长篇生成完整“世界圣经”。控制在2000至2600汉字，严格包含且只按以下十二个标题顺序输出：\n【一句话世界钩子】\n【独特机制】\n【底层规则与代价】\n【空间层级与可达边界】\n【社会生态与日常后果】\n【势力与利益冲突】\n【历史伤口与当前火药桶】\n【主角切口与升级路径】\n【持续看点与标志性场面】\n【分阶段揭示路线】\n【秘密分层与认知边界】\n【禁止便利设定与保留未知】\n其中【持续看点与标志性场面】必须依次包含六段〔日常生计〕〔规则博弈〕〔关系交换〕〔势力冲突〕〔探索发现〕〔阶段兑现〕，每段必须按顺序写“看点：…；行动：…；阻碍：…；代价：…；变奏边界：…”。\n【分阶段揭示路线】必须依次包含〔当前生活圈〕〔中期势力与地域〕〔长线文明与历史〕，每段按顺序写“阅读承诺：…；可验证证据：…；人物行动：…；选择与代价：…；认知增量：…；保留未知：…；进入下一层门槛：…”。\n【秘密分层与认知边界】必须依次包含〔作者底层真相〕〔当前读者已知〕〔当前主角已知〕〔关键势力认知差〕〔下一阶段可验证〕〔保留未知〕，每段至少20字。\n故事设想：${PREMISE}`;
}
function styleBiblePrompt() {
  return `为以下都市悬疑异能长篇生成可执行的“文风圣经”，控制在1200至1800汉字。严格包含以下十个标题并按顺序输出：\n【叙事视角与距离】\n【场景镜头与细节选择】\n【句式、段落与节奏】\n【对话、潜台词与人物声音】\n【情绪呈现与内心活动】\n【设定信息与世界展示】\n【冲突、爽点与余波】\n【开篇、转场与章尾】\n【词汇、意象与修辞边界】\n【稳定锚点、可变范围与禁止表达】\n要求：第三人称限知贴近许停舟；职业细节具体但不百科；不使用成片短段金句；少用破折号和明喻；不替人物总结情绪；对话有即时目的和潜台词；关键爽点必须由行动挣得并留下代价；每章2500—4500汉字；禁止“不是……而是……”模板、连续反问、标签式伏笔提示、策划字段泄漏。\n故事设想：${PREMISE}`;
}
function packagePrompt() {
  return `你是长篇网文总编。先为以下作品生成10卷书级执行包，不生成逐章列表。只返回严格JSON，不要Markdown。\n故事设想：${PREMISE}\nJSON结构：{\n"title":"12字内书名",\n"outline":"800至1500字的全书总纲，含卖点、主角长期欲望、主线承诺推进兑现、重要人物选择与代价、10卷阶段变化和最终兑现",\n"storyEngine":{"readerExperience":"...","protagonistAction":"...","progression":"...","cost":"...","escalation":"..."},\n"sections":[正好10项，每项{"index":1,"title":"卷名","summary":"不少于250字的本卷完整剧情、10章因果推进、阶段高潮与状态变化","layer":"当前生活圈|中期势力与地域|长线文明与历史","stagePromise":"本卷读者回报","evidence":"可核验世界证据","characterAction":"主角主动行动","choiceAndCost":"本卷关键选择与代价","knowledgeGain":"本卷结束认知增量","protectedUnknown":"本卷不揭示什么","gateCondition":"进入下一层的行动门槛","gateOutcome":"hold|open-next|complete-long","gateProgress":"本卷门槛进度"}]\n}\n硬要求：正好10卷；前三卷在当前生活圈，第4至7卷进入中期势力与地域，第8至10卷进入长线文明与历史；第2/4/6/8卷有大兑现，第10卷终局兑现；每卷必须有独立死者委托案，又推进妹妹失踪、身份抹除和记忆产业主线；禁止十卷只是更换死者姓名重复同一案件。`;
}
function sectionChaptersPrompt(pkg, sectionIndex, previousChapters) {
  const section = pkg.sections[sectionIndex - 1];
  const start = (sectionIndex - 1) * 10 + 1;
  const prior = previousChapters.slice(-3).map((row) => `第${row.index}章 ${row.title}：${row.brief}`).join('\n') || '（第一卷，无此前章节）';
  return `你是长篇网文总编。为第${sectionIndex}卷生成正好10章执行章纲，只返回严格JSON，不要Markdown。\n全书设想：${PREMISE}\n全书总纲：${pkg.outline}\n本卷：${JSON.stringify(section)}\n最近章节：${prior}\n返回：{"chapters":[10项，每项{"index":${start},"sectionIndex":${sectionIndex},"title":"章名","brief":"180至450字，明确承接、职业现场目标、阻碍如何因行动升级、许停舟的主动选择、行动挣得的兑现、具体代价、章尾牵引、妹妹/身份抹除/记忆产业或人物关系推进，并列出2到4个连续因果场景","rhythm":{"pressurePattern":"steady-rise|wave-rise|false-relief|reversal-led|choice-led|aftermath","resolutionMethod":"none|force|skill|wit|negotiation|sacrifice|cooperation|endurance|discovery|failure|mixed","payoffScale":"none|micro|chapter|stage|major","hookMechanism":"none|new-threat|new-information|unfinished-action|forced-choice|relationship-shift|world-opening|deadline|aftermath-question","costType":"none|physical|resource|identity|relationship|moral|time|position|knowledge|mixed"}}]}\n本卷章号必须从${start}连续到${start + 9}。第${start + 9}章必须完成本卷独立委托案的阶段高潮，并以本卷结果推动下一卷，不能突然投放无关事故。${sectionIndex === 1 ? '第1章展示遗物委托和职业破局；第2章展示死者技能与记忆侵蚀；第3章完成首次反杀并明确妹妹主线。' : ''}不能连续三章使用同一种破局、钩子或代价。`;
}
function sectionOutline(section) {
  return [
    `【本部概述】${section.summary}`,
    `【世界层级】${section.layer}`,
    `【世界阶段承诺】${section.stagePromise}`,
    `【可验证世界证据】${section.evidence}`,
    `【人物行动】${section.characterAction}`,
    `【世界选择与代价】${section.choiceAndCost}`,
    `【阶段认知增量】${section.knowledgeGain}`,
    `【本部保留未知】${section.protectedUnknown}`,
    `【下一层门槛】${section.gateCondition}`,
    `【门槛结果】${section.gateOutcome === 'open-next' ? '本部完成门槛并解锁下一层' : section.gateOutcome === 'complete-long' ? '本部完成长线世界结算' : '本部不解锁下一层'}`,
    `【门槛证据进度】${section.gateProgress}`,
  ].join('\n');
}
function planFromBrief(chapter, previousBrief, section) {
  const rhythm = chapter.rhythm;
  const brief = chapter.brief;
  const trigger = chapter.index === 1 ? '殡仪馆夜班接收无名女尸，遗物录音笔主动播放最后委托' : `承接第${chapter.index - 1}章结果：${previousBrief.slice(-120)}`;
  const noTask = `无埋点理由：本章把篇幅用于执行既有委托和本章选择，不额外建立新谜团；本章聚焦：${brief.slice(0, 120)}；既有未知处理：妹妹死而复现与记忆产业真相按本卷边界保持未知，不提前揭示`;
  return normalizeChapterPlan({
    qualityProtocolVersion: 3,
    rhythmIntentVersion: 1,
    rhythmIntent: rhythm,
    goal: `${brief.slice(0, 180)}`,
    obstacle: `本章的现场规则、利益相关者与七日委托时限共同阻拦许停舟；阻碍必须在他的行动后升级，而非自行消失。`,
    choice: `许停舟必须主动使用职业权限、死者技能或一段自身记忆换取推进，并承担${rhythm.costType}代价。`,
    payoff: `按章纲兑现一个可见结果：${brief.slice(-180)}；兑现必须由许停舟的行动挣得。`,
    hook: `由本章选择的实际后果形成下一章牵引，不另投放无关陌生事故。`,
    tensionArc: `压力来源：七日委托期限、身份被抹去与现场对手同时逼迫许停舟；变化链：${trigger}→许停舟使用已有职业资源或死者技能迫使局面改变→该行动暴露身份或消耗记忆，引来对手反制；选择高点：许停舟在保住自身记忆与完成死者委托之间作出不可回避的选择；兑现与余波：获得${rhythm.payoffScale}回报，但留下能直接驱动下一章的${rhythm.costType}后果`,
    foreshadowing: noTask,
    worldExpansion: `展开前认知：读者与许停舟只知道${section.layer}中已发生的委托规则，仍不知道记忆回收产业的最终用途；既有依据：死者遗物会留下可听见的最后委托，完成后技能与记忆同时转移；可验证证据：本章通过${section.evidence}中的具体物证或流程记录交叉核验；边界增量/机制深化：让本章行动证明${section.knowledgeGain}的一小层，不越过本卷层级；选择与代价：证据迫使许停舟继续追查并支付${rhythm.costType}代价；保留未知：${section.protectedUnknown}`,
    notes: `全书第${chapter.index}章；章纲：${brief}`,
    scenes: [{
      title: chapter.title,
      trigger,
      desire: `许停舟要在本章现场完成章纲中的即时目标`,
      obstacle: `现场规则与对手利用他的记忆缺口阻止核验`,
      action: `许停舟调用已经成立的职业知识或死者技能，主动设置一次可验证的局`,
      turn: `他的行动取得结果，却使对手锁定新的身份痕迹或让熟人遗忘一件关于他的事`,
      cost: `他为结果支付具体的${rhythm.costType}代价，并把后果带入下一章`,
    }],
  });
}
function validatePackage(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new Error('PACKAGE_INVALID');
  if (typeof pkg.title !== 'string' || !pkg.title.trim()) throw new Error('PACKAGE_TITLE_INVALID');
  if (typeof pkg.outline !== 'string' || pkg.outline.length < 800) throw new Error('PACKAGE_OUTLINE_THIN');
  if (!Array.isArray(pkg.sections) || pkg.sections.length !== SECTIONS) throw new Error('PACKAGE_SECTIONS_INVALID');
  storyEngineView(pkg.storyEngine);
  pkg.sections.forEach((section, index) => {
    if (section.index !== index + 1 || typeof section.summary !== 'string' || section.summary.length < 80) throw new Error(`PACKAGE_SECTION_${index + 1}_INVALID`);
  });
  const chapters = Array.isArray(pkg.chapters) ? pkg.chapters : [];
  if (chapters.length > CHAPTERS) throw new Error('PACKAGE_CHAPTERS_INVALID');
  return { ...pkg, chapters };
}
function validateSectionChapters(value, sectionIndex) {
  const rows = value?.chapters;
  const start = (sectionIndex - 1) * 10 + 1;
  if (!Array.isArray(rows) || rows.length !== 10) throw new Error(`SECTION_${sectionIndex}_CHAPTERS_INVALID`);
  const options = {
    pressurePattern: ['steady-rise', 'wave-rise', 'false-relief', 'reversal-led', 'choice-led', 'aftermath'],
    resolutionMethod: ['none', 'force', 'skill', 'wit', 'negotiation', 'sacrifice', 'cooperation', 'endurance', 'discovery', 'failure', 'mixed'],
    payoffScale: ['none', 'micro', 'chapter', 'stage', 'major'],
    hookMechanism: ['none', 'new-threat', 'new-information', 'unfinished-action', 'forced-choice', 'relationship-shift', 'world-opening', 'deadline', 'aftermath-question'],
    costType: ['none', 'physical', 'resource', 'identity', 'relationship', 'moral', 'time', 'position', 'knowledge', 'mixed'],
  };
  return rows.map((row, offset) => {
    if (!row || typeof row !== 'object'
      || typeof row.title !== 'string' || !row.title.trim()
      || typeof row.brief !== 'string' || row.brief.trim().length < 60) {
      throw new Error(`SECTION_${sectionIndex}_CHAPTER_${offset + 1}_INVALID`);
    }
    const rawRhythm = row.rhythm && typeof row.rhythm === 'object' ? row.rhythm : {};
    const rhythm = {};
    for (const [field, values] of Object.entries(options)) {
      const value = rawRhythm[field];
      rhythm[field] = values.includes(value) ? value : values[(sectionIndex + offset) % values.length];
    }
    return {
      index: start + offset, sectionIndex,
      title: row.title.trim(), brief: row.brief.trim(), rhythm,
    };
  });
}
async function ensureBookPackage(configs) {
  const checkpoint = await readJson(PACKAGE_PATH, {});
  let world = checkpoint.world;
  let style = checkpoint.style;
  let packageObject = checkpoint.package;
  if (!world || !worldBibleDiagnostics(world).valid) {
    world = await ai(configs.outline,
      '你是严谨的长篇类型小说世界设计师。只输出要求的世界圣经正文。',
      worldBiblePrompt(), 'world-bible');
    const diagnostics = worldBibleDiagnostics(world);
    if (!diagnostics.valid) throw new Error(`WORLD_INVALID:${JSON.stringify(diagnostics)}`);
    await writeJson(PACKAGE_PATH, { ...checkpoint, world });
  }
  if (!style || !styleBibleDiagnostics(style).valid) {
    style = await ai(configs.outline,
      '你是克制、具体、反模板化的中文小说文体编辑。只输出要求的文风圣经。',
      styleBiblePrompt(), 'style-bible');
    const diagnostics = styleBibleDiagnostics(style);
    if (!diagnostics.valid) throw new Error(`STYLE_INVALID:${JSON.stringify(diagnostics)}`);
    await writeJson(PACKAGE_PATH, { ...(await readJson(PACKAGE_PATH, {})), world, style });
  }
  if (!packageObject) {
    const pkgRaw = await ai(configs.outline,
      '你是擅长长线因果、职业现场、人物代价和网文兑现的总编。只返回严格JSON。',
      packagePrompt(), 'book-package');
    packageObject = validatePackage(extractJson(pkgRaw));
    await writeJson(PACKAGE_PATH, {
      ...(await readJson(PACKAGE_PATH, {})), world, style, package: packageObject,
    });
  } else {
    packageObject = validatePackage(packageObject);
  }
  for (let sectionIndex = Math.floor(packageObject.chapters.length / 10) + 1;
    sectionIndex <= SECTIONS; sectionIndex += 1) {
    const rawPath = path.join(RUN_DIR, `section-${sectionIndex}-chapters.raw.txt`);
    let raw;
    try { raw = await fs.readFile(rawPath, 'utf8'); }
    catch {
      raw = await ai(configs.outline,
        '你是擅长长线因果、职业现场、人物代价和网文兑现的总编。只返回严格JSON。',
        sectionChaptersPrompt(packageObject, sectionIndex, packageObject.chapters),
        `section-${sectionIndex}-chapters`);
      await fs.writeFile(rawPath, raw, 'utf8');
    }
    const rows = validateSectionChapters(extractJson(raw), sectionIndex);
    packageObject.chapters.push(...rows);
    await writeJson(PACKAGE_PATH, {
      generatedAt: new Date().toISOString(), premise: PREMISE,
      world, style, package: packageObject,
    });
  }
  if (packageObject.chapters.length !== CHAPTERS) throw new Error('PACKAGE_CHAPTERS_INVALID');
  const result = { generatedAt: new Date().toISOString(), premise: PREMISE, world, style, package: packageObject };
  await writeJson(PACKAGE_PATH, result);
  return result;
}
const STORY_ENGINE_FIELDS = Object.freeze([
  'readerExperience', 'protagonistAction', 'progression', 'cost', 'escalation',
]);
function storyEngineContent(value) {
  const view = storyEngineView(value);
  return Object.fromEntries(STORY_ENGINE_FIELDS.map((field) => [field, view[field]]));
}
async function setApprovedBookAsset(book, versionPath, current, desired) {
  if (store.currentText(current) === desired) return book;
  await store.versionSet(book.id, versionPath, desired, {
    expectedRevision: store.versionRevision(current),
  });
  return store.readBook(book.id);
}
async function readApprovedBookPackage() {
  const checkpoint = await readJson(PACKAGE_PATH, null);
  const packageObject = validatePackage(checkpoint?.package);
  if (!checkpoint?.world || !worldBibleDiagnostics(checkpoint.world).valid
    || !checkpoint?.style || !styleBibleDiagnostics(checkpoint.style).valid
    || typeof checkpoint?.constraints !== 'string'
    || typeof checkpoint?.pacing !== 'string'
    || packageObject.chapters.length !== CHAPTERS) {
    throw new Error('APPROVED_PACKAGE_INVALID');
  }
  return { ...checkpoint, package: packageObject };
}
async function ensureBook(bookPackage, approval) {
  let book;
  try { book = await store.readBook(REQUESTED_BOOK_ID); } catch (error) {
    if (error.message !== 'BOOK_NOT_FOUND') throw error;
    book = await store.createBook({
      premise: PREMISE, title: bookPackage.package.title,
      requestedBookId: REQUESTED_BOOK_ID,
    });
  }
  book = await setApprovedBookAsset(
    book, 'outline', book.outline, bookPackage.package.outline,
  );
  book = await setApprovedBookAsset(
    book, 'core:world', book.settings.core.world, bookPackage.world,
  );
  book = await setApprovedBookAsset(
    book, 'core:style', book.settings.core.style, bookPackage.style,
  );
  book = await setApprovedBookAsset(
    book, 'core:constraints', book.settings.core.constraints,
    bookPackage.constraints,
  );
  book = await setApprovedBookAsset(
    book, 'core:pacing', book.settings.core.pacing, bookPackage.pacing,
  );
  const currentEngine = storyEngineView(book.settings.storyEngine);
  const desiredEngine = storyEngineContent(bookPackage.package.storyEngine);
  if (JSON.stringify(storyEngineContent(currentEngine)) !== JSON.stringify(desiredEngine)) {
    await store.saveStoryEngine(book.id, desiredEngine, {
      expectedRevision: currentEngine.revision,
    });
    book = await store.readBook(book.id);
  }
  const bound = [
    [store.currentText(book.outline), bookPackage.package.outline],
    [store.currentText(book.settings.core.world), bookPackage.world],
    [store.currentText(book.settings.core.style), bookPackage.style],
    [store.currentText(book.settings.core.constraints), bookPackage.constraints],
    [store.currentText(book.settings.core.pacing), bookPackage.pacing],
  ].every(([actual, desired]) => actual === desired)
    && JSON.stringify(storyEngineContent(book.settings.storyEngine))
      === JSON.stringify(desiredEngine);
  if (!bound || !approval.approvedPackageFingerprint) {
    throw new Error('APPROVED_BOOK_ASSETS_NOT_BOUND');
  }
  return book;
}
function versionedWithApprovedContent(value, content) {
  const versions = Array.isArray(value?.versions) ? [...value.versions] : [''];
  const cursor = Number.isInteger(value?.cursor) ? value.cursor : versions.length - 1;
  if ((versions[cursor] ?? '') === content) return { versions, cursor };
  versions.push(content);
  const kept = versions.slice(-20);
  return { versions: kept, cursor: kept.length - 1 };
}
async function ensureStructure(book, bookPackage, approval) {
  const current = await store.readBookStructure(book.id);
  const approvedPlanMarker = `已批准重构包：${approval.approvedPackageFingerprint}`;
  let lastSectionId = current.sections.at(-1)?.id ?? null;
  for (let sectionIndex = current.sections.length + 1; sectionIndex <= SECTIONS; sectionIndex += 1) {
    const spec = bookPackage.package.sections[sectionIndex - 1];
    const created = await store.addSection(book.id, { title: spec.title, titleSource: 'ai', outline: sectionOutline(spec), expectedLastSectionId: lastSectionId });
    lastSectionId = created.id;
  }
  let structure = await store.readBookStructure(book.id);
  for (const section of structure.sections) {
    let lastChapterId = section.chapters.at(-1)?.id ?? null;
    for (let local = section.chapters.length + 1; local <= 10; local += 1) {
      const globalIndex = (section.index - 1) * 10 + local;
      const spec = bookPackage.package.chapters[globalIndex - 1];
      const chapter = await store.addChapter(book.id, section.id, { title: spec.title, expectedLastChapterId: lastChapterId });
      lastChapterId = chapter.id;
    }
  }
  structure = await store.readBookStructure(book.id);
  for (const section of structure.sections) {
    const sectionStart = (section.index - 1) * 10 + 1;
    const sectionEnd = section.index * 10;
    const overlapsApprovedRange = sectionStart <= approval.allowedChapterRange.end
      && sectionEnd >= approval.allowedChapterRange.start;
    if (!overlapsApprovedRange) continue;
    const spec = bookPackage.package.sections[section.index - 1];
    const desiredOutline = sectionOutline(spec);
    const storedSection = await store.readSection(book.id, section.id);
    if (store.currentText(storedSection.outline) !== desiredOutline
      || storedSection.title !== spec.title) {
      storedSection.outline = versionedWithApprovedContent(
        storedSection.outline, desiredOutline,
      );
      storedSection.title = spec.title;
      storedSection.titleSource = 'ai';
      await store.writeSection(book.id, section.id, storedSection);
    }
  }
  structure = await store.readBookStructure(book.id);
  for (const section of structure.sections) {
    for (const chapter of section.chapters) {
      const globalIndex = (section.index - 1) * 10 + chapter.index;
      const spec = bookPackage.package.chapters[globalIndex - 1];
      const stored = await store.readChapter(book.id, section.id, chapter.id);
      const existing = normalizeChapterPlan(stored.plan);
      const inApprovedRange = globalIndex >= approval.allowedChapterRange.start
        && globalIndex <= approval.allowedChapterRange.end;
      const approvedPlanMissing = inApprovedRange
        && !String(existing.notes ?? '').includes(approvedPlanMarker);
      if (!chapterPlanReadiness(existing, { sectionOutline: section.outline?.content, bookChapterIndex: globalIndex, requireCurrentProtocol: true }).ready
        || approvedPlanMissing) {
        const previous = bookPackage.package.chapters[globalIndex - 2];
        const sectionSpec = bookPackage.package.sections[section.index - 1];
        const generatedPlan = planFromBrief(spec, previous?.brief ?? '', sectionSpec);
        const plan = inApprovedRange
          ? normalizeChapterPlan({
            ...generatedPlan,
            notes: `${generatedPlan.notes}\n${approvedPlanMarker}`,
          }) : generatedPlan;
        const readiness = chapterPlanReadiness(plan, { sectionOutline: section.outline?.content, bookChapterIndex: globalIndex, requireCurrentProtocol: true });
        if (!readiness.ready) throw new Error(`PLAN_${globalIndex}_NOT_READY:${JSON.stringify(readiness.checks.filter((row) => !row.pass && !row.advisory))}`);
        await store.saveChapterPlan(book.id, section.id, chapter.id, plan, { expectedRevision: chapterPlanRevision(stored.plan) });
      }
    }
  }
  const rebound = await store.readBookStructure(book.id);
  for (const section of rebound.sections) {
    const sectionStart = (section.index - 1) * 10 + 1;
    const sectionEnd = section.index * 10;
    if (sectionStart > approval.allowedChapterRange.end
      || sectionEnd < approval.allowedChapterRange.start) continue;
    const storedSection = await store.readSection(book.id, section.id);
    const expected = sectionOutline(bookPackage.package.sections[section.index - 1]);
    if (store.currentText(storedSection.outline) !== expected) {
      throw new Error(`APPROVED_SECTION_${section.index}_OUTLINE_NOT_BOUND`);
    }
  }
  return rebound;
}
function basicDraftGate(text) {
  const stripped = text.trim();
  const leaks = assertChapterOutputClean(stripped);
  return Boolean(leaks) || (stripped.length >= MIN_CHARS && stripped.length <= MAX_CHARS);
}
async function generateDraft({ configs, context, chapterSpec }) {
  const { book, section, chapter, previousChapter, bookChapterIndex, recentReviewSignals, writingAssetContext } = context;
  const system = buildSystemPrompt(book.settings.core, writingAssetContext?.text ?? '', book.settings.storyEngine);
  const shared = buildContext({ book, section, prevChapter: previousChapter, bookChapterIndex, chapterPlan: chapter.plan, currentContent: '' });
  const instruction = `${shared}\n\n${buildChapterInstruction({ chapterIndex: chapter.index, bookChapterIndex, wordTarget: TARGET_CHARS, mode: 'rewrite', currentContent: '', recentReviewSignals, chapterPlan: chapter.plan })}\n\n【本章总编章纲】\n${chapterSpec.brief}\n\n必须写成完整小说正文。关键过程不得概述；不要标题；不要解释创作过程。`;
  return ai(configs.chapter, system, instruction, `chapter-${bookChapterIndex}-draft`, 3);
}
async function reviewDraft({ configs, context, draft }) {
  const { book, section, chapter, previousChapter, bookChapterIndex, recentReviewSignals, writingAssetContext } = context;
  const system = buildSystemPrompt(book.settings.core, writingAssetContext?.text ?? '', book.settings.storyEngine);
  const shared = buildContext({ book, section, prevChapter: previousChapter, bookChapterIndex, chapterPlan: chapter.plan, currentContent: draft });
  const instruction = buildChapterReviewInstruction({ chapterIndex: chapter.index, bookChapterIndex, content: draft, context: shared, recentReviewSignals, chapterPlan: chapter.plan, sectionOutline: section.outline?.content });
  const raw = await ai(configs.review, system, instruction, `chapter-${bookChapterIndex}-review`, 1);
  return extractChapterReview(raw, { chapterPlan: chapter.plan, promiseLedger: book.settings?.promiseLedger, chapterContent: draft, sectionOutline: section.outline?.content });
}
async function reviseDraft({ configs, context, draft, review }) {
  if (!review || !chapterReviewRevisionTargets(review)) return { draft, review, revised: false };
  const { book, section, chapter, previousChapter, bookChapterIndex, writingAssetContext } = context;
  const system = `${buildSystemPrompt(book.settings.core, writingAssetContext?.text ?? '', book.settings.storyEngine)}\n\n${CHAPTER_REVIEW_REVISION_SYSTEM_APPENDIX}`;
  const shared = buildContext({ book, section, prevChapter: previousChapter, bookChapterIndex, chapterPlan: chapter.plan, currentContent: draft });
  const instruction = buildChapterReviewRevisionInstruction({ chapterIndex: chapter.index, bookChapterIndex, context: shared, content: draft, review, chapterPlan: chapter.plan });
  const raw = await ai(configs.chapter, system, instruction, `chapter-${bookChapterIndex}-revision`, 2);
  const candidate = normalizeChapterRevisionCandidate(raw, draft);
  if (!candidate) return { draft, review, revised: false };
  const improvement = chapterRevisionImprovement(candidate, draft, { review });
  if (!improvement?.valid) return { draft, review, revised: false };
  const verifyContext = { ...context, chapter: { ...chapter, body: { versions: [candidate], cursor: 0 } } };
  const verifiedReview = await reviewDraft({ configs, context: verifyContext, draft: candidate });
  const remaining = verifiedReview?.webFictionChecks?.filter((item) => item.status === 'risk' && item.id !== 'contentRisk').length ?? 999;
  const planRisks = verifiedReview?.planComparison?.items.filter((item) => item.outcome === 'missed' || item.outcome === 'unclear').length ?? 999;
  if (!verifiedReview || remaining || planRisks) return { draft, review, revised: false };
  return { draft: candidate, review: verifiedReview, revised: true };
}
async function editorialReview({ configs, context, chapterSpec, draft, iteration }) {
  const previousText = context.previousChapter
    ? store.currentText(context.previousChapter.body) : '';
  const spec = {
    ...EDITORIAL_SPEC,
    bookTitle: context.book.title,
    chapterIndex: context.bookChapterIndex,
    chapterTitle: chapterSpec.title,
  };
  const metrics = apiEditorialDraftMetrics(draft, spec);
  const raw = await ai(configs.review,
    '你是严格的长篇网文主编。只依据提供的正文证据审稿，返回用户要求的严格JSON。',
    buildApiEditorialReviewerInstruction({
      spec, brief: chapterSpec.brief, plan: context.chapter.plan,
      previousChapter: previousText, draft, metrics,
    }),
    `chapter-${context.bookChapterIndex}-editorial-${iteration}`, 3);
  const review = validateApiEditorialReview(extractApiEditorialJson(raw));
  return { iteration, draft, metrics, review };
}
async function editorialRewrite({ configs, context, chapterSpec, candidate }) {
  const previousText = context.previousChapter
    ? store.currentText(context.previousChapter.body) : '';
  const spec = {
    ...EDITORIAL_SPEC,
    bookTitle: context.book.title,
    chapterIndex: context.bookChapterIndex,
    chapterTitle: chapterSpec.title,
  };
  const system = buildSystemPrompt(
    context.book.settings.core, context.writingAssetContext?.text ?? '',
    context.book.settings.storyEngine,
  );
  return ai(configs.chapter, system, buildApiEditorialRewriteInstruction({
    spec, brief: chapterSpec.brief, plan: context.chapter.plan,
    previousChapter: previousText, draft: candidate.draft,
    review: candidate.review, metrics: candidate.metrics,
  }), `chapter-${context.bookChapterIndex}-editorial-rewrite`, 3);
}
async function applyDigest({ configs, bookId, sectionId, chapterId, draft, fingerprint, system, chapterIndex }) {
  const raw = await ai(configs.digest, system, `以下是正文：\n${draft}\n\n${DIGEST_INSTRUCTION}`, `chapter-${chapterIndex}-digest`, 2);
  const digest = extractDigest(raw);
  if (!digest) return false;
  const result = await store.applyChapterDigest(bookId, sectionId, chapterId, digest, { expectedBodyFingerprint: fingerprint });
  return result.applied;
}
async function runChapters(book, structure, bookPackage, configs, state, approval) {
  const allowedStart = approval.allowedChapterRange.start;
  const allowedEnd = approval.allowedChapterRange.end;
  for (const section of structure.sections) {
    for (const chapterRow of section.chapters) {
      const globalIndex = (section.index - 1) * 10 + chapterRow.index;
      if (globalIndex < Math.max(state.nextChapter ?? 1, allowedStart)) continue;
      if (globalIndex > allowedEnd) return;
      const existing = await store.readChapter(book.id, section.id, chapterRow.id);
      if (store.currentText(existing.body).trim()) {
        state.nextChapter = globalIndex + 1;
        await writeJson(STATE_PATH, state);
        continue;
      }
      const chapterSpec = bookPackage.package.chapters[globalIndex - 1];
      process.stdout.write(`[${globalIndex}/${CHAPTERS}] ${chapterSpec.title}\n`);
      const context = await store.readChapterReviewContext(
        book.id, section.id, chapterRow.id,
      );
      const candidates = [];
      let draft = await generateDraft({ configs, context, chapterSpec });
      for (let iteration = 1; iteration <= MAX_ATTEMPTS; iteration += 1) {
        try { assertChapterOutputClean(draft); }
        catch { draft = ''; }
        if (!draft) break;
        let candidate;
        try {
          candidate = await editorialReview({
            configs, context, chapterSpec, draft, iteration,
          });
        } catch (error) {
          process.stderr.write(`[${globalIndex}] editorial ${iteration} invalid: ${error?.message || error}\n`);
          if (iteration < MAX_ATTEMPTS) {
            draft = await generateDraft({ configs, context, chapterSpec });
            continue;
          }
          break;
        }
        candidates.push(candidate);
        const best = selectBestApiEditorialCandidate(candidates);
        if (apiEditorialCandidatePasses(best, {
          ...EDITORIAL_SPEC, chapterIndex: globalIndex,
        })) break;
        if (iteration < MAX_ATTEMPTS) {
          draft = await editorialRewrite({ configs, context, chapterSpec, candidate: best });
        }
      }
      const selected = selectBestApiEditorialCandidate(candidates);
      if (!selected?.metrics?.deterministicGatePassed) {
        throw new Error(`CHAPTER_${globalIndex}_NO_DETERMINISTIC_CANDIDATE`);
      }
      const selectedDraft = selected.draft;
      await writeJson(path.join(RUN_DIR, `chapter-${String(globalIndex).padStart(3, '0')}-editorial.json`), {
        selectedIteration: selected.iteration,
        passed: apiEditorialCandidatePasses(selected, { ...EDITORIAL_SPEC, chapterIndex: globalIndex }),
        metrics: selected.metrics, review: selected.review,
      });
      const latestContext = await store.readChapterReviewContext(book.id, section.id, chapterRow.id);
      const body = await store.versionSet(book.id, `section:${section.id}:chapter:${chapterRow.id}`, selectedDraft, { expectedRevision: store.versionRevision(latestContext.chapter.body) });
      const fingerprint = store.contentFingerprint(store.currentText(body));
      const afterBody = await store.readChapterReviewContext(book.id, section.id, chapterRow.id);
      let strictReview = null;
      try {
        strictReview = await reviewDraft({ configs, context: afterBody, draft: selectedDraft });
        if (strictReview) {
          const savedReview = await store.saveChapterReview(book.id, section.id, chapterRow.id, strictReview, { expectedBodyFingerprint: fingerprint, expectedContextRevision: afterBody.contextRevision });
          if (!savedReview.applied) strictReview = null;
        }
      } catch (error) {
        process.stderr.write(`[${globalIndex}] strict review deferred: ${error?.message || error}\n`);
      }
      const system = buildSystemPrompt(afterBody.book.settings.core, afterBody.writingAssetContext?.text ?? '', afterBody.book.settings.storyEngine);
      const digested = await applyDigest({ configs, bookId: book.id, sectionId: section.id, chapterId: chapterRow.id, draft: selectedDraft, fingerprint, system, chapterIndex: globalIndex });
      state.nextChapter = globalIndex + 1;
      state.completed = globalIndex;
      state.lastChapter = { sectionId: section.id, chapterId: chapterRow.id, title: chapterSpec.title, characters: selectedDraft.length, editorialScore: selected.review.score, strictReviewScore: strictReview?.score ?? null, digested };
      await writeJson(STATE_PATH, state);
    }
  }
}
async function main() {
  await fs.mkdir(RUN_DIR, { recursive: true });
  const approval = await assertRestructureApproved();
  store.setDataRoot(DATA_ROOT);
  const configured = {
    chapter: await store.readConfigForTask('chapter'),
    review: await store.readConfigForTask('review'),
    digest: await store.readConfigForTask('digest'),
    outline: await store.readConfigForTask('outline'),
  };
  // 当前配置中的 deepseek-v4-flash 在长流上反复卡住 300 秒；同一官方
  // Chat Completions 服务的 deepseek-chat 已通过短响应实测。仅覆盖本次
  // 批处理的模型名，不修改用户持久配置或其它作品。
  const configs = Object.fromEntries(Object.entries(configured).map(
    ([task, config]) => [task, { ...config, model: 'deepseek-chat' }],
  ));
  const bookPackage = await readApprovedBookPackage();
  const book = await ensureBook(bookPackage, approval);
  const structure = await ensureStructure(book, bookPackage, approval);
  const state = await readJson(STATE_PATH, { schemaVersion: 1, bookId: book.id, nextChapter: 1, completed: 0, startedAt: new Date().toISOString() });
  state.bookId = book.id; state.title = book.title; state.updatedAt = new Date().toISOString();
  await writeJson(STATE_PATH, state);
  await runChapters(book, structure, bookPackage, configs, state, approval);
  state.finishedAt = new Date().toISOString();
  state.status = approval.allowedChapterRange.end < CHAPTERS
    ? 'approved_range_completed' : 'completed';
  state.completedApprovedRange = approval.allowedChapterRange;
  await writeJson(STATE_PATH, state);
  process.stdout.write(`${JSON.stringify({ ok: true, bookId: book.id, title: book.title, completed: state.completed, statePath: STATE_PATH })}\n`);
}

main().catch(async (error) => {
  const state = await readJson(STATE_PATH, {});
  const pausedForRestructure = error?.code === 'HUNDRED_CHAPTER_RESTRUCTURE_NOT_APPROVED';
  state.status = pausedForRestructure ? 'paused_for_restructure' : 'failed';
  state.error = error?.stack || String(error);
  state.updatedAt = new Date().toISOString();
  if (pausedForRestructure) {
    state.pauseReason = '百章规划尚未通过悬疑结构、真相时间线、能力规则与首卷因果验收，禁止继续机械生成正文。';
  }
  await writeJson(STATE_PATH, state).catch(() => {});
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
