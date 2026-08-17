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
- `ChapterPlanCard`：生成前章级意图及有序场景链（承接触发、欲望、阻碍、行动、转折、代价）的本地草稿、AI 候选对比采纳、上章未决项人工承接、阅读债务动作锚点、“本章无埋点任务”显式分支、排序和保存交互。
- `ChapterContextManifestCard`：按事实、计划、阅读债务和表达四层体检当前已保存状态可供 API 装配的上下文数量、裁剪状态与缺失风险，不泄露原文或秘密。
- `SectionPlanPanel`：AI 分部规划和采纳，同时展示逐部的世界层级、证据、人物行动、选择代价、保留未知与进入门槛。
- `ChapterReviewCard`、`ChapterReviewPromiseCandidatesCard`、`ChapterReviewWorldGateCard`、`GoldenThreeReviewCard`、`ChapterRevisionPipelineCard`、`ChapterReviewRevisionCard`、`ChapterPublicationCard`：单章审稿、伏笔节拍及正文证据人工确认、正文证据世界门槛人工确认、策划—成稿逐项差异/定向修复、黄金三章总检、分项修订候选、审稿证据驱动的 API 精修候选和发布锁。
- `SerializationPanel`、`PlatformGovernancePanel`：连载与平台人工核对。

## 长期资产

- `MemoryCandidateCard`、`MemoryLibraryPanel`、`MemoryRecomputeCard`、`StageSummaryPanel`：长期记忆与阶段摘要。
- `WritingAssetPanel`、`ChapterAssetSceneSelector`：文风/结构资产与章节场景。
- `ApiProfilePanel`、`BookModelBindingPanel`：多 API、多模型和单书固定模型。

测试与组件同目录同名放置。组件超过建议线时，优先抽出纯计算、局部表单或子卡片。
