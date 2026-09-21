# Feature Evaluation Lab

共享分群（segment）依赖图与特性开关（flag）评估工作台。

## 缓存一致性设计

- **内容身份（content identity）**：编译阶段对分群依赖图做 DFS，计算每个分群的
  依赖闭包（含自身），将闭包内所有 `segmentId@revision` 排序后经 FNV-1a 哈希得到
  身份值。嵌套分群任意一层 revision 变化都会改变身份。
- **缓存键**：`userId:closureIdentity:attrsVersion`，覆盖整个依赖闭包 revision 与
  用户属性版本；上游分群更新、用户属性变化自然落到新键。
- **精确失效**：更新分群时按旧图求传递反向依赖（受影响后代），只删除这些闭包身份
  对应的缓存条目；无关分群/用户的缓存原样保留。
- **发布守卫**：首次计算在开始前快照闭包规则、身份与 graphRevision；计算完成后若图
  已换代，结果标记为 `stale` 交付给等待者但不写入缓存，旧闭包结果不会发布到新 revision。
- **编译期拒绝循环**：三色 DFS 检测环、校验上游存在性；编译失败时旧图与缓存继续有效。
- **并发单飞**：同键并发首次计算合并为一次；每个调用方有独立 AbortSignal，单个调用方
  取消只 reject 自己的等待，不取消共享计算，也不影响其他等待者。
- **LRU 淘汰**：超容量淘汰最久未使用条目，命中会续期。

评估响应中的 `cacheVersion` 即命中的闭包内容身份，工作台检查面板会展示它以及当前
缓存条目。

## 接口

- `GET /api/segments` 分群、闭包与内容身份
- `PUT /api/segments/:id` 更新规则（body 需带 `revision`；循环/悬空引用返回 400）
- `GET /api/evaluate?flagId=|segmentId=&userId=` 命中评估，返回 `match/source/cacheVersion`
- `GET /api/cache` 缓存统计与条目
- `PUT /api/users/:id` 更新用户属性（需带 `attrsVersion`）

Run `npm install`, then `npm run dev`（服务端 4174，前端 4173）。`npm test` 运行测试。
