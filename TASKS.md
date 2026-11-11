# TASKS — 七天排期

规则：**一天一个可交付**。当天交付不达标就走降级，不许把两天的活并成一天补。
范围和验收标准在 `TODO.md`，这里只排期。

起点：2026-11-11　目标出包：2026-11-17（D7）

---

## D1（11-11）ingest：能解压、能归一化

- [x] `pnpm init` + TS 工程骨架（`tsconfig.json`、`tsconfig.check.json`、`src/`、`test/`、`justfile`）
- [x] `src/ingest/read.ts`：zstd 流式解码 + JSONL 逐行解析，坏行计数不抛
- [x] `src/model/tape.ts`：tape 类型（session / turn / step / tool-call / message / context）
- [x] `src/model/normalize.ts`：raw 事件 → tape，唯一的归一化入口
- [x] `src/cli/main.ts`：`dsh-trace ingest <path> [--json]`，默认打 turn/tool/token 表
- [x] 单测：13 个用例，覆盖 v0/v4 两种形状、坏行、无 header、usage 不重复计数

**完成标准**：在本机 3 份真实会话（含 1 份老的 `session.jsonl.zstd`）上跑通，打出的 turn 数与 `turn/start` 事件数一致。

---

## D2（11-12）归因：token 花在哪

- [ ] `src/report/attribute.ts`：把每 turn 的 token 分到 system prompt / 指令文件 / skills / 历史 / 工具结果
- [ ] 工具结果按 tool 名聚合，统计重复读取（同一路径被读多次）
- [ ] `dsh-trace report <path>`：文本报告 + `--json`
- [ ] 单测：构造 tape 验证分类不重不漏（各类之和 = 总量 ± 残差）

**完成标准**：报告能回答"这轮花了多少、最大一项占多少"，且和人工核对 3 个 turn 一致。

---

## D3（11-13）回放：只读工具对账

- [ ] `src/replay/classify.ts`：工具幂等性分类表（read/glob/grep = replayable，其余 = not）
- [ ] `src/replay/verify.ts`：重放读类工具，比较记录结果与当前文件系统
- [ ] divergence 原因分类：文件已改 / 文件已删 / 路径不存在 / 结果被截断
- [ ] `dsh-trace replay --verify <path>`

**完成标准**：在 ≥3 份真实会话上给出判定；不一致项带原因类别。  
**砍线**：今晚跑不通就砍掉 replay，D4 直接做 diff，故事降级为 "trace + diff"。

---

## D4（11-14）diff：两次运行哪里分叉

- [ ] `src/report/diff.ts`：按 工具名+参数 hash 对齐两个 tape
- [ ] 输出第一个分叉点、分叉前后的调用序列差异
- [ ] `dsh-trace diff <a> <b>`
- [ ] 定 `--json` 输出形态（TODO 待定项）

**完成标准**：用同一任务跑两次的会话对能正确指出分叉位置。

---

## D5（11-15）可视化：自包含 HTML

- [ ] `src/report/html.ts`：单文件 HTML，内联 CSS/JS，无外链
- [ ] 视图：turn 时间轴 + token 归因条 + 工具调用瀑布 + divergence 标记
- [ ] 截图素材：一份真实会话的报告（脱敏后）

**完成标准**：断网能打开，一张截图能让人看懂发生了什么。

---

## D6（11-16）发布 + 全量测量

- [ ] `package.json`：`engines.node >= 24`、bin、files、license
- [ ] README 补：性能数字（hyperfine）、兼容矩阵、限制说明
- [ ] 全量 382 份跑一遍，产出**那个数字**（重复读取占比 / compaction 丢弃率 / 重复命令率，选最反直觉的）
- [ ] `npm publish`（`dsh-trace`）
- [ ] git tag `v0.1.0`

**完成标准**：`npm i -g dsh-trace` 能在干净环境跑通；那个数字有出处、可复现。

---

## D7（11-17）文章 + 分发

- [ ] 写文章：问题 → 方法 → 数字 → 工具（诚实写局限）
- [ ] 发 X 帖 + 提交 `dsh-plugin-shop` / awesome feed
- [ ] 回填 `TODO.md` 简历交付物三条
- [ ] 复盘：哪一天超时、下次砍什么

**完成标准**：文章有链接、有数字、能被非 DSH 用户读懂。

---

## 每日记录

> 一天结束填一行：做完什么、卡在哪、是否触发降级。

- D1：完成。全量 383 份跑通（0 失败、0 坏行、289,334 事件、3.4s、RSS 236MB）；v0/v3/v4 抽样 turn 数与 `turn/start` 全部一致（72/72、3/3、0/0）。最大单份 7,572 事件 291ms。发现两套 schema 差异：v4 的 usage 在 `assistant/message.data.usage`、tool 结果文本直接挂在 content item 上、header 不含 system prompt（改由 `request/context` 给 provider/model/contextWindow）。
- D2：
- D3：
- D4：
- D5：
- D6：
- D7：
