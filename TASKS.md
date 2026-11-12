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

- [x] `src/report/attribute.ts`：carried / fresh / uncached 分解（口径见 TODO D-006）
- [x] 工具结果按 tool 名聚合，并按"后续重读次数"放大；重复读取按路径聚合
- [x] `dsh-trace report <path>`：文本报告 + `--json` + `--turns/--tools`
- [x] 单测：守恒、缓存未命中、重复读取、未归因残差，共 7 个新用例

**完成标准**：报告能回答"这轮花了多少、最大一项占多少"，且和人工核对 3 个 turn 一致。

---

## D3（11-13）diff：两次运行哪里分叉　✅ 提前完成

> 计划调整（D2 结束时决定）：归因已经给出主故事，回放在真实语料上只能验证"文件还在不在"，信息量低。把 diff 提前到 D3，回放降级为 D4 的可选项。

- [x] `src/report/diff.ts`：按工具名做 LCS 对齐，再逐对比较规范化参数
- [x] 三级判定：identical（同名同参）/ drifted（同名异参）/ a-only / b-only
- [x] 结构分叉与参数漂移分开报告
- [x] `dsh-trace diff <a> <b> [--json] [--limit N]`
- [x] 单测 7 个：同序、漂移、易变字段、插入、重排、turn 指标、ops 上限

**完成标准**：在真实会话对上给出结构化判定。实测 Desktop-X 一对（24 vs 21 次调用）：工具序列 matched 20、identical 0、drifted 20——同一套计划、不同参数。

---

## D4（11-14）HTML 报告　✅ 提前完成（11-13 当天）

> 计划调整：回放砍掉（理由见 TODO D-008），这一天直接做 HTML，而且一次做到了可用状态，不只是骨架。

- [x] `src/report/html.ts`：单文件、零脚本、零外链，纯 CSS 条形图
- [x] 归因视图：prompt 总量 / carried·fresh 占比 / 缓存未命中，逐 turn 条形图
- [x] 工具成本条形图（含重读放大）+ 重复读取表
- [x] diff 视图：matched / identical / drifted / a-only / b-only
- [x] 首页 cwd 中的家目录自动脱敏为 `~`（报告要能发出去）
- [x] `dsh-trace html <session> [-o out.html] [--diff <other>]`
- [x] 无头 Chrome 截图验证（`docs/report.png` 即真实产物）
- [x] 5 个新用例：自包含、转义、脱敏、重复读取、diff 视图

**完成标准**：断网打开正常，一张截图能让人看懂发生了什么。

---

## D5（11-15）批量扫描：跨会话汇总　✅ 完成（11-13）

- [x] `src/report/scan.ts`：递归发现会话（同目录只取最高 schema 版本），4 路并发读取
- [x] 汇总：prompt / carried / fresh / uncached / 缓存未命中 / 工具 / 重复读取 / turn 成本分布
- [x] 派生结论 `findings`：重发占比、成本集中度、缓存代价、最贵工具、最常重读文件
- [x] `dsh-trace scan <dir> [--json] [--html out.html] [--top N]`
- [x] 语料级 HTML 页（`docs/scan.png` 是真实输出）
- [x] 4 个新用例：聚合、同目录去重、坏文件不致命、空目录

**完成标准**：383 份语料 2 秒内跑完，并产出可直接引用的结论。实测 1.96s。

## D5-old（原计划）可视化：自包含 HTML

- [ ] `src/report/html.ts`：单文件 HTML，内联 CSS/JS，无外链
- [ ] 视图：turn 时间轴 + token 归因条 + 工具调用瀑布 + divergence 标记
- [ ] 截图素材：一份真实会话的报告（脱敏后）

**完成标准**：断网能打开，一张截图能让人看懂发生了什么。

---

## D6（11-16）发布准备　✅ 完成（11-13）

- [x] `package.json`：version 0.1.0、`engines.node >= 24`、bin、files、LICENSE、repository、prepublishOnly
- [x] README 定稿：发现、安装、命令、归因口径、限制、设计说明
- [x] 干净安装验证：`npm pack` → 临时目录 `npm i <tgz>` → ingest / report / html 全通
- [x] `npm publish --dry-run`：41 kB、27 个文件、无告警
- [x] git tag `v0.1.0`
- [x] **已发布**：`dsh-tracer@0.1.0`（命令仍叫 `dsh-trace`）。原定包名 `dsh-trace` 被 npm 的仿冒保护 403 拦下——与 Datadog 的 `dd-trace` 过于相似。改发 `dsh-tracer` 后一次通过；发布后注册表先显示占位版本 `0.0.0-stage`，约一分钟后才提升为 0.1.0。

**顺手修掉的两个发版 bug**：① 入口判断用 `import.meta.url === pathToFileURL(argv[1])`，而 npm 把 bin 装成软链、macOS 的 `/tmp` 也是软链，导致 CLI 静默退出 0 —— 改成 realpath 比较，并加回归测试；② 输出接 `| head` 时 EPIPE 直接崩，改成正常退出。

---

## D7（11-17）文章 + 分发　✅ 完成（11-13）

- [x] 文章 `docs/article.md`：口径 → 四个发现 → 五条可操作建议 → 局限 → 工具
- [x] 回填 `TODO.md` 简历条目（中英双版）
- [x] 文章内嵌两张真实截图（单会话报告、语料扫描 + 成本集中度曲线）
- [ ] 发 X 帖（需要账号，待人工）
- [ ] 提交 `dsh-plugin-shop` / awesome feed（需要 GitHub PR，待人工）

**完成标准**：文章有链接、有数字、能被非 DSH 用户读懂。

---

## 每日记录

> 一天结束填一行：做完什么、卡在哪、是否触发降级。

- D1：完成。全量 383 份跑通（0 失败、0 坏行、289,334 事件、3.4s、RSS 236MB）；v0/v3/v4 抽样 turn 数与 `turn/start` 全部一致（72/72、3/3、0/0）。最大单份 7,572 事件 291ms。发现两套 schema 差异：v4 的 usage 在 `assistant/message.data.usage`、tool 结果文本直接挂在 content item 上、header 不含 system prompt（改由 `request/context` 给 provider/model/contextWindow）。
- D2：完成。全量 1,444 个 turn 守恒校验 0 不匹配（first + carried + fresh == prompt）。语料合计 prompt 21.5 亿 token，其中 carried 92.4%、fresh 1.1%、uncached 5.4%；817 次缓存未命中，335 个文件被重复读取。手工复核 2 份会话 5 个 turn，与工具输出逐项一致。
- D3：完成（提前一天）。diff 落地，7 个新用例，真实会话对验证通过；发现"同一任务两次运行"在语料里极少完全同参，按工具名的 LCS 对齐是唯一稳的粒度。
- D4：完成（提前）。HTML 一次做到可用，32 个测试全绿；用 Chrome for Testing 无头截图逐轮修正了对比度、条形分层和转义 bug。
- D5：完成（提前）。scan 落地，2 秒跑完 383 份；顺手发现跨 turn 的上下文重发没被计入，归因改为 session 级链式，carried 从 92.5% 修正到 98.6%。
- D6：完成。发版流程跑通（pack → 干净安装 → 四个命令全过），dry-run 41 kB/27 文件。真实发布卡在 npm 未登录。顺带修了两个只会在"装上去用"时出现的 bug：软链入口判断失败导致 CLI 静默退出、EPIPE 崩溃。
- D7：完成。文章定稿（~2,600 字），三个数字互相印证；简历四条中英版回填。分发（X 帖、catalog 提交）留待人工。
