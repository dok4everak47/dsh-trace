# dsh-trace

Offline trace, replay and diff for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent sessions.

A DSH session is a compressed, append-only event log (`session.jsonl.zstd`, thousands of events per conversation). It holds everything that actually happened — every tool call, every tool result, every streamed reasoning chunk — and nothing reads it in full. `dsh-trace` turns that log into something you can inspect:

- **ingest** — decompress and normalize a session into a flat, versioned *tape*
- **attribute** — split each turn's token budget across system prompt, instructions, skills, history and tool output
- **replay** — re-execute side-effect-free tools (`read`, `glob`, `grep`) and report where the recording and the filesystem now disagree
- **diff** — align two runs of the same task and show where they diverge

Status: **pre-alpha, day 0.** The scope and the seven-day plan live in [TODO.md](./TODO.md) and [TASKS.md](./TASKS.md).

## Why

Agents are non-deterministic and their transcripts are write-only: when a run goes wrong, the evidence exists but there is no way to ask it questions. `dsh-trace` is the answer to "why did this turn cost 40k tokens" and "what changed between the run that worked and the run that did not", without adding a debugger to the harness itself.

Design constraint that makes it durable: it never patches the host. No `cordis.patch.yml` entries, no version probing, no reading other packages' manifests. It reads files that are already on disk, so a harness release cannot break it.

## Quick start

```sh
direnv allow          # or: nix develop
pnpm install
pnpm build
pnpm dsh-trace ingest ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
```

## Requirements

- Node.js >= 24 — zstd decompression uses the built-in `node:zlib` (`zstdDecompressSync`), so there is no native dependency and no `zstd` binary at runtime.
- No network access. No credentials. Session logs are read locally and never uploaded.

## License

MIT
