# TODO — 意图、范围、验收

进度和排期在 `TASKS.md`。这份只回答三个问题：为什么做、做到什么算完、哪些明确不做。

## 一句话

把一次 agent 会话，从"写完就没人再读的日志"变成"可以提问的证据"。

## 为什么是这件事

四条判断依据，都是量出来的，不是感觉：

1. **空白是真空的。** 插件目录里 26,351 个包，`tool` 类占 40%（10,553 个），而 "replay" 关键词命中的 62 个、抽查下来全是撞词（OAuth、compaction、fork guard），没有一个是真做会话回放的。
2. **证据一直在，只是没人读。** 本机 383 份会话日志、压缩后 137MB；单份最大 7,572 个事件，其中约一半是流式 `reasoning-chunks`。信息密度极高，读取工具为零。
3. **上游跑得比工具快。** 42 个版本 / 87 天，任何贴宿主的插件都要跟着改。离线读文件不跟，所以上游砸不到它——这不是实现细节，这是护城河。
4. **简历需要的是"外人能懂 + 有数字 + 有深度"**，不是"生态贡献"。回放、归因、diff 三件都满足。

## 三个产出（缺一不算完成）

1. 一个能 `npm i` 的 CLI：`dsh-trace`
2. 一份自包含的 HTML 报告：可分享、可截图、无外部资源
3. 一个反直觉的测量结论：数字 + 方法，能在文章里当标题

## 验收标准

| # | 标准 | 怎么验 |
| --- | --- | --- |
| A1 | ingest 支持 v4 与老式 `session.jsonl.zstd` | 各挑 3 份跑通；坏行跳过并计数，不崩 |
| A2 | 单份 4,385 事件的会话 < 2s 完成 | `hyperfine` 记录，写进 README |
| A3 | 报告回答"多少是重发、多少是新内容、新内容归到谁" | 守恒式 `first + carried + fresh == prompt` 全语料校验；人工核对 2 份会话 5 个 turn |
| A4 | `replay --verify` 在 ≥3 份真实会话上给出判定，不一致项能归因 | 输出含原因分类，不只是 true/false |
| A5 | `diff` 能对齐两次运行并指出第一个分叉的 tool call | 用同一任务跑两次的会话对 |
| A6 | 全量 383 份跑完不 OOM | 流式解码 + 单文件上限（>200MB 拒绝） |
| A7 | HTML 报告单文件、无外链 | 断网打开验证 |

## 非目标

写下来是为了不反复动摇：

- 不做 TUI 优先。传播力为零，HTML 报告才是能被别人打开的东西。
- 不做副作用回放。只读工具之外一律归"不可回放"。
- 不做宿主补丁、不做版本探测、不读别人的 manifest 猜行为。
- 不做第 4 个插件健康检查器（那一片已经挤死了）。
- 不做上传、账号、遥测。日志不出本机。

## 决策记录

- **D-001 名字 `dsh-trace`（npm 包名 `dsh-tracer`，已发布 0.1.0）。** 首次 `npm publish` 被 403 拒绝：`dsh-trace` 与 Datadog 的 `dd-trace` 过于相似，npm 的仿冒保护直接拦下，也只能改成 `@scope/dsh-trace` 那种形式。改发未占用的 `dsh-tracer`，**命令仍然是 `dsh-trace`**（bin 名不变），文档与文章里的命令不用改。原记录 → `dsh-tape` 在 npm 上已被占：2026-09-10 有人以 "name reserved; first release in development" 抢注，撞了同一个概念。`dsh-trace` 可用、直白、搜得到。
- **D-002 语料用本机 383 份真实会话。** 只进统计和脱敏 fixture，原始日志永不入库。
- **D-003 zstd 用 `node:zlib` 内置。** 零 native 依赖；代价是 Node ≥ 24，写进 `engines`。
- **D-004 归一化唯一入口 `src/model/`。** 其他模块只见 tape 类型，防止 schema 变更污染全仓。
- **D-005 HTML 报告优先于 TUI 面板。** 理由同上，可分享 > 好用。
- **D-006 归因口径改用 prompt token（uncached + cacheRead），不做五分类。** 原计划按 system / 指令 / skills / 历史 / 工具结果拆分，实测不可行：v4 的 `request/header` 根本不含 system prompt，而 `inputTokens` 只是未命中缓存的那一小片——直接拿它当上下文大小，会在缓存未命中的那一步凭空造出几十万 token 的跳变（第一版报告因此把 bash 算成 557%）。改成：`prompt = inputTokens + cacheReadTokens`，每步价格分解为 carried（重发）+ fresh（新增），fresh 再按字符比例归到工具与 assistant 消息，解释不了的计入 unattributed。
- **D-007 diff 按工具名对齐，不按参数 hash 对齐。** 原计划用"工具名 + 参数 hash"当对齐键，实测在真实会话对上几乎全不匹配——同一任务两次运行连 `ls -la` 的参数都会变（绝对路径、`head -80`/`head -100`、描述文本）。改成按工具名做 LCS，再逐对比较规范化参数，输出 identical / drifted / a-only / b-only 三级。易变字段（description / timeout）在比较前剔除。

