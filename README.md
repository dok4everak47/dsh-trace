# dsh-trace

[![npm](https://img.shields.io/npm/v/dsh-tracer?color=CB3837)](https://www.npmjs.com/package/dsh-tracer)
[![license](https://img.shields.io/badge/license-MIT-3366CC)](#license)

Offline trace, cost attribution and diff for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent sessions.

![dsh-trace report](docs/report.png)

A DSH session is a zstd-compressed, append-only event log — thousands of events per conversation, holding every tool call, every tool result and every streamed reasoning chunk. Nothing reads it in full. `dsh-trace` does:

- **ingest** — decompress and normalize a session into a flat, versioned *tape*
- **report** — decompose each request's prompt tokens into context re-sent (`carried`) versus new content (`fresh`), and attribute the new content back to the tool that produced it
- **diff** — align two runs of the same task on the tool-call sequence, separating a different plan from the same plan with different arguments
- **scan** — run all of the above over a whole corpus and report what keeps happening
- **html** — one self-contained page per session or corpus, no scripts, no network

## What it found

Across 386 local sessions (1,499 turns, 2.38B prompt tokens processed — corpus snapshot, 2026-11-12):

![dsh-trace corpus scan](docs/scan.png)

- **98.6% of everything the models processed was context they had already seen**; 1.2% was new content.
- The most expensive **10% of turns produced 67.5%** of all prompt tokens — median turn 274k tokens, p99 22.8M, max 40.1M.
- 825 cache misses re-billed 119.5M input tokens at full rate.
- `bash` output accounts for 39.0% of attributable prompt tokens.
- The most re-read file was opened 40 times (295k characters).

The scan above was run against a frozen copy of the corpus so the committed
screenshot and the numbers in this README agree. Re-running on a live corpus
gives slightly larger totals — which is itself the point.

## Install

```sh
npm i -g dsh-tracer    # Node >= 24 — installs the `dsh-trace` command
```

The package is `dsh-tracer` because npm refuses `dsh-trace` as too similar to
`dd-trace`; the command it installs is still `dsh-trace`.

Node 24 is not a preference: zstd decompression uses the built-in `node:zlib`
(`zstdDecompressSync`, Node ≥ 23.8), which keeps the package at **zero runtime
dependencies** and avoids shipping a native binary.

## Use

```sh
dsh-trace ingest ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
dsh-trace report ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
dsh-trace diff   <a.jsonl.zstd> <b.jsonl.zstd>
dsh-trace scan   ~/.dsh/sessions --html scan.html
dsh-trace html   <session.jsonl.zstd> -o report.html [--diff <other>]
```

Every command takes `--json` where a machine-readable form makes sense.

## How the numbers are made

`prompt = inputTokens + cacheReadTokens`. `inputTokens` alone is only the
uncached slice of each request — treating it as context size invents 650k-token
jumps every time a cache misses. On a session-wide chain of requests:

```
prompt = first + Σ carried + Σ fresh
carried = min(prompt_i, prompt_i-1)      ← the same context, re-sent
fresh   = max(0, prompt_i - prompt_i-1)  ← content appended after step i-1
```

`fresh` is attributed back to the tool results and assistant messages appended
after the previous step, using a chars→tokens ratio calibrated as the median of
the session's own steps. Whatever that cannot explain — compaction summaries,
tool-schema changes, model switches — is counted as `unattributed` and reported,
never quietly assigned to a tool.

## Limits

- It reads files, it does not run the agent. There is no replay of side-effecting
  tools, and nothing about a session is re-executed.
- Attribution is an estimate of where tokens went, not a billing statement. The
  calibrated ratio is a median; `unattributed` is the honest remainder.
- `diff` compares tool-call sequences, not conversation text.
- v0 (older `session.jsonl.zstd`) and v4 logs are both supported; v3 sessions in
  the wild contain no turns and produce an empty tape rather than an error.

## Design notes

It never patches the host: no `cordis.patch.yml` entries, no version probing, no
reading other packages' manifests. Session logs are already on disk, so a harness
release cannot break it — the worst case is a log shape it does not recognise,
which surfaces as an explicit parse skip.

The report redacts your home directory to `~` on the way out, because reports get
shared.

## Development

```sh
direnv allow    # or: nix develop
pnpm install
just test       # node --test, runs TypeScript directly
just check      # typecheck src + tests
pnpm build      # dist/, what npm publishes
```

Scope and decisions live in [TODO.md](./TODO.md); the day-by-day log — including
what was cut and why — is in [TASKS.md](./TASKS.md).

## License

MIT
