import type { ApiModelDiscoveryInput, ApiModelDiscoveryResult, ApiProfile, ApiProfileLibrary, ApiProfileSaveInput, ApiTaskRoute, ApiTaskRoutes, Book, BookMemoryLibrary, BookTree, BookSummary, Chapter, ChapterPlan, ChapterPlanDraftResult, ChapterPlanInput, ChapterPublicationPreflight, ChapterPublicationResult, Config, DeletedBook, MemoryDecisionAction, MemoryDecisionResult, MemoryFactMutationResult, PlatformConfirmationInput, Section, SerializationSettings, StageSummaryInput, StageSummaryMutationResult, StorageDiagnostics, StoryEngine, StoryEngineInput, TitleSource, WritingAssetBindingResult, WritingAssetBookBinding, WritingAssetExtractionInput, WritingAssetExtractionResult, WritingAssetLibrary, WritingAssetReferenceInput } from './types';
import { PUBLIC_ERROR_PAYLOAD } from './api-contract';
import {
  MAX_SSE_STREAM_BYTES, MAX_STREAM_DELTA_CHARS, parseSSELines,
  SSE_RESPONSE_INVALID_UTF8, SSE_RESPONSE_TOO_LARGE,
} from './api-sse';
import type { SSEEvent } from './api-sse';
import { createCharacterCraftApi } from './character-craft-api';
import { createPromiseLedgerApi } from './promise-ledger-api';
import { createReviewApi } from './review-api';
export { parseSSELines } from './api-sse';
export type { PostprocessWarning, SSEEvent } from './api-sse';
const apiErrorMessages: Record<string, string> = {
  LLM_BASE_URL_REQUIRED: '请先在 API 设置中填写 Base URL',
  LLM_MODEL_REQUIRED: '请先在 API 设置中填写模型名',
  LLM_BASE_URL_INVALID: 'Base URL 必须是有效的 http(s) 地址，且不能带查询参数、片段或内嵌账号密码',
  LLM_MODEL_INVALID: '模型名不能包含换行或其他控制字符，请重新输入',
  LLM_API_KEY_INVALID: 'API Key 不能包含换行或其他控制字符，请重新输入',
  LLM_CONFIG_TOO_LARGE: '模型配置异常过长，请检查 Base URL、模型名和 API Key',
  LLM_INPUT_TOO_LARGE: '本次上下文超出模型输入上限，且分层预算未能降级。正常情况下超额材料会被自动裁剪并标注，出现本提示说明装配存在缺陷，请在章节页“API 上下文体检”查看各层实际占用',
  LLM_INPUT_INVALID: '当前生成请求结构异常，请刷新页面后重试',
  LLM_BUSY: '当前已有较多生成任务，请等待其中一个完成后再试',
  LLM_EMPTY_BODY: '模型服务返回了空响应，本次内容未保存；请检查接口兼容性后重试',
  INVALID_JSON: '请求内容不是有效的 JSON，请刷新页面后重试',
  HOST_NOT_ALLOWED: '当前访问地址不受本地服务信任，请使用启动器显示的 localhost 或 127.0.0.1 地址',
  ORIGIN_NOT_ALLOWED: '页面来源与本地服务地址不一致，已阻止跨站请求；请从启动器显示的地址重新打开',
  STORAGE_FULL: '本地磁盘空间或配额不足，内容未保存；请释放空间后重试',
  STORAGE_PERMISSION_DENIED: '项目数据目录不可写，内容未保存；请检查目录权限或只读状态',
  STORAGE_IO_ERROR: '本地磁盘读写失败，内容可能未保存；请检查磁盘状态并先备份 data 目录',
  STORAGE_FILE_LIMIT: '系统打开的文件过多，请关闭部分程序或重启应用后重试',
  STORAGE_PATH_INVALID: '项目数据路径不可用，请确认 data 目录及其上级目录均为文件夹',
  STORAGE_PATH_UNSAFE: '项目数据路径包含符号链接，已停止读写以防止越界访问；请返回书架查看完整性告警',
  STORAGE_DIRECTORY_LIMIT_EXCEEDED: '本地数据目录的子项数量异常过多，已停止枚举以保护内存；请先备份 data 目录并检查多余文件',
  STORAGE_FILE_MISSING: '作品文件意外缺失，请返回书架查看完整性告警并备份 data 目录',
  STORAGE_JSON_INVALID: '本地作品数据已损坏，请返回书架运行深度检查并先备份 data 目录',
  STORAGE_DATA_INVALID: '本地作品索引结构异常，已停止加载以保护内存；请返回书架运行深度检查并先备份 data 目录',
  STORAGE_FILE_TOO_LARGE: '本地作品文件异常过大，已停止读取以保护内存；请返回书架查看完整性告警并先备份 data 目录',
  INTERNAL_ERROR: '应用发生内部错误，本次操作可能未完成；请重试并查看启动终端日志',
  REQUEST_TOO_LARGE: '请求内容超过 2 MB 上限，请精简后重试',
  PREMISE_TOO_LARGE: '故事设想过长，请精简到 2 万字符以内',
  TITLE_TOO_LARGE: '标题过长，请精简到 200 字符以内',
  TEXT_TOO_LARGE: '当前内容过长，单个版本最多保存 20 万字符',
  WHIP_TOO_LARGE: '加鞭指令过长，请精简到 1 万字符以内',
  CONFIG_TEXT_TOO_LARGE: 'API 配置字段异常过长，请精简后重试',
  BAD_CHAPTER_WORD_TARGET: '每章目标字数必须是 1–50000 的整数',
  BAD_DAILY_WORD_GOAL: '每日字数目标必须是 1–100000 的整数',
  BAD_SERIALIZATION_REVISION: '页面缺少有效的连载设置版本，请刷新后重试',
  SERIALIZATION_CONFLICT: '连载设置已被另一页面修改；本次旧页面保存未覆盖新版',
  BAD_PLATFORM_CONFIRMATION: '请完整填写平台、官方规则/AI 政策链接和合同核对说明，并勾选全部人工确认项',
  BAD_PLATFORM_CONFIRMATION_ID: '平台核对记录标识无效，请刷新后重试',
  PLATFORM_CONFIRMATION_NOT_FOUND: '该平台核对记录已不存在，请刷新连载管理',
  PLATFORM_CONFIRMATION_DUPLICATE: '同名平台已有核对记录，请编辑原记录',
  PLATFORM_CONFIRMATION_LIMIT: '每本书最多保留 20 个平台核对记录，请先整理旧记录',
  BAD_REQUEST_TIMEOUT: '模型请求超时必须是 1000–3600000 毫秒的整数',
  BAD_MODEL_CONTEXT_CHARS: '模型上下文窗口必须是 16000–2000000 字符的整数',
  API_KEY_REQUIRED_FOR_BASE_URL_CHANGE: '修改 Base URL 时必须重新输入 API Key，避免把旧密钥发送给新的服务地址',
  BAD_VERSION_REWRITE_PATH: '章节内容请使用章节页面中的生成或重写操作',
  BAD_PATH: '页面请求的内容位置无效，请刷新后重试',
  BAD_DELTA: '版本切换方向无效，请刷新页面后重试',
  BAD_TEXT: '页面提交的正文格式无效，请保留草稿并刷新后重试',
  BAD_MODE: '页面提交的生成模式无效，请刷新后重试',
  BAD_WHIP: '请输入要调整正文的抽打意见',
  BAD_PREMISE: '故事设想不能为空，请输入后重试',
  BAD_SECTION_OUTLINE: '分部规划必须是有效文本，请刷新页面后重试',
  BAD_CHAPTER_PLAN: '章节策划卡格式无效，请检查各字段后重试',
  BAD_CHAPTER_PLAN_REVISION: '页面缺少有效的策划卡修订号，请重新打开本章',
  CHAPTER_PLAN_TOO_LARGE: '章节策划卡过长；章级字段各限 500 字、补充说明限 1000 字，场景最多 12 个且各字段限 300 字',
  CHAPTER_PLAN_CONFLICT: '章节策划卡已被另一页面修改；已拒绝旧页面覆盖，请核对后重试',
  CHAPTER_PLAN_QUALITY_DOWNGRADE: '当前策划已启用新版质量合同，旧页面不能降级覆盖；请刷新后继续编辑', CHAPTER_PLAN_RHYTHM_DOWNGRADE: '当前策划已启用写前节奏意图，旧页面不能降级覆盖；请刷新后继续编辑',
  CHAPTER_PLAN_DRAFT_FAILED: '模型没有返回完整可用的章节与场景策划，本次没有改动当前草稿；请重试或切换模型',
  CHAPTER_OUTPUT_LEAKED: '模型把策划、债务编号或审稿字段写进了小说正文，本次结果未保存；请重试或切换模型',
  CHAPTER_PLAN_NOT_READY: '请先完成并保存章节策划的写前质量门槛，再生成正文',
  BAD_STORY_ENGINE: '作品核心循环格式无效，请检查五项内容后重试',
  BAD_STORY_ENGINE_REVISION: '页面缺少有效的核心循环修订号，请重新打开核心设定',
  STORY_ENGINE_TOO_LARGE: '作品核心循环每项最多 500 字，请精简后重试',
  STORY_ENGINE_CONFLICT: '作品核心循环已被另一页面修改；本次旧页面保存未覆盖新版',
  BAD_PROMISE_LEDGER: '承诺账本结构无效，请刷新后重试', BAD_PROMISE_ENTRY: '请完整填写承诺、预计兑现章序和当前状态；兑现或放弃时还要填写结果',
  BAD_PROMISE_LEDGER_REVISION: '页面缺少有效的承诺账本修订号，请重新打开核心设定', PROMISE_LEDGER_TOO_LARGE: '承诺账本内容过长；单条承诺和结果最多 500 字，推进记录最多 300 字',
  PROMISE_LEDGER_LIMIT: '本书承诺账本已达到 1000 条上限，请先兑现、合并或清理无效条目', PROMISE_LEDGER_CONFLICT: '承诺账本已被另一页面修改；本次旧页面操作未覆盖新版', BAD_REVIEW_PROMISE_ANCHOR: '页面缺少正文、审稿或承诺账本版本标识，请重新打开本章', REVIEW_PROMISE_CANDIDATE_NOT_FOUND: '这条审稿账本候选已不存在，请重新审稿', REVIEW_PROMISE_CANDIDATE_STALE: '正文、策划或审稿已经变化，旧候选未写入账本；请重新审稿',
  PROMISE_EVIDENCE_IMMUTABLE: '正文证据节拍只能由审稿候选确认或正文版本变化更新，不能在账本表单中伪造、编辑或删除', BAD_REVIEW_WORLD_GATE_ANCHOR: '页面缺少正文、审稿或世界进度版本标识，请重新打开本章', REVIEW_WORLD_GATE_CANDIDATE_NOT_FOUND: '本章没有可确认的世界门槛候选，请重新审稿', REVIEW_WORLD_GATE_CANDIDATE_STALE: '正文、分部合同、世界圣经或审稿已经变化，旧门槛候选未确认', WORLD_PROGRESS_CONFLICT: '世界层级进度已被另一页面修改；请刷新后重新确认',
  PROMISE_ENTRY_NOT_FOUND: '该承诺已被另一页面删除，请刷新账本',
  BAD_CHARACTER_CRAFT: '人物导演卡结构无效，请刷新后重试', BAD_CHARACTER_GUIDE: '人物导演卡至少需要姓名和一项有效的驱动力或声音规则',
  BAD_RELATIONSHIP_GUIDE: '关系导演卡需要两个不同人物，并填写关系状态、张力、方向或温度变化', BAD_CHARACTER_CRAFT_ENTRY: '人物导演卡标识无效，请刷新后重试',
  BAD_CHARACTER_CRAFT_REVISION: '页面缺少有效的人物导演卡修订号，请重新打开核心设定', CHARACTER_CRAFT_TOO_LARGE: '人物导演卡内容过长；单项最多 500 字、温度变化原因最多 300 字',
  CHARACTER_CRAFT_LIMIT: '人物导演卡已达到数量上限，请先合并或清理不再使用的条目', CHARACTER_CRAFT_CONFLICT: '人物导演卡已被另一页面修改；本次旧页面操作未覆盖新版', CHARACTER_CRAFT_ENTRY_NOT_FOUND: '该人物导演卡已被另一页面删除，请刷新',
  BAD_ID: '请求中的作品、分部或章节标识无效，请刷新页面后重试',
  BAD_TITLE: '标题格式无效，请重新输入',
  BAD_CONFIG_PATCH: '页面提交的设置格式无效，请重新读取设置后重试',
  BAD_CONFIG_FIELD: '页面包含不受支持的设置字段，请刷新后重试',
  BAD_CONFIG_TEXT_FIELD: 'API 设置中的文本字段格式无效，请重新输入',
  BAD_BOOK_CREATION_ID: '新建请求标识无效，请刷新页面后重试',
  BOOK_SECTION_LIMIT: '该作品的分部数已达上限',
  SECTION_CHAPTER_LIMIT: '该分部的章节数已达上限',
  BOOK_CHAPTER_LIMIT: '该作品的总章节数已达上限',
  BOOK_LIBRARY_LIMIT: '书架作品数已达安全上限，请先备份并移走不再使用的作品',
  TRASH_BOOK_LIMIT: '回收站条目数已达安全上限；请先备份 data 目录，再人工整理 data/trash/books',
  NOT_FOUND: '请求的页面或接口不存在，请刷新页面；若刚升级应用，请重启本地服务',
  BOOK_NOT_FOUND: '作品不存在或已被移入回收站，请刷新书架后重试',
  SECTION_NOT_FOUND: '分部不存在或已从作品索引中移除，请刷新后重试',
  CHAPTER_NOT_FOUND: '章节不存在或已从分部索引中移除，请刷新后重试',
  BOOK_ALREADY_EXISTS: '活动书架中已存在同一作品，未覆盖现有数据',
  BOOK_TITLE_CONFLICT: '作品名已被另一页面修改；本次旧页面改名未执行，请刷新后确认',
  BOOK_DELETE_CONFLICT: '作品已被另一页面更新；本次旧书架删除未执行，请刷新后确认',
  BAD_BOOK_TITLE_ANCHOR: '页面缺少改名前的作品名标识，请刷新书架后重试',
  BAD_BOOK_DELETE_ANCHOR: '页面缺少删除前的作品更新时间标识，请刷新书架后重试',
  TRASH_BOOK_NOT_FOUND: '回收站副本已不存在，请刷新书架',
  TRASH_BOOK_INVALID: '回收站副本不完整或已损坏；原文件未被修改，请先备份 data/trash 目录后人工检查',
  REVIEW_STALE: '审稿期间正文已经变化，本次旧审稿结果未保存，请重新审稿',
  REVIEW_CONTEXT_STALE: '审稿期间大纲、设定或本部前情已经变化，本次旧上下文审稿未保存，请刷新后重新审稿',
  BAD_REVIEW_ANCHOR: '页面缺少有效的审稿正文或上下文标识，请刷新章节后重试',
  REVIEW_FAILED: '模型返回的审稿结果格式不完整，本次审稿未保存；请重新审稿',
  BAD_GOLDEN_THREE_ANCHOR: '页面缺少有效的黄金三章审稿版本，请刷新第三章后重试',
  GOLDEN_THREE_INCOMPLETE: '全书前三章尚未全部写入正文，暂时不能联合审稿',
  GOLDEN_THREE_STALE: '联合审稿期间前三章或作品承诺已经变化，旧结果未保存；请刷新后重试',
  GOLDEN_THREE_REVIEW_FAILED: '模型没有返回完整的黄金三章联合审稿，本次结果未保存；请重试或切换模型',
  BAD_CHAPTER_REVISION_STAGE: '修订阶段无效，请刷新章节后重试',
  BAD_CHAPTER_REVISION_ANCHOR: '页面缺少有效的正文或上下文版本，请刷新章节后重试',
  CHAPTER_REVISION_CANDIDATE_STALE: '候选生成期间正文或故事上下文已经变化，旧候选未采用；请刷新后重试',
  CHAPTER_REVISION_CANDIDATE_FAILED: '模型没有返回完整可用的章节候选；当前正文未改动，请重试或切换模型',
  BAD_CHAPTER_REVIEW_REVISION_ANCHOR: '页面缺少当前正文、上下文或审稿版本，请刷新章节后重试',
  CHAPTER_REVIEW_HAS_NO_REVISIONS: '当前有效审稿没有需要 API 精修的正文问题',
  CHAPTER_REVIEW_REVISION_CANDIDATE_STALE: '精修期间正文、故事上下文或审稿已经变化；旧候选未采用，请刷新后重试',
  CHAPTER_REVIEW_REVISION_CANDIDATE_FAILED: '写作模型没有返回完整可用的审稿精修候选；当前正文未改动',
  CHAPTER_EMPTY: '当前章节正文为空，请先生成或输入正文后再操作',
  VERSION_CONFLICT: '服务器内容已被另一页面更新；本次操作未执行，请刷新后确认',
  BAD_VERSION_REVISION: '页面缺少有效的版本标识，请刷新后重试',
  NEXT_SECTION_CONFLICT: '另一页面已经新增分部；本次请求未执行，请刷新后确认',
  BAD_NEXT_SECTION_ANCHOR: '页面缺少当前末部标识，请刷新后重试',
  NEXT_CHAPTER_CONFLICT: '另一页面已经新增或开始生成下一章；本次请求未执行，请刷新后确认',
  BAD_NEXT_CHAPTER_ANCHOR: '页面缺少当前末章标识，请刷新后重试',
  GENERATION_CONTEXT_CONFLICT: '生成期间章节结构、大纲、设定或前情已被另一页面更新；旧上下文结果未保存，请刷新后重新生成',
  BAD_GENERATION_CONTEXT_REVISION: '页面缺少有效的生成上下文标识，请刷新后重试',
  SECTION_PLAN_WORLD_BIBLE_REQUIRED: '分部规划需要先在核心设定中用 API 建立合格的三层世界圣经',
  CONFIG_CONFLICT: '设置已被另一页面更新；本次旧配置未保存，请重新读取后再修改',
  BAD_CONFIG_REVISION: '页面缺少有效的设置修订号，请重新读取设置后再保存',
  STRUCTURE_TRANSACTION_RECOVERED: '检测到并完成了一笔此前中断的结构操作；本次操作未执行，请刷新确认后再操作',
  BACKUP_INVALID: '备份文件结构无效或已损坏',
  BACKUP_INVALID_JSON: '备份文件不是有效的 JSON',
  BACKUP_TOO_LARGE: '备份文件超过 100 MB 上限',
  BACKUP_BOOK_INVALID: '作品主数据异常，请先处理书架中的完整性告警',
  BACKUP_SECTION_INVALID: '作品分部数据异常，请先处理书架中的完整性告警',
  BACKUP_CHANGED_DURING_EXPORT: '导出期间作品结构持续变化，请稍后重试',
  BACKUP_EXPORT_BUSY: '当前已有导出正在处理，请稍后再试',
  BACKUP_DOWNLOAD_NOT_FOUND: '导出下载链接已失效，请重新导出',
  BAD_MANUSCRIPT_SOURCE: '发布稿来源无效，请刷新页面后重试',
  MANUSCRIPT_EMPTY: '作品还没有可导出的非空正文',
  MANUSCRIPT_TOO_LARGE: '纯文本发布稿超过 100 MB 上限，请按分部拆分整理',
  LLM_TIMEOUT: '模型请求超时，请检查网络或在 API 设置中适当延长超时时间',
  LLM_STREAM_INCOMPLETE: '模型连接提前中断，残缺内容未保存，请重试',
  LLM_FINISH_LENGTH: '模型达到输出长度上限，残缺内容未保存；请缩短每章目标字数或提高服务输出上限',
  LLM_FINISH_CONTENT_FILTER: '模型服务因内容策略中止生成，本次内容未保存',
  LLM_RESPONSE_TOO_LARGE: '模型返回内容异常过大，已停止且未保存',
  LLM_STREAM_BUFFER_TOO_LARGE: '模型服务返回了异常过大的流数据，已停止且未保存',
  LLM_STREAM_TOO_LARGE: '模型服务累计返回了异常过多的流数据，已停止且未保存',
  LLM_REDIRECT_NOT_ALLOWED: '模型服务要求跳转到其它地址，已阻止转发 API Key 和作品内容；请将 Base URL 改为最终接口地址',
  LLM_INSECURE_API_KEY_TRANSPORT: '不会通过远程明文 HTTP 发送 API Key；请改用 HTTPS、本机回环地址，或清空免密服务的 Key',
  LLM_EMPTY_RESPONSE: '模型没有返回有效内容，请重试',
  BAD_ASSET_ID: '文风资产标识无效，请刷新资产库后重试',
  BAD_ASSET_NAME: '请输入资产名称',
  BAD_ASSET_SOURCE: '请提供可读取的创作样本和来源说明',
  BAD_ASSET_SOURCE_KIND: '请选择有效的素材授权类型',
  BAD_ASSET_METADATA: '资产备注或标签格式无效；单项备注最多 500 字，标签最多 12 个且每项不超过 40 字',
  BAD_ASSET_REFERENCE_URL: '请输入不含账号密码的有效 http(s) 参考链接',
  BAD_ASSET_RIGHTS_NOTE: '该来源类型需要填写权利说明，说明授权、公共领域依据或短摘录用途',
  BAD_ASSET_BINDING: '文风资产绑定包含已删除的资产、无效场景或超出数量限制，请刷新后重试',
  ASSET_NATIVE_SOURCE_UNPUBLISHED: '只有已确认发布的章节正文才能提取为本书原生文风',
  BAD_ASSET_REVISION: '资产库修订信息无效，请刷新后重试',
  ASSET_NAME_TOO_LARGE: '资产名称过长，请精简到 80 字符以内',
  ASSET_SOURCE_NAME_TOO_LARGE: '来源说明过长，请精简到 200 字符以内',
  ASSET_SOURCE_TOO_LARGE: '创作样本过长，请精简到 10 万字符以内或分段提取',
  ASSET_EXCERPT_TOO_LARGE: '外部短摘录最多 1 万字符；请只保留分析所必需的代表性片段',
  ASSET_LIBRARY_LIMIT: '创作资产库已达 500 项上限，请先删除不再使用的资产',
  ASSET_BOOK_BINDING_LIMIT: '绑定文风资产的作品数量已达安全上限，请先整理不再使用的作品绑定',
  ASSET_NOT_FOUND: '该创作资产已被删除，请刷新资产库',
  ASSET_CONFLICT: '资产库已被另一页面修改，已拒绝旧页面操作；请刷新后重试',
  ASSET_DUPLICATE: '相同样本或参考链接已存在，未重复调用模型或创建资产',
  ASSET_EXTRACTION_FAILED: '模型未返回完整的文风与故事结构，本次没有创建资产；请换一段更完整的样本重试',
  BAD_MEMORY_CANDIDATE_ID: '长期记忆候选标识无效，请重新打开本章',
  BAD_MEMORY_FACT_ID: '长期记忆事实标识无效，请重新读取记忆库',
  BAD_MEMORY_DECISION: '长期记忆操作无效，请重新打开本章',
  BAD_MEMORY_BODY_FINGERPRINT: '页面缺少候选来源正文标识，请重新打开本章',
  BAD_MEMORY_REVISION: '页面缺少长期记忆修订号，请重新打开本章',
  MEMORY_CANDIDATE_NOT_FOUND: '该记忆候选已不存在，请重新打开本章',
  MEMORY_FACT_NOT_FOUND: '该长期记忆事实已不存在，请重新读取记忆库',
  MEMORY_SOURCE_STALE: '本章正文已经变化，旧候选不能再确认；请等待重新提取',
  MEMORY_SOURCE_UNPUBLISHED: '当前是未发布修改；请先确认并锁定发布新版，再把其候选确认为长期事实',
  MEMORY_REVISION_CONFLICT: '长期记忆已被另一页面修改，请重新打开本章后确认',
  MEMORY_DECISION_CONFLICT: '该候选已被另一页面作出不同决定，请重新打开本章',
  MEMORY_CONFLICT: '已有同一主体和属性的不同事实；请核对后显式替换，系统不会自动覆盖',
  MEMORY_FACT_LIMIT: '本书长期记忆事实已达安全上限，请先整理失效或低价值事实',
  MEMORY_REJECTION_LIMIT: '本书已拒绝候选记录已达安全上限，请先整理长期记忆',
  MEMORY_RECOMPUTE_FAILED: '模型未返回完整的章摘要、人物、章末交接快照与记忆候选，本次重算没有覆盖现有派生信息',
  BAD_STAGE_SUMMARY_ID: '阶段摘要标识无效，请刷新后重试',
  BAD_STAGE_SUMMARY_TITLE: '请输入 80 字以内的阶段名称',
  BAD_STAGE_SUMMARY_RANGE: '阶段起止分部无效，请重新选择',
  BAD_STAGE_SUMMARY_TEXT: '阶段摘要不能为空',
  BAD_STAGE_SUMMARY_STATUS: '阶段摘要状态无效，请刷新后重试',
  BAD_STAGE_SUMMARY_REVISION: '页面缺少阶段摘要修订号，请刷新后重试',
  BAD_STAGE_SUMMARY_SOURCE: '阶段摘要的来源标识无效，请重新计算',
  STAGE_SUMMARY_RANGE_TOO_LARGE: '单个阶段最多覆盖 20 个连续分部，请拆分为多个阶段',
  STAGE_SUMMARY_TEXT_TOO_LARGE: '单条阶段摘要最多 4000 字，请进一步压缩',
  STAGE_SUMMARY_SOURCE_EMPTY: '选定分部还没有章摘要，暂时无法自动重算',
  STAGE_SUMMARY_LIMIT: '本书阶段摘要已达 200 条上限，请先合并或删除旧项',
  STAGE_SUMMARY_NOT_FOUND: '该阶段摘要已被删除，请刷新',
  STAGE_SUMMARY_CONFLICT: '阶段摘要已被另一页修改，本次操作未覆盖新版',
  STAGE_SUMMARY_SOURCE_STALE: '重算期间来源分部已变化，迟到结果未保存；请重新计算',
  STAGE_SUMMARY_FROZEN: '该阶段摘要已冻结，请先显式解冻再重算',
  STAGE_SUMMARY_FAILED: '模型未返回可用的阶段摘要，本次没有保存',
  BAD_PUBLICATION_ANCHOR: '页面缺少正文或记忆版本标识，请刷新后重试',
  PUBLICATION_STALE: '确认发布期间正文已变化，旧页面版本未被锁定',
  BAD_API_PROFILE: 'API 方案内容无效，请检查后重试',
  BAD_API_PROFILE_ID: 'API 方案标识无效，请刷新方案库',
  BAD_API_PROFILE_NAME: '请输入 API 方案名称',
  BAD_API_PROFILE_MODELS: '每个 API 方案需要 1–50 个有效模型名',
  BAD_API_PROFILE_MODEL: '请选择该方案中已登记的模型',
  BAD_API_PROFILES_REVISION: 'API 方案库修订信息无效，请刷新后重试',
  API_PROFILE_NOT_FOUND: '该 API 方案已不存在，请刷新方案库',
  API_PROFILE_LIMIT: 'API 方案已达 50 项上限，请先删除不用的方案',
  API_PROFILES_CONFLICT: 'API 方案库已被另一页面修改，请刷新后重试',
  BAD_MODEL_DISCOVERY_TARGET: '模型发现目标无效，请刷新设置后重试',
  LLM_MODELS_RESPONSE_INVALID: '服务已连通，但 /models 返回的不是 OpenAI 兼容模型列表',
  LLM_MODELS_RESPONSE_TOO_LARGE: '服务的模型列表异常过大，已停止读取',
  BAD_API_TASK_ROUTES: '模型分工中存在已删除的方案或模型，请刷新后重新选择',
  BAD_API_MODEL_TASK: '模型任务类型无效，请刷新后重试',
  BAD_API_BOOK_BINDING: '单书固定模型已不在方案库中，请刷新后重新选择',
  API_BOOK_BINDING_LIMIT: '单书模型绑定已达安全上限，请清理不再使用的方案配置',
};

