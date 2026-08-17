# 前端源码索引

- `main.tsx`：React 启动入口。
- `App.tsx`：顶层视图、状态组合和控制器编排。
- `app-workflows.ts`：可独立测试的加载、冲突恢复、生成收尾和批量采纳流程。
- `api.ts`：组件唯一使用的 API 门面。
- `api-sse.ts` / `api-contract.ts`：底层 SSE 解析和共享错误合同。
- `promise-ledger-api.ts` / `character-craft-api.ts` / `review-api.ts`：由 API 门面注入传输函数的书级创作领域端点。
- `asyncAction.ts`：互斥异步动作和最新请求所有权。
- `store.ts` / `versioned.ts` / `sections.ts` / `titles.ts`：纯状态与领域工具。
- `types.ts`：前端数据合同。
- `theme.ts` / `toast.ts` / `memoryDetails.ts`：展示辅助。
- `styles.css`：全局设计样式。
- [组件索引](./components/README.md)

组件不能直接导入 `api-sse.ts` 或 `api-contract.ts`。跨页面异步协调不要继续堆入 `App.tsx`；优先放进可测试工作流或专用 hook。
