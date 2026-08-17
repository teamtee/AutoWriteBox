# 服务端索引

服务端采用“路由 → store 门面 → 领域模块”的单向结构。

## 入口与公共基础

- `index.js`：Express 装配、生命周期和静态资源。
- `launcher-preflight.js`：依赖、构建产物和运行环境预检。
- `store.js`：存储公共门面与领域模块组装，不承载新的大块领域实现。
- `llm.js` / `llm-config.js`：OpenAI 兼容请求和任务模型选择；配置规范化同时携带当前模型的
  `modelContextChars`，旧配置缺失时回退 500,000。
- `prompts.js` 遵循 context-not-control：只有连续性与知识边界（写错即为错误）以硬约束表述，
  其余关于“怎么写才好看”的内容作为判断依据和原因提供，并显式允许模型按本章需要取舍。
  `CHAPTER_CONTINUITY_CONSTRAINTS` 与 `CHAPTER_CRAFT_CONTEXT` 分别承担这两类。
- `prompts.js` / `generation-context.js` / `golden-three-review-prompt.js` / `chapter-revision-prompt.js`：在线任务指令与有界上下文；长期记忆先按当前策划/正文的任务直接命中召回，再按近期上下文、重要度和新近度排序。
- `context-budget.js`：单次调用的分层预算分配。各字段上限之和已超过模型输入硬上限，
  因此按 priority 发放保底再补到实际需求；没写的层不占额度，被裁剪的层必须显式标注。
  总额取当前任务实际选中模型的登记窗口与本地 500,000 硬上限中的较小值；0 额度严格表示不发送，不能回退字段默认窗口。
  它只计算额度，不拥有具体窗口算法；真正的裁剪仍在 `generation-context.js`。
- `generation-memory-context.js`：长期记忆事实格式化、任务/近期相关性排序、字符预算选择与诊断计数。
  任务直接相关事实独立优先装填，过长时保留主体/谓词/来源的有界首尾；主体及别名至少两字符才参与命中，
  省略行列出总数和仍未装入的任务相关数。
- `chapter-context-manifest.js`：复用在线裁剪选择器生成不含原文的章节上下文体检元数据与缺失风险，
  并返回各预算层的需求、实发、保底、优先级和总额余额；前端不得另算一套。
- `chapter-handoff-schema.js`：规范化摘要 API 从正文末态提取的跨章场景交接快照；它是连续性定位器，不是高于正文和作者确认事实的新真相层。
- `chapter-rhythm.js`：格式化成稿节奏指纹与写前节奏意图，并确定性识别连续同构与五章内单一手法支配风险；只提示有证据的变奏需求，不机械轮换剧情。
- `world-bible.js` / `style-bible.js`：世界十二栏、文风十栏圣经合同，最低完整度诊断、执行边界与 API 结果落盘门槛；世界圣经额外区分作者后台真相和读者/人物当前已知。
- `chapter-plan-quality.js`：章节张力、伏笔和世界展开的版本化标签合同、空泛/示例/乱序诊断，以及正文与精修共用的执行边界；v2 增加世界展开前认知，并允许用“无埋点理由—本章聚焦—既有未知处理”明确选择不硬造谜团，v1 与无版本旧策划继续兼容。
- `chapter-output-guard.js`：正文与返修候选的确定性后台信息泄漏门禁，拒绝债务 ID、策划合同标签和审稿 JSON 字段进入小说。
- `chapter-prose-metrics.js`：正文体量与质感的确定性度量、经验参考值和跨章退化雷达。它只读已保存正文，不调用模型；参考值用于生成观察语句，不用于拒绝正文——某一章本来就该短、该快时低于它是正常的。
- `api-editorial-loop.js`：离线正文 API 闭环的确定性门槛、严格审稿结构、多轮候选选优与生成/审稿/返修指令；下一轮只从当前最优 API 候选继续，文件写入和命令参数留在 `scripts/`。
- `chapter-review-revision-prompt.js`：把当前有效审稿的正文风险与未落地策划转为受事实保护的 API 精修候选指令，并生成整份审稿内容指纹。
- `bounded-io.js` / `json-stream.js` / `backup-json.js`：有界流式 I/O。
- `client-abort.js` / `http-error.js` / `http-json.js` / `request-security.js`：HTTP 公共边界。
- `limits.js`：统一大小、数量、时间和并发限制。
- `prompt-join.js`：所有提示词装配共用的有界拼接。它是模型输入硬上限的最后一道防线，
  不承担分层裁剪；各层预算分配见
  [上下文组织审视与修正计划](../docs/上下文组织审视与修正计划.md)。
- `substring-index.js`：与小说业务无关的精确子串索引。

## 领域 schema

`api-profile-schema.js`、`chapter-plan-schema.js`、`chapter-plan-review-schema.js`、`chapter-review-schema.js`、`chapter-revision-schema.js`、`golden-three-review-schema.js`、`story-engine-schema.js`、`promise-ledger-schema.js`、`character-craft-schema.js`、`memory-schema.js`、
`platform-governance-schema.js`、`stage-summary-schema.js` 和
`writing-asset-schema.js` 只负责数据合同、规范化和边界，不执行文件事务。

更细入口：

- [存储领域模块](./store/README.md)
- [HTTP 路由](./routes/README.md)
- [服务端测试](./test/README.md)
- [项目总架构](../ARCHITECTURE.md)