export const readableApiError = (message: unknown): string => {
  const raw = String(message ?? '');
  if (apiErrorMessages[raw]) return apiErrorMessages[raw];
  const http = raw.match(/^LLM_HTTP_(\d{3})(?::\s*([\s\S]*))?$/);
  if (http) {
    const status = Number(http[1]);
    const detail = http[2]?.trim();
    let base;
    if (status === 400) base = '模型服务拒绝了请求，请检查模型名和接口兼容性';
    else if (status === 401) base = 'API Key 无效或已过期，请重新配置';
    else if (status === 403) base = '当前 API Key 没有调用该模型的权限';
    else if (status === 404) base = '模型或 API 地址不存在，请检查 Base URL 和模型名';
    else if (status === 408) base = '模型服务请求超时，请稍后重试';
    else if (status === 429) base = '模型服务限流或额度不足，请稍后重试并检查余额';
    else if (status >= 500) base = '模型服务暂时不可用，请稍后重试';
    else base = `模型服务返回 HTTP ${status}`;
    // 鉴权错误的服务端详情已被丢弃；其它受限详情有助于定位模型名等问题。
    return detail ? `${base}：${detail}` : base;
  }
  if (raw.startsWith('LLM_NETWORK_ERROR')) {
    const detail = raw.slice('LLM_NETWORK_ERROR'.length).replace(/^:\s*/, '');
    return `无法连接模型服务，请检查 Base URL、网络和代理${detail ? `：${detail}` : ''}`;
  }
  if (raw.startsWith('LLM_STREAM_ERROR:')) {
    const detail = raw.slice('LLM_STREAM_ERROR:'.length).trim();
    if (detail === 'LLM_SSE_INVALID_UTF8') return '模型服务返回了编码损坏的流数据，本次内容未保存';
    if (detail === 'LLM_SSE_INVALID_JSON') return '模型服务返回了无法解析的流数据，本次内容未保存';
    if (detail === 'LLM_SSE_INVALID_EVENT') return '模型服务返回了字段格式异常的流数据，本次内容未保存';
    return `模型服务中止了生成${detail ? `：${detail}` : ''}`;
  }
  if (raw.startsWith('LLM_FINISH_')) return `模型服务提前结束生成（${raw.slice('LLM_FINISH_'.length)}），本次内容未保存`;
  return raw;
};