- **D-008 砍掉回放，HTML 提前。** 归因已经给出主故事；回放在真实语料上只能回答"文件还在不在、内容变没变"，信息量远低于 diff。故事收敛为 "trace + attribute + diff"，少一层噱头，多一层能用。
- **D-009 报告里家目录一律脱敏成 `~`。** 报告是拿出去分享的产物，路径里不该带用户名。生成时替换，不改源数据。

- **D-010 归因链条跨 turn 连续，不按 turn 重置。** 原先每个 turn 的第一步算"基线"，不计 carried——多轮会话因此看起来每轮都从零开始，carried 被低估到 92.5%。改成 session 级链式：上一轮的上下文就是下一轮第一步的重发，carried 修正为 98.6%。工具的重读放大系数也随之改成"从追加那一刻到会话结束"。

## 待定

- fixture 脱敏做成 `just redact` 还是保持手工？
- diff 的对齐键：工具名 + 参数 hash，还是调用序号？倾向 hash，序号一旦错位全盘皆错。
- 要不要 `--json` 输出给下游消费？倾向要，D4 再定。

## 风险与降级

| 风险 | 触发信号 | 降级 |
| --- | --- | --- |
| 回放对账做不通 | D3 晚仍无稳定判定 | 砍 replay，把 diff + HTML 做厚；故事变成 "trace + diff" |
| schema 差异超预期 | 老样本解析出结构性差异 | 只保 v4 + 1 份老样本，其余明确报"不支持"，不硬猜 |
| 语料有超大日志 | 单文件 > 200MB | 流式解码 + 上限拒绝 + 报告里标出被跳过的文件 |
| 归因口径站不住 | 数字对不上人工核对 | 先只做"工具结果 vs 其余"两分法，别一上来五类 |

## 简历交付物

- [x] **bullet 1（事实）**：构建并发布 `dsh-trace`，把 zstd 压缩的 agent 会话日志归一化成 tape，并在 383 份会话 / 1,457 轮 / 22.6 亿 prompt token 上做成本归因
- [x] **bullet 2（发现）**：量化出编码 agent 处理的上下文中 98.6% 是重复重发的历史，最贵的 10% 回合吃掉 68.3% 的 prompt token；工具输出以 bash 为首占可归因成本 39.6%
- [x] **bullet 3（工程）**：设计"缓存读 + 未命中输入"的归因口径，会话级自校准字符→token 比例，解释不了的残差单列不摊派；恒等式 `first + carried + fresh == prompt` 在 1,457 个回合上零误差
- [x] **bullet 4（交付）**：零运行时依赖、跨 v0/v3/v4 三代日志格式、单文件离线 HTML 报告；38 个测试

英文版（简历可直接用）：

> Built `dsh-trace`, a zero-dependency Node CLI that decodes zstd-compressed agent session logs into a normalized event tape and attributes 2.26B prompt tokens across 383 sessions.
> Found that 98.6% of the context coding agents process is history re-sent, with the top 10% of turns consuming 68.3% of all prompt tokens.
> Designed an attribution model separating cached from uncached input with per-session calibration, verified by an exact identity on all 1,457 turns; shipped a self-contained HTML report and a tool-sequence diff, 38 tests, no runtime dependencies.
