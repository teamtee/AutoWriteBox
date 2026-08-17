// 集中管理来自 HTTP、备份和模型的资源边界，避免各层数值漂移。
// 单版本允许 20 万 UTF-16 字符；JSON 会把控制字符/未配对代理项扩展为
// 6 字节转义，最坏约 1.2 MB。传输上限必须覆盖业务允许值，再由字段级
// 校验收敛内容，避免出现“字符数合法但请求永远无法保存”。
export const JSON_BODY_LIMIT = '2mb';
export const MAX_ID_CHARS = 128;
export const MAX_TITLE_CHARS = 200;
export const MAX_PREMISE_CHARS = 20_000;
export const MAX_VERSION_TEXT_CHARS = 200_000;
export const MAX_VERSION_HISTORY_ITEMS = 20;
export const MAX_WHIP_CHARS = 10_000;

export const MAX_BOOK_SECTIONS = 1_000;
export const MAX_SECTION_CHAPTERS = 10_000;
export const MAX_TOTAL_BOOK_CHAPTERS = 50_000;
// 备份与日常读写共用同一整书章节上限，避免“能写不能导”。
export const MAX_TOTAL_BACKUP_CHAPTERS = MAX_TOTAL_BOOK_CHAPTERS;
export const MAX_PLANNED_SECTIONS = 100;
export const MAX_SECTION_PLAN_FIELD_CHARS = 300;

export const MAX_CONFIG_BASE_URL_CHARS = 2_048;
export const MAX_CONFIG_MODEL_CHARS = 256;
export const MAX_CONFIG_API_KEY_CHARS = 8_192;
// 模型上下文窗口按字符近似登记；分配器仍以 MAX_LLM_INPUT_CHARS 作本地硬上限。
// 旧配置缺失时使用 50 万，32k 等小窗口可显式调低。
export const MIN_MODEL_CONTEXT_CHARS = 16_000;
export const DEFAULT_MODEL_CONTEXT_CHARS = 500_000;
export const MAX_MODEL_CONTEXT_CHARS = 2_000_000;
export const MAX_CHAPTER_WORD_TARGET = 50_000;
// 以下三个是经验参考值，不是合格线。它们用来生成给作者和模型的
// 观察语句，不用来拒绝正文：某一章本来就该短、该快时低于它们是正常的。
// 订阅分成按千字计算，持续短章会直接减少收入，因此作为默认目标体量。
export const MIN_CHAPTER_WORD_TARGET = 3_000;
export const MIN_CHAPTER_BODY_CHARS = 3_000;
// 全章最长的连续叙述块。纯短对话行堆叠会让整章密度均匀，
// 而均匀密度是读者辨认 AI 文本最快的线索。
export const MIN_CHAPTER_SLOW_PASSAGE_CHARS = 250;
// 每千字身体与感官锚点。只统计确定性词表命中，用于发现正文退化为
// “会议纪要”，不能替代人工判断细节是否真的有效。
export const MIN_CHAPTER_SENSORY_DENSITY_PER_1K = 4;
// 连续多少章单调下滑才作为跨章趋势提示作者。
export const CHAPTER_PROSE_DECLINE_STREAK = 3;
export const MAX_DAILY_WORD_GOAL = 100_000;

