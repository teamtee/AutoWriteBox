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
export const MAX_CHAPTER_WORD_TARGET = 50_000;
export const MAX_DAILY_WORD_GOAL = 100_000;

export const MAX_LLM_INPUT_CHARS = 500_000;
export const MAX_LLM_OUTPUT_CHARS = 200_000;
// 模型可按单字符事件返回。累计完整输出时先合并为中等分片，避免合法
// 20 万字符输出同时保留 20 万个数组元素；这只是内存策略，不改变协议上限。
export const LLM_OUTPUT_JOIN_CHUNK_CHARS = 8_192;
// 最坏情况下，章节重写/审稿还要完整携带 20 万字符正文，抽打另有 1 万字符
// 指令。以下窗口合计控制在约 26 万字符内，为标签和固定指令留出余量。
// 完整内容仍保存在磁盘；窗口只影响发送给模型的上下文。
export const MAX_CORE_PROMPT_FIELD_CHARS = 20_000;
export const MAX_BOOK_OUTLINE_PROMPT_CHARS = 40_000;
export const MAX_SECTION_OUTLINE_PROMPT_CHARS = 30_000;
// 本部摘要会按章节聚合，合法的万章分部可自然增长到模型总输入上限以上。
// 生成时只携带最近的前情窗口；完整摘要仍原样保存在磁盘和备份中。
export const MAX_SECTION_PROMPT_SUMMARY_CHARS = 60_000;
// 跨分部前情只保留各部最近摘要的有界窗口。它与当前本部 6 万字符窗口
// 分开计费，给完整章节重写、核心设定和其它上下文留出总输入余量。
export const MAX_BOOK_SECTION_SUMMARY_CHARS = 5_000;
export const MAX_BOOK_PROMPT_SUMMARY_CHARS = 20_000;
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
export const MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS = 300;
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
export const MAX_RECENT_REVIEW_SIGNAL_CHAPTERS = 5;
export const MAX_RECENT_REVIEW_SIGNAL_SCAN_CHAPTERS = 50;

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
export const MAX_MEMORY_PREDICATE_CHARS = 80;
export const MAX_MEMORY_OBJECT_CHARS = 400;
export const MAX_MEMORY_EVIDENCE_CHARS = 300;
export const MAX_MEMORY_DETAIL_CHARS = 200;
export const MAX_MEMORY_DETAIL_PARTICIPANTS = 20;
export const MAX_MEMORY_DETAILS_TOTAL_CHARS = 800;
export const MAX_MEMORY_CONTEXT_CHARS = 12_000;