export class ApiResponseError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
    this.code = code;
  }
}

export const isApiErrorCode = (error: unknown, code: string): boolean =>
  error instanceof ApiResponseError && error.code === code;

// 4xx 代表服务端在提交前明确拒绝。5xx/507 仍可能发生在原子 rename 已
// 替换最终文件、随后目录 fsync 失败的窗口，和网络异常、连接截断或 2xx
// JSON 损坏一样无法确认非幂等写入是否已经提交。调用方必须先刷新权威
// 状态再提示重试，避免把实际成功的创建、保存或删除误报成未执行。
export const isAmbiguousApiFailure = (error: unknown): boolean =>
  !(error instanceof ApiResponseError)
  || (error.status >= 500 && error.status < 600);

// 统一解析：非 2xx 抛错（含后端 {error} 文案），避免把 404 HTML 灌进 JSON.parse 后静默失败
const json = async (r: Response) => {
  if (!r.ok) {
    const detail = await responseErrorDetail(r);
    throw new ApiResponseError(detail.message, r.status, detail.code);
  }
  return r.json();
};

const responseErrorDetail = async (r: Response) => {
  let code: string | undefined;
  try {
    const e = await r.json();
    if (typeof e?.error === 'string' && PUBLIC_ERROR_PAYLOAD.test(e.error)) code = e.error;
  } catch { /* 非 JSON 响应 */ }
  return { code, message: readableApiError(code ?? `HTTP ${r.status}`) };
};
const responseErrorMessage = async (r: Response) => (await responseErrorDetail(r)).message;
const jpost = (p: string, b: unknown, signal?: AbortSignal) =>
  fetch(p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b), ...(signal ? { signal } : {}),
  }).then(json);
