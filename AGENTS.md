# AGENTS.md — dsh-trace

给在本仓库动手的编码 agent（也包括我自己）。`README.md` 是给外人看的，这份是给干活的人看的：约束、地图、命令、完成定义。

## 这个项目是什么

一个**离线**的 DSH 会话分析器：读 `~/.dsh/sessions/**/session*.jsonl.zstd`，解压 → 归一化成 tape → 出报告 / 回放 / diff。

它不是 DSH 插件运行时的一部分，不注册任何 `ctx.*` 服务，不参与宿主启动。它只读磁盘上的既有文件，所以上游怎么发版都砸不到它。**这个性质是项目的主要卖点，不是实现细节。**

## 硬约束（违反任何一条就不要提交）

1. **零 native 依赖。** zstd 解压只准用 `node:zlib` 的内置 `zstdDecompressSync` / `createZstdDecompress`（Node ≥ 23.8，本机系统 node 24.22.2、devShell 24.22.1 均已验证）。不准引 `@mongodb-js/zstd`、不准 shell out 到 `zstd` 二进制（shell 里有，但运行时不能依赖它）。
2. **零宿主补丁。** 不写 `cordis.patch.yml`，不用 `require.resolve('@deepseek-ai/*/package.json')` 探版本，不读别的包的 manifest 来猜行为。上游改了什么，本工具用"跑不通这个会话"来表达，不用"猜对版本号"来表达。
3. **回放只读。** 只重放 `read` / `glob` / `grep` 这类无副作用工具。不重放 bash、不写文件、不调网络。判定不确定的工具，默认归入"不可回放"。
4. **会话日志是不可信输入。** 它包含模型输出、文件内容、可能包含密钥。解析时：不 `eval`、不 `new Function`、不把日志文本拼进 shell、不把整份内容打进日志。JSON 解析失败按"跳过该行并计数"处理，不要 try/catch 后静默吞掉。
5. **真实日志不进库。** `test/fixtures/private/` 已被 `.gitignore` 忽略。要提交 fixture，必须人工脱敏成最小复现（≤ 200 行事件），并去掉路径里的用户名。
6. **不新增运行时依赖。** 目前 allowlist 为空，标准库够用。要加依赖，先在 `TODO.md` 的决策记录里写清理由和被否决的替代方案。

## 仓库地图

```
flake.nix          devShell: nodejs_24 + pnpm + just/ripgrep/jq/zstd/hyperfine
.envrc             use flake
src/ingest/        zstd 解码、JSONL 逐行解析、schema 版本识别
src/model/         tape 类型定义、事件归一化（唯一允许知道 raw 事件形状的地方）
src/report/        turn 表、token 归因、HTML 渲染
src/replay/        只读工具重放与 divergence 判定
src/cli/           命令解析与输出（ingest / report / replay / diff）
test/fixtures/     脱敏后的小样本；private/ 下放本机真实日志，不提交
test/              单测按模块平行放置
```

**归一化只在 `src/model/` 里发生。** 其他模块只允许接触归一化后的 tape 类型，不许再摸 raw 事件的字段名——这是唯一能防止 schema 变更污染全仓的办法。

## 命令

```sh
direnv allow            # 首次
nix develop             # 不开 direnv 时
pnpm install
just test               # node --test test/*.test.ts（直接跑 TS，无需构建）
just check              # tsc 类型检查（src + test）
pnpm build              # 产出 dist/，发布用
node src/cli/main.ts ingest <path>   # 开发时直接跑
```

`justfile` 里是常用组合，`just --list` 看。

## 代码约定

- TypeScript strict，ESM，`"type": "module"`。
- 不用 default export；模块边界用命名导出。
- 纯函数优先：解析、归一化、归因都不碰 IO；IO 收敛在 `src/ingest` 和 `src/cli`。
- 错误不吞。要么抛带上下文的错误（含文件路径 + 行号），要么进"跳过并计数"的显式计数桶，最后在报告里打出来。
- 命名跟 DSH 的事件名对齐（`turn/start`、`tool/call`、`tool/result`），别自创同义词。
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`）。

## 完成定义（DoD）

一个任务算完成，要同时满足：

1. `just test` 绿，且有覆盖该行为的用例；
2. 在**至少一份真实会话**上跑通（结果贴进 PR/commit 描述或 `TASKS.md` 当日记录）；
3. `package.json` 依赖数没有增加（除非 TODO 里有决策记录）；
4. 没有新增对宿主内部结构的假设。

## 计划在哪

- `TODO.md` — 意图、范围、验收标准、决策记录、风险。**改范围改这里。**
- `TASKS.md` — 七天排期、每日完成标准、砍线。**改进度改这里。**

两边都不要写重复内容：`TODO.md` 答"为什么和做到什么算完"，`TASKS.md` 答"什么时候做哪一件"。

## 已知事实（省得重新查）

- 日志路径：`~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`；老会话是 `session.jsonl.zstd`。两者都是 zstd 压缩的 JSONL。
- 本机语料：**383 份**（v4 215 / v0 166 / v3 2）、压缩后 **137MB**、33 份超过 1MB。单份最大样本 7,572 个事件。
- 全量 ingest 基线（D1 实测）：383/383 成功、**289,334** 事件、0 坏行、3.4s、RSS 236MB；共 1,554 turn、16,405 次工具调用、2,907 万字符工具输出、1.15 亿**未命中缓存**的输入 token（另见下条 prompt token 口径）。
- 事件类型（按出现频次）：`reasoning-chunks`、`assistant/chunk`、`tool-call-chunks`、`tool/code-dispatch-start`、`tool/code-dispatch`、`text-chunks`、`step/start`、`assistant/message`、`step/end`、`tool/call`、`tool/result`、`agent/inbox/spliced`、`user/message`、`turn/start`、`turn/end`。
- 首行是 `{"type":"session","version":0,"id":...}`，之后每行带 `seq` 和 `time`（epoch ms）。
- 单份样本里 `reasoning-chunks` 占全部事件的 **50%** — 归一化时先按类型分流，别把流式 chunk 当普通事件逐条建对象。
- 解压验证过的读法：`zstdDecompressSync(readFileSync(path))` → UTF-8 → 按 `\n` 切 → 逐行 `JSON.parse`。
- **用量字段口径（D2 实测，最容易踩的坑）**：`usage.inputTokens` 只是**未命中缓存**的输入；上下文真实大小是 `inputTokens + cacheReadTokens`。拿 `inputTokens` 当上下文大小，会在缓存失效那一步造出几十万 token 的假跳变。v0 的 `assistant/chunk` 与 v4 的 `assistant/message` 都带 `cacheReadTokens`。
- **v0 与 v4 的三处差异**（D1 实测，归一化已兼容）：① token 用量 v0 走 `assistant/chunk` 的 `chunk.type=usage`，v4 挂在 `assistant/message.data.usage`（同一次请求 `step/end` 也会带，只取一次）；② 工具结果文本 v0 嵌在 `content[].content[].text`，v4 直接是 `content[].text`；③ v4 的 `request/header` 不含 system prompt，provider/model/contextWindow 改由 `request/context` 提供。
