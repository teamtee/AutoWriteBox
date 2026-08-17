# 存储模块索引

`server/store.js` 是兼容门面。路由不得绕过它；本目录模块不得反向导入它。

| 模块 | 单一职责 |
| --- | --- |
| `context.js` | 向独立领域提供动态数据根和公共依赖 |
| `io.js` / `json-writer.js` | 安全路径、有界读取、原子 JSON 写入和目录同步 |
| `concurrency.js` / `abort.js` | 锁、读取槽、受控并发和取消 |
| `instance-lock.js` | 数据根单实例租约与进程身份 |
| `versioned.js` | 版本链、游标、修订号和内容指纹 |
| `structure.js` / `structure-constants.js` | 部章引用、结构事务、恢复和作品树 |
| `backup-schema.js` / `backups.js` | 单书备份规范化、导入、导出和稿件导出 |
| `trash.js` | 删除、回收站列表和原子恢复 |
| `inspection.js` / `diagnostics.js` | 只读存储检查与结构化诊断 |
| `memory.js` | 摘要、剧情路标、阶段摘要与长期记忆事务 |
| `chapter-workflows.js` | 发布、审稿、生成上下文和版本提交 |
| `config.js` / `api-profiles.js` | 当前连接、多 API/模型方案和任务路由 |
| `writing-assets.js` | 创作资产、绑定和提示词投影 |
| `promise-ledger.js` | 读者承诺账本条目事务与乐观并发 |
| `character-craft.js` | 人物导演卡、关系温度变化与作品级乐观并发 |
| `golden-three-review.js` | 全书前三章联合上下文、版本锚点与总检持久化 |

新增模块应通过工厂显式接收依赖，保持测试可替换性；跨文件提交边界必须先有失败恢复测试。
