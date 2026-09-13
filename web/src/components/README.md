# 前端组件索引

## 应用框架

- `TopBar`、`Sidebar`、`MainPanel`：书内工作区骨架。
- `Bookshelf`、`FirstRun`、`SettingsPage`：书架、创建和设置页面。
- `LoadingState`、`Toast`：全局反馈。

## 写作工作流

- `VersionedBox`、`Actions`：版本编辑、保存、重写与抽打。
- `StoryEngineCard`：作品级读者期待、主角行动、阶段收益、代价与升级循环。
- `WorldBibleDiagnosticsCard`：检查已保存世界观的十二栏世界圣经结构、长度与薄弱项，并说明 API 重构落盘门槛。
- `StyleBibleDiagnosticsCard`：检查已保存文风的十栏执行结构、稳定锚点与薄弱项，并说明 API 重构落盘门槛。
- `PromiseLedgerCard`：作品级读者承诺、推进、兑现窗口与多页面冲突恢复；API 正文证据节拍只读展示，不允许表单伪造或改写。
- `CharacterCraftCard`：当前人物驱动力、声音边界、关系温度与按章变化原因。
- `AiPageFillBar`、`CoreAiFillBar`：大纲页和核心设定页的 AI 填充入口；核心循环、人物、关系和计划承诺均由 AI 直接写入并自动保存，人工修改也会防抖保存，不需要的条目可删除；核心页还可点空白的世界/文风/禁忌/节奏框做流式填充。
- `ChapterContinuityCard`：正文下方展示章名、摘要、人物快照和章末交接。
- `ChapterPlanCard`：空章默认收起表单，只保留 AI 一键填充；有草稿或已保存策划后再展开节奏、章级栏和场景链。
- `ChapterContextManifestCard`：按事实、计划、阅读债务和表达四层体检当前已保存状态可供 API 装配的上下文数量、裁剪状态与缺失风险，不泄露原文或秘密。
- `SectionPlanPanel`：AI 分部规划和采纳，同时展示逐部的世界层级、证据、人物行动、选择代价、保留未知与进入门槛。
- `ChapterReviewCard`、`ChapterReviewPromiseCandidatesCard`、`ChapterReviewWorldGateCard`、`GoldenThreeReviewCard`、`ChapterRevisionPipelineCard`、`ChapterReviewRevisionCard`、`ChapterPublicationCard`：单章审稿、伏笔节拍及正文证据人工确认、正文证据世界门槛人工确认、策划—成稿逐项差异/定向修复、黄金三章总检、分项修订候选、审稿证据驱动的 API 精修候选和发布锁。
- `SerializationPanel`、`PlatformGovernancePanel`：连载与平台人工核对。

## 长期资产

- `MemoryCandidateCard`、`MemoryLibraryPanel`、`MemoryRecomputeCard`、`StageSummaryPanel`：长期记忆与阶段摘要。
- `WritingAssetPanel`、`ChapterAssetSceneSelector`：文风/结构资产与章节场景。
- `ApiProfilePanel`、`BookModelBindingPanel`：多 API、多模型和单书固定模型。
- `LlmUsagePanel`：设置页展示本次服务的调用次数、输入输出字符、本地估算 token、供应商主动返回的 usage token、耗时、失败和最近任务；可按“服务地址 + 模型”在浏览器本地登记 USD/CNY 输入输出单价并估算本次费用。

测试与组件同目录同名放置。组件超过建议线时，优先抽出纯计算、局部表单或子卡片。