const getWithOptionalSignal = (path: string, signal?: AbortSignal) =>
  signal ? fetch(path, { signal }) : fetch(path);

const characterCraftApi = createCharacterCraftApi({ json, jpost, getWithOptionalSignal });
export const { deleteCharacterCraftEntry, getCharacterCraft,
  saveCharacterGuide, saveRelationshipGuide } = characterCraftApi;
export { createClientCharacterGuideId, createClientRelationshipGuideId,
  createClientTemperatureChangeId } from './character-craft-api';
const promiseLedgerApi = createPromiseLedgerApi({ json, jpost, getWithOptionalSignal });
export const { deletePromiseLedgerEntry, getPromiseLedger,
  savePromiseLedgerEntry } = promiseLedgerApi;
export { createClientPromiseId, createClientPromiseProgressId } from './promise-ledger-api';
const reviewApi = createReviewApi({ jpost });
export const { applyChapterReviewPromiseCandidate, applyChapterReviewWorldGateCandidate,
  generateChapterRevisionCandidate, generateChapterReviewRevisionCandidate,
  verifyChapterReviewRevisionCandidate, reviewChapter, reviewGoldenThree } = reviewApi;

export const getConfig = (signal?: AbortSignal): Promise<Config> =>
  getWithOptionalSignal('/api/config', signal).then(json);