export const MAX_LLM_INPUT_CHARS = 500_000;
export const MAX_LLM_OUTPUT_CHARS = 200_000;
// 模型可按单字符事件返回。累计完整输出时先合并为中等分片，避免合法
// 20 万字符输出同时保留 20 万个数组元素；这只是内存策略，不改变协议上限。
export const LLM_OUTPUT_JOIN_CHUNK_CHARS = 8_192;
// 字段上限描述单层最多想发送多少，不再承诺它们相加后低于总输入上限。
// 单次调用由 context-budget.js 先分配全局额度；本文件只提供各层 cap。
// 完整内容仍保存在磁盘；窗口只影响发送给模型的上下文。
export const MAX_CORE_PROMPT_FIELD_CHARS = 20_000;
export const MAX_BOOK_OUTLINE_PROMPT_CHARS = 40_000;
export const MAX_SECTION_OUTLINE_PROMPT_CHARS = 30_000;
// 当前部已有上一章结尾和交接快照双重连续性锚点，只保留 2 万字符前情；
// 把更多预算让给跨部长线，避免前一千章塌缩成一句“更早剧情已省略”。
export const MAX_SECTION_PROMPT_SUMMARY_CHARS = 20_000;
// 跨分部前情使用 6 万字符总预算；单部仍先压到首部/相关/尾部窗口，
// 再在全部旧部之间保留最近部与本章直接相关的久远部。
export const MAX_BOOK_SECTION_SUMMARY_CHARS = 5_000;
export const MAX_BOOK_PROMPT_SUMMARY_CHARS = 60_000;
// 阶段摘要是作者可编辑、可冻结的长程压缩层。单次最多聚合 20 个
// 分部的有界摘要，既避免一键重算意外发起数百次模型调用，也给模型
// 输入、本地主数据和生成上下文留出明确边界。
export const MAX_STAGE_SUMMARIES_PER_BOOK = 200;
export const MAX_STAGE_SUMMARY_SOURCE_SECTIONS = 20;
export const MAX_STAGE_SUMMARY_CHARS = 4_000;
export const MAX_STAGE_SUMMARY_TITLE_CHARS = 80;
// 备份可合法携带上千人物；按单字段最大值直接展开会超过模型总输入。
// 每个作用域保留主要（列表前部）与最近（列表尾部）人物，并显式标记省略。
export const MAX_CHARACTER_PROMPT_SCOPE_CHARS = 15_000;
// 典型网文章节通常在数千字。仅带最后数百字会丢掉上一章场景的目标、
// 冲突起点和人物选择，只剩最后一句钩子，审稿也无法判断跨章承接。
// 保留 6,000 字符通常可覆盖完整短章；超长章仍只发送末尾窗口。
export const MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS = 6_000;
// 允许单个 SSE JSON 事件使用 Unicode 转义，同时防止无分隔符的上游响应无界累积。
export const MAX_LLM_STREAM_BUFFER_CHARS = 1_700_000;
// 缓冲上限只约束单个未完成事件；恶意或故障上游仍可能发送无限多个
// usage/注释帧。累计解压后传输量也必须有界，且给逐 token JSON 开销留足余量。
export const MAX_LLM_STREAM_BYTES = 64 * 1024 * 1024;
export const MAX_CONCURRENT_LLM_REQUESTS = 2;

// 本地 JSON 文件边界。book.json 同时保存大纲和四项核心设定的版本历史；
// 5 × 20 × 20 万字符在 JSON 最坏转义下约 114.5 MiB，再加人物、简介和
// 分部引用后约 118 MiB。128 MiB 才能覆盖所有经日常 API 合法写入的形态。
// 备份是独立的传输资源边界，仍保持 100 MiB，不能再与 book.json 共用常量。
export const MAX_BOOK_JSON_BYTES = 128 * 1024 * 1024;
export const MAX_BOOK_BACKUP_BYTES = 100 * 1024 * 1024;
export const MAX_SECTION_JSON_BYTES = 100 * 1024 * 1024;
export const MAX_CHAPTER_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_CONFIG_JSON_BYTES = 128 * 1024;
export const MAX_STRUCTURE_TRANSACTION_JSON_BYTES = 128 * 1024;
export const MAX_IMPORT_OWNER_JSON_BYTES = 16 * 1024;
// 诊断是人工处理入口，过多明细会同时拖垮 API 序列化和前端 DOM。
export const MAX_STORAGE_DIAGNOSTIC_ISSUES = 500;
// 启动恢复不应因大量损坏事务无界扫描并积累错误对象。
// 达到上限后保留原文件，由有明细上限的书架诊断继续定位。
export const MAX_STRUCTURE_RECOVERY_FAILURES = MAX_STORAGE_DIAGNOSTIC_ISSUES;
// 根目录容纳书籍/回收站项；单书和单部则只应有受约束的子项加少量内部文件。
export const MAX_STORAGE_ROOT_DIRECTORY_ENTRIES = 10_000;
export const MAX_BOOK_DIRECTORY_ENTRIES = MAX_BOOK_SECTIONS + 16;
export const MAX_SECTION_DIRECTORY_ENTRIES = MAX_SECTION_CHAPTERS + 16;

