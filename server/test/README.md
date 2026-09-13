# 服务端测试索引

测试按风险域组织，文件名应表达被保护的合同。

- 存储基础：`store.test.js`、`store-durability.test.js`、`store-tree.test.js`。
- 版本与回收站：`store-versioned-io.test.js`。
- 上下文、世界/文风圣经、策划、承诺、人物导演、审稿与记忆：`store-context-memory.test.js`、`chapter-context-manifest.test.js`、`world-bible.test.js`、`style-bible.test.js`、`chapter-plan-quality.test.js`、`chapter-plan.test.js`、`chapter-plan-review.test.js`、`chapter-plan-review-http.test.js`、`chapter-plan-draft.test.js`、`chapter-plan-generation-gate.test.js`、`chapter-revision.test.js`、`chapter-review-revision.test.js`、`api-editorial-loop.test.js`、`golden-three-review.test.js`、`golden-three-review-http.test.js`、`promise-ledger.test.js`、`character-craft.test.js`、`memory.test.js`、`publication.test.js`、`summaries.test.js`。
- 生成路由：`gen.test.js` 保护生成并发和 SSE；`gen-chapter-and-sections.test.js` 保护章节模式、标题、digest、审稿和分部规划；`ai-fill.test.js` 保护核心循环/人物/承诺草稿提取与不写盘。
- 备份：`backup.test.js` 保护存储与传输原语；`backup-http.test.js` 保护完整 HTTP 往返。
- 启动与安全：`launcher*.test.js`、`lifecycle.test.js`、`request-security.test.js`、`instance-lock.test.js`。
- 架构：`architecture.test.js` 执行行数硬门禁和依赖方向检查。
- 上下文预算与提示词排布：`context-budget.test.js` 守住模型窗口、零额度降级、实际装配迭代收紧与满配不越界；`prompt-layout.test.js` 守住块序快照。当前已知预算缺陷必须直接写成失败断言或回归测试，不使用长期 `todo` 掩盖；计划见 [上下文组织审视与修正计划](../../docs/上下文组织审视与修正计划.md)。

共享临时目录只通过 `test-temp-dir.js` 创建并由钩子清理。新增测试若让文件超过 1500 行，应按上述领域继续拆分，不能提高预算。