export const saveConfig = (config: Config): Promise<Config> => {
  const { revision: expectedRevision, ...patch } = config;
  return jpost('/api/config', { ...patch, expectedRevision });
};
export const getApiProfiles = (signal?: AbortSignal): Promise<ApiProfileLibrary> =>
  getWithOptionalSignal('/api/config/profiles', signal).then(json);
export const saveApiProfile = (
  input: ApiProfileSaveInput, expectedRevision: string,
  expectedConfigRevision?: string,
): Promise<{ profile: ApiProfile; revision: string }> => jpost(
  '/api/config/profiles', { ...input, expectedRevision, expectedConfigRevision },
);
export const deleteApiProfile = (
  id: string, expectedRevision: string,
): Promise<{ ok: true; revision: string }> => fetch(
  `/api/config/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision }),
  },
).then(json);
export const activateApiProfile = (
  id: string, model: string, expectedProfilesRevision: string,
  expectedConfigRevision: string,
): Promise<{ config: Config; library: ApiProfileLibrary }> => jpost(
  `/api/config/profiles/${encodeURIComponent(id)}/activate`, {
    model, expectedProfilesRevision, expectedConfigRevision,
  },
);
export const discoverApiModels = (
  input: ApiModelDiscoveryInput,
): Promise<ApiModelDiscoveryResult> => jpost('/api/config/models', input);
export const saveApiTaskRoutes = (
  taskRoutes: ApiTaskRoutes, expectedRevision: string,
): Promise<ApiProfileLibrary> => jpost(
  '/api/config/profiles/routing', { taskRoutes, expectedRevision },
);
export const saveApiBookBinding = (
  bookId: string, binding: ApiTaskRoute | null, expectedRevision: string,
): Promise<ApiProfileLibrary> => jpost(
  `/api/config/profiles/books/${encodeURIComponent(bookId)}`,
  { binding, expectedRevision },
);

export const getWritingAssets = (signal?: AbortSignal): Promise<WritingAssetLibrary> =>
  getWithOptionalSignal('/api/writing-assets', signal).then(json);
export const extractWritingAsset = (
  input: WritingAssetExtractionInput,
): Promise<WritingAssetExtractionResult> => jpost('/api/writing-assets/extract', input);
export const createWritingAssetReference = (
  input: WritingAssetReferenceInput,
): Promise<WritingAssetExtractionResult> => jpost('/api/writing-assets/reference', input);
export const extractBookNativeWritingAsset = (
  bookId: string, sectionId: string, chapterId: string, name: string,
  signal?: AbortSignal,
): Promise<WritingAssetExtractionResult> => jpost(
  `/api/writing-assets/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}/chapters/${encodeURIComponent(chapterId)}/native`,
  { name }, signal,
);
export const saveWritingAssetBookBinding = (
  bookId: string, binding: WritingAssetBookBinding, expectedRevision: string,
  signal?: AbortSignal,
): Promise<WritingAssetBindingResult> => jpost(
  `/api/writing-assets/books/${encodeURIComponent(bookId)}`,
  { binding, expectedRevision }, signal,
);
export const deleteWritingAsset = (id: string, expectedRevision: string): Promise<{
  ok: true; revision: string;
}> => fetch(`/api/writing-assets/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expectedRevision }),
}).then(json);