export const MAX_DIGEST_SUMMARY_CHARS = 200;
export const MAX_DIGEST_PROGRESS_CHARS = 500;
export const MAX_DIGEST_CHARACTERS = 20;
// 摘要 API 从正文末态提取的跨章交接快照。它不是第二份摘要，
// 只保留下一章开场不能静默重置的即时边界。
export const MAX_CHAPTER_HANDOFF_FIELD_CHARS = 300;
// 单次摘要最多新增 20 人，但一本长篇可能跨章持续遇到新人物；给长期存储单独设总量上限。
export const MAX_STORED_CHARACTERS = 1_000;
// 分部摘要由最多一万章的小结拼接而成，不能沿用单章 200 字上限。
export const MAX_SECTION_SUMMARY_CHARS = 5_000_000;
export const MAX_CHARACTER_NAME_CHARS = 50;
export const MAX_CHARACTER_ROLE_CHARS = 100;
export const MAX_CHARACTER_DESC_CHARS = 500;
export const MAX_REVIEW_INSTRUCTION_CHARS = 1_000;
export const MAX_REVIEW_CHECK_DETAIL_CHARS = 120;
export const MAX_REVIEW_SIGNAL_CHARS = 40;
export const MAX_GOLDEN_THREE_CHAPTER_PROMPT_CHARS = 80_000;
export const MAX_GOLDEN_THREE_VERDICT_CHARS = 120;
export const MAX_GOLDEN_THREE_CHECK_SUMMARY_CHARS = 200;
export const MAX_GOLDEN_THREE_EVIDENCE_CHARS = 160;
export const MAX_GOLDEN_THREE_FIX_LABEL_CHARS = 30;
export const MAX_GOLDEN_THREE_FIX_PROBLEM_CHARS = 200;
export const MAX_GOLDEN_THREE_FIX_INSTRUCTION_CHARS = 1_000;
export const MAX_GOLDEN_THREE_FIXES = 5;
export const MAX_PLAN_COMPARISON_SUMMARY_CHARS = 300;
export const MAX_PLAN_COMPARISON_EVIDENCE_CHARS = 200;
export const MAX_PLAN_CARRYOVER_TEXT_CHARS = 300;
export const MAX_PLAN_CARRYOVER_REASON_CHARS = 200;
export const MAX_RECENT_REVIEW_SIGNAL_CHAPTERS = 5;
export const MAX_RECENT_REVIEW_SIGNAL_SCAN_CHAPTERS = 50;

// 章节生成前的人工策划卡。章级意图保持短而可扫读；场景链只保存
// 写作执行所需的承接触发、欲望、阻碍、行动、转折和代价，避免把小纲膨胀成正文。
// 全部字段会进入生成与审稿提示词，也会参与上下文修订号计算。
export const MAX_CHAPTER_PLAN_FIELD_CHARS = 500;
export const MAX_CHAPTER_PLAN_NOTES_CHARS = 1_000;
export const MAX_CHAPTER_PLAN_SCENES = 12;
export const MAX_CHAPTER_PLAN_SCENE_TITLE_CHARS = 80;
export const MAX_CHAPTER_PLAN_SCENE_FIELD_CHARS = 300;
// AI 策划可参考已有正文，但无需把完整 20 万字章节再次发送给模型。
// 保留首尾窗口足以识别现有开场、关键推进和章末状态，也为全书上下文留出预算。
export const MAX_CHAPTER_PLAN_SOURCE_PROMPT_CHARS = 20_000;

// 作品级核心循环只描述可重复的阅读体验与升级逻辑，不承载完整大纲。
// 五项各自保持短小，确保每章生成和审稿都能稳定携带。
export const MAX_STORY_ENGINE_FIELD_CHARS = 500;

// 读者承诺账本保存结构性阅读债务。每条推进只记录一次有意义的状态变化，
// 不复制章节摘要；上下文再从完整账本中选择临期、逾期和高重要度条目。
export const MAX_PROMISE_LEDGER_ENTRIES = 1_000;
export const MAX_PROMISE_PROGRESS_EVENTS = 50;
export const MAX_PROMISE_TEXT_CHARS = 500;
export const MAX_PROMISE_PROGRESS_CHARS = 300;
export const MAX_PROMISE_NOTES_CHARS = 1_000;
export const MAX_PROMISE_LEDGER_CONTEXT_CHARS = 16_000;