export const listBooks = (signal?: AbortSignal): Promise<BookSummary[]> =>
  getWithOptionalSignal('/api/books', signal).then(json);
export const getStorageDiagnostics = (
  deep = false, signal?: AbortSignal,
): Promise<StorageDiagnostics> =>
  getWithOptionalSignal(`/api/storage/diagnostics${deep ? '?deep=1' : ''}`, signal).then(json);
export const createClientBookId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `book_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
export const createBook = (
  premise: string,
  title?: string,
  requestedBookId = createClientBookId(),
): Promise<Book> => jpost('/api/books', { premise, title, requestedBookId });
export const getTree = (bookId: string, signal?: AbortSignal): Promise<BookTree> =>
  getWithOptionalSignal(`/api/books/${bookId}/tree`, signal).then(json);
export const saveSerializationSettings = (
  bookId: string, dailyWordGoal: number, expectedRevision: string,
): Promise<import('./types').SerializationSettings> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/serialization/settings`,
  { dailyWordGoal, expectedRevision },
);
export const savePlatformConfirmation = (
  bookId: string, input: PlatformConfirmationInput, expectedRevision: string,
): Promise<SerializationSettings> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/platform-confirmations`,
  { ...input, expectedRevision },
);
export const deletePlatformConfirmation = (
  bookId: string, confirmationId: string, expectedRevision: string,
): Promise<SerializationSettings> => fetch(
  `/api/books/${encodeURIComponent(bookId)}/platform-confirmations/`
    + encodeURIComponent(confirmationId),
  {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision }),
  },
).then(json);
export const getChapter = (
  bookId: string,
  sectionId: string,
  chapterId: string,
  signal?: AbortSignal,
): Promise<Chapter> => getWithOptionalSignal(
  `/api/books/${bookId}/sections/${sectionId}/chapters/${chapterId}`,
  signal,
).then(json);
export const saveChapterPlan = (
  bookId: string,
  sectionId: string,
  chapterId: string,
  plan: ChapterPlanInput,
  expectedRevision: string,
): Promise<ChapterPlan> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
    + `/chapters/${encodeURIComponent(chapterId)}/plan`,
  { plan, expectedRevision },
);
export const generateChapterPlanDraft = (
  bookId: string,
  sectionId: string,
  chapterId: string,
  seedPlan: ChapterPlanInput,
  expectedPlanRevision: string,
  signal?: AbortSignal,
): Promise<ChapterPlanDraftResult> => jpost(
  '/api/gen/chapter-plan-draft',
  { bookId, sectionId, chapterId, seedPlan, expectedPlanRevision },
  signal,
);
export const saveStoryEngine = (
  bookId: string,
  storyEngine: StoryEngineInput,
  expectedRevision: string,
): Promise<StoryEngine> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/story-engine`,
  { storyEngine, expectedRevision },
);
export const decideMemoryCandidate = (
  bookId: string,
  sectionId: string,
  chapterId: string,
  candidateId: string,
  action: MemoryDecisionAction,
  expectedBodyFingerprint: string,
  expectedMemoryRevision: string,
): Promise<MemoryDecisionResult> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
    + `/chapters/${encodeURIComponent(chapterId)}/memory-candidates/`
    + `${encodeURIComponent(candidateId)}/decision`,
  { action, expectedBodyFingerprint, expectedMemoryRevision },
);
export const publishChapter = (
  bookId: string,
  sectionId: string,
  chapterId: string,
  expectedBodyFingerprint: string,
  expectedMemoryRevision: string,
): Promise<ChapterPublicationResult> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
    + `/chapters/${encodeURIComponent(chapterId)}/publish`,
  { expectedBodyFingerprint, expectedMemoryRevision },
);
export const getChapterPublicationPreflight = (
  bookId: string,
  sectionId: string,
  chapterId: string,
  expectedBodyFingerprint: string,
  signal?: AbortSignal,
): Promise<ChapterPublicationPreflight> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
    + `/chapters/${encodeURIComponent(chapterId)}/publication/preflight`,
  { expectedBodyFingerprint }, signal,
);
export const recomputeChapterMemory = (
  bookId: string,
  sectionId: string,
  chapterId: string,
  expectedBodyFingerprint: string,
): Promise<{
  bodyFingerprint: string;
  memoryCandidates: import('./types').MemoryCandidate[];
  memoryRevision: string;
}> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
    + `/chapters/${encodeURIComponent(chapterId)}/memory/recompute`,
  { expectedBodyFingerprint },
);
export const getBookMemory = (
  bookId: string, signal?: AbortSignal,
): Promise<BookMemoryLibrary> => getWithOptionalSignal(
  `/api/books/${encodeURIComponent(bookId)}/memory`, signal,
).then(json);
export const deactivateMemoryFact = (
  bookId: string, factId: string, expectedMemoryRevision: string,
): Promise<MemoryFactMutationResult> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/memory-facts/`
    + `${encodeURIComponent(factId)}/deactivate`,
  { expectedMemoryRevision },
);
export const saveStageSummary = (
  bookId: string, input: StageSummaryInput, expectedStageSummaryRevision: string,
): Promise<StageSummaryMutationResult> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/stage-summaries/save`,
  { ...input, expectedStageSummaryRevision },
);
export const recomputeStageSummary = (
  bookId: string, input: StageSummaryInput, expectedStageSummaryRevision: string,
): Promise<StageSummaryMutationResult> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/stage-summaries/recompute`,
  { ...input, expectedStageSummaryRevision },
);
export const deleteStageSummary = (
  bookId: string, stageSummaryId: string, expectedStageSummaryRevision: string,
): Promise<StageSummaryMutationResult> => jpost(
  `/api/books/${encodeURIComponent(bookId)}/stage-summaries/`
    + `${encodeURIComponent(stageSummaryId)}/delete`,
  { expectedStageSummaryRevision },
);
export const addSection = (
  bookId: string,
  title: string | undefined,
  titleSource: TitleSource | undefined,
  expectedLastSectionId: string | null,
  outline?: string,
): Promise<Section> => jpost(`/api/books/${bookId}/sections`, {
  title, titleSource, expectedLastSectionId, outline,
});
export const addChapter = (
  bookId: string,
  sid: string,
  title: string | undefined,
  expectedLastChapterId: string | null,
): Promise<Chapter> => jpost(`/api/books/${bookId}/sections/${sid}/chapters`, {
  title, expectedLastChapterId,
});

// 书架管理
export const deleteBook = (bookId: string, expectedUpdatedAt: string) => fetch(
  `/api/books/${bookId}`,
  {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt }),
  },
).then(json);
export const listDeletedBooks = (signal?: AbortSignal): Promise<DeletedBook[]> =>
  getWithOptionalSignal('/api/trash/books', signal).then(json);
export const restoreDeletedBook = (trashId: string): Promise<Book> =>
  jpost(`/api/trash/books/${trashId}/restore`, {});
export const downloadBookBackup = async (
  bookId: string,
  documentRef: Document = document,
): Promise<void> => {
  // 先让服务端完整生成并校验备份，只取一个很小的下载令牌；随后仍交给浏览器
  // 直接流式下载，避免把最大 100 MB 响应整份复制成 JS Blob。
  const prepared = await jpost(`/api/books/${encodeURIComponent(bookId)}/backup/prepare`, {});
  const downloadUrl = prepared?.downloadUrl;
  if (typeof downloadUrl !== 'string'
    || !/^\/api\/backups\/download\/[0-9a-f-]{36}$/i.test(downloadUrl)) {
    throw new Error('备份服务返回了无效下载链接');
  }
  const link = documentRef.createElement('a');
  link.href = downloadUrl;
  link.download = `${bookId}.novelbox.json`;
  link.hidden = true;
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
};
export interface ManuscriptExportResult {
  source: 'current' | 'published';
  totalChapterCount: number;
  exportedChapterCount: number;
  skippedChapterCount: number;
}
export const downloadBookManuscript = async (
  bookId: string,
  source: 'current' | 'published' = 'current',
  documentRef: Document = document,
): Promise<ManuscriptExportResult> => {
  const prepared = await jpost(
    `/api/books/${encodeURIComponent(bookId)}/manuscript/prepare`, { source },
  );
  const downloadUrl = prepared?.downloadUrl;
  if (typeof downloadUrl !== 'string'
    || !/^\/api\/backups\/download\/[0-9a-f-]{36}$/i.test(downloadUrl)) {
    throw new Error('发布稿服务返回了无效下载链接');
  }
  if (prepared.source !== source
    || !Number.isSafeInteger(prepared.totalChapterCount)
    || !Number.isSafeInteger(prepared.exportedChapterCount)
    || !Number.isSafeInteger(prepared.skippedChapterCount)) {
    throw new Error('发布稿服务返回了无效导出统计');
  }
  const link = documentRef.createElement('a');
  link.href = downloadUrl;
  link.download = `${bookId}.${source}.txt`;
  link.hidden = true;
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  return {
    source: prepared.source,
    totalChapterCount: prepared.totalChapterCount,
    exportedChapterCount: prepared.exportedChapterCount,
    skippedChapterCount: prepared.skippedChapterCount,
  };
};
export const MAX_BACKUP_UPLOAD_BYTES = 100 * 1024 * 1024;
export const importBookBackup = (
  file: Blob,
  requestedBookId = createClientBookId(),
): Promise<Book> => {
  // 服务端仍是权威边界；这里只避免已知不可能成功的
  // 大文件占用上传槽，并让界面误进入结果核对流程。
  if (file.size === 0 || file.size > MAX_BACKUP_UPLOAD_BYTES) {
    const code = file.size === 0 ? 'BACKUP_INVALID' : 'BACKUP_TOO_LARGE';
    return Promise.reject(new ApiResponseError(
      readableApiError(code),
      file.size === 0 ? 400 : 413,
      code,
    ));
  }
  return fetch('/api/backups/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Novelbox-Book-Id': requestedBookId,
    },
    body: file,
  }).then(json);
};
export const renameBook = (bookId: string, title: string, expectedTitle: string) =>
  fetch(`/api/books/${bookId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, expectedTitle }),
  }).then(json);

// 统一版本操作
export const versionMove = (
  bookId: string, path: string, delta: number, expectedRevision: string,
) => jpost(`/api/books/${bookId}/version/move`, { path, delta, expectedRevision });
export const versionClear = (bookId: string, path: string, expectedRevision: string) =>
  jpost(`/api/books/${bookId}/version/clear`, { path, expectedRevision });
export const versionSave = (
  bookId: string, path: string, text: string, expectedRevision: string,
) => jpost(`/api/books/${bookId}/version/save`, { path, text, expectedRevision });
export const rewriteUrl = (bookId: string) => `/api/books/${bookId}/version/rewrite`;

type MaybePromise<T = unknown> = T | Promise<T>;

export interface StreamGenHandle {
  abort: () => void;
  // 在 fetch、响应体取消和所有事件回调都结束后才完成。停止操作必须等待
  // 该信号再读盘，避免刷新抢在服务端提交边界之前。
  settled: Promise<void>;
}

export function streamGen(
  path: string, body: unknown,
  cb: {
    onDelta?: (d: string) => MaybePromise;
    onSaved?: (e: SSEEvent) => MaybePromise;
    onDone?: (e: SSEEvent) => MaybePromise;
    onError?: (m: string) => MaybePromise;
  }
): StreamGenHandle {
  const ctrl = new AbortController();
  const notifyError = async (message: string) => {
    // 这是无返回 Promise 的流式任务最终错误边界。若 UI 已卸载或
    // 提示回调自身失败，不能再次调用 onError 或制造未处理拒绝。
    try { await cb.onError?.(message); } catch { /* 错误回调不再递归上报 */ }
  };
  const running = (async () => {
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res));
      if (!res.body) throw new Error('无响应流');
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8', { fatal: true });
      const decode = (value?: Uint8Array, options?: TextDecodeOptions) => {
        try { return dec.decode(value, options); }
        catch { throw new Error(SSE_RESPONSE_INVALID_UTF8); }
      };
      let buf = '';
      let terminal = false;
      let deltaChars = 0;
      let receivedBytes = 0;
      let reachedEof = false;
      const dispatch = async (events: SSEEvent[]) => {
        for (const e of events) {
          if (terminal || ctrl.signal.aborted) break;
          if (e.delta !== undefined) {
            deltaChars += e.delta.length;
            if (deltaChars > MAX_STREAM_DELTA_CHARS) throw new Error(SSE_RESPONSE_TOO_LARGE);
            await cb.onDelta?.(e.delta);
          }
          if (e.saved) await cb.onSaved?.(e);
          if (e.error) {
            terminal = true;
            await notifyError(readableApiError(e.error));
            break;
          }
          if (e.done) {
            terminal = true;
            await cb.onDone?.(e);
            break;
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            reachedEof = true;
            break;
          }
          receivedBytes += value.byteLength;
          if (receivedBytes > MAX_SSE_STREAM_BYTES) throw new Error(SSE_RESPONSE_TOO_LARGE);
          const { events, rest } = parseSSELines(decode(value, { stream: true }), buf);
          buf = rest;
          await dispatch(events);
          if (terminal || ctrl.signal.aborted) return;
        }
        buf += decode();
        if (buf.trim()) {
          const { events } = parseSSELines('\n\n', buf);
          await dispatch(events);
        }
        if (!terminal && !ctrl.signal.aborted) await notifyError('生成中断：响应未完成');
      } finally {
        // 终止帧、本地解析/回调错误和用户取消都可能在响应体 EOF 前退出。
        // 主动取消未读部分并始终释放 reader 锁，不依赖浏览器稍后 GC。
        if (!reachedEof) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (err) {
      // fetch/ReadableStream 在不同浏览器中可能以 AbortError、TypeError 或
      // 实现自有错误表示主动取消；控制器状态才是可靠的用户意图边界。
      if (!ctrl.signal.aborted && (err as Error).name !== 'AbortError') {
        // 本地事件回调或解析流程失败后也要主动关闭请求。否则浏览器已经
        // 放弃消费响应，但服务端仍可能继续生成并在后台落盘。
        ctrl.abort();
        await notifyError(String((err as Error).message || err));
      }
    }
  })();
  void running.catch(() => {});
  return {
    abort: () => ctrl.abort(),
    settled: running,
  };
}