// 人物导演卡只保存当前驱动力、压力反应和声音规则；已经发生的客观事实
// 仍归长期记忆。关系温度允许按章留少量变化证据，避免静态好感度失真。
export const MAX_CHARACTER_CRAFT_ENTRIES = 500;
export const MAX_RELATIONSHIP_CRAFT_ENTRIES = 1_000;
export const MAX_RELATIONSHIP_TEMPERATURE_EVENTS = 50;
export const MAX_CHARACTER_CRAFT_NAME_CHARS = 100;
export const MAX_CHARACTER_CRAFT_FIELD_CHARS = 500;
export const MAX_CHARACTER_CRAFT_EVENT_CHARS = 300;
export const MAX_CHARACTER_CRAFT_NOTES_CHARS = 1_000;
export const MAX_CHARACTER_CRAFT_CONTEXT_CHARS = 16_000;

// 全局创作资产库。提取时允许输入较长章节/片段，但只保存短预览与摘要，
// 不把用户提供的参考全文复制进长期存储。
export const MAX_WRITING_ASSETS = 500;
export const MAX_WRITING_ASSET_NAME_CHARS = 80;
export const MAX_WRITING_ASSET_SOURCE_NAME_CHARS = 200;
export const MAX_WRITING_ASSET_SOURCE_CHARS = 100_000;
export const MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS = 10_000;
export const MAX_WRITING_ASSET_SOURCE_PREVIEW_CHARS = 2_000;
export const MAX_WRITING_ASSET_FIELD_CHARS = 1_000;
export const MAX_WRITING_ASSET_PROMPT_CHARS = 4_000;
export const MAX_WRITING_ASSET_LIST_ITEMS = 20;
export const MAX_WRITING_ASSET_NOTE_CHARS = 500;
export const MAX_WRITING_ASSET_REFERENCE_URL_CHARS = 2_048;
export const MAX_WRITING_ASSET_METADATA_TAGS = 12;
export const MAX_WRITING_ASSET_METADATA_TAG_CHARS = 40;
export const MAX_WRITING_ASSET_BOOK_BINDINGS = 1_000;
export const MAX_WRITING_ASSET_AUXILIARY_BINDINGS = 3;
export const MAX_WRITING_ASSET_CHAPTER_SCENE_BINDINGS = 5_000;
export const MAX_WRITING_ASSET_CONTEXT_CHARS = 16_000;
export const MAX_WRITING_ASSET_JSON_BYTES = 8 * 1024 * 1024;

// 可快速切换的 API 服务方案；每个服务可登记多个模型，但真正调用始终
// 只使用作者显式选中的一个，不做失败后的静默切换。
export const MAX_API_PROFILES = 50;
export const MAX_API_PROFILE_MODELS = 50;
export const MAX_API_PROFILE_NAME_CHARS = 80;
export const MAX_API_PROFILE_NOTE_CHARS = 200;
export const MAX_API_BOOK_BINDINGS = 10_000;
export const MAX_API_PROFILES_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_DISCOVERED_MODELS = 500;
export const MAX_DISCOVERED_MODEL_ITEMS_SCANNED = 5_000;
export const MAX_LLM_MODELS_RESPONSE_BYTES = 1024 * 1024;
export const MAX_LLM_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

// 百万字长期记忆：模型每章只提出少量候选，人工确认后才进入全书事实库。
// 事实库上限按 5 万条设计，既覆盖长篇连载，又确保 book.json 仍受现有
// 128 MiB 文件边界保护。
export const MAX_MEMORY_CANDIDATES_PER_CHAPTER = 20;
export const MAX_MEMORY_FACTS_PER_BOOK = 50_000;
export const MAX_MEMORY_REJECTIONS_PER_BOOK = 50_000;
export const MAX_MEMORY_SUBJECT_CHARS = 80;
// 同一人物、物品或地点在正文里可能使用姓名、昵称、代称。别名只用于
// 精确召回，不另起一条事实，避免“陆昭 / 昭哥”被当成两个实体。
export const MAX_MEMORY_ALIASES = 8;
export const MAX_MEMORY_ALIAS_CHARS = 40;
export const MAX_MEMORY_PREDICATE_CHARS = 80;
export const MAX_MEMORY_OBJECT_CHARS = 400;
export const MAX_MEMORY_EVIDENCE_CHARS = 300;
export const MAX_MEMORY_DETAIL_CHARS = 200;
export const MAX_MEMORY_DETAIL_PARTICIPANTS = 20;
export const MAX_MEMORY_DETAILS_TOTAL_CHARS = 800;
export const MAX_MEMORY_CONTEXT_CHARS = 12_000;
