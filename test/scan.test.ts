import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { scan } from '../src/report/scan.ts'

function sessionLines(id: string, turns: number, inputTokens: number, cacheRead: number): string[] {
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd: `/tmp/${id}`, agentPreset: 'liangshen' }),
  ]
  for (let turn = 1; turn <= turns; turn++) {
    lines.push(JSON.stringify({ type: 'turn/start', seq: turn * 10, time: 1_700_000_000_000 + turn, data: { turn } }))
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        seq: turn * 10 + 1,
        time: 1_700_000_000_000 + turn,
        data: {
          turn,
          step: 1,
          usage: { inputTokens, outputTokens: 10, cacheReadTokens: cacheRead },
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        },
      })
    )
  }
  return lines
}

async function writeSession(root: string, directory: string, file: string, id: string, turns: number, input: number, cacheRead: number): Promise<void> {
  const dir = join(root, directory)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), zstdCompressSync(Buffer.from(`${sessionLines(id, turns, input, cacheRead).join('\n')}\n`)))
}

test('scan aggregates sessions and derives findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trace-scan-'))
  await writeSession(root, 'a', 'session.v4.jsonl.zstd', 'session-a', 2, 100, 900)
  await writeSession(root, 'b', 'session.v4.jsonl.zstd', 'session-b', 3, 200, 800)

  const result = await scan(root)
  assert.equal(result.totals.sessions, 2)
  assert.equal(result.totals.failed, 0)
  assert.equal(result.totals.turns, 5)
  // (100+900)*2 + (200+800)*3 prompt tokens; identical prompts every step, so
  // everything after the first request is carried and nothing is fresh.
  assert.equal(result.totals.prompt, 2_000 + 3_000)
  assert.equal(result.totals.carried, 1_000 + 2_000)
  assert.equal(result.totals.fresh, 0)
  assert.ok(result.findings.length >= 2)
  assert.match(result.findings[0] ?? '', /context re-sent/)
})

test('a directory with both v0 and v4 logs counts as one session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trace-scan-'))
  await writeSession(root, 'migrated', 'session.jsonl.zstd', 'session-old', 1, 100, 0)
  await writeSession(root, 'migrated', 'session.v4.jsonl.zstd', 'session-new', 4, 300, 0)

  const result = await scan(root)
  assert.equal(result.totals.sessions, 1, 'one session per directory')
  assert.equal(result.totals.turns, 4, 'the v4 log wins')
})

test('unreadable files are counted, not fatal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trace-scan-'))
  await writeSession(root, 'ok', 'session.v4.jsonl.zstd', 'session-ok', 1, 100, 0)
  await mkdir(join(root, 'broken'), { recursive: true })
  await writeFile(join(root, 'broken', 'session.jsonl.zstd'), zstdCompressSync(Buffer.from('not a session\n')))

  const result = await scan(root)
  assert.equal(result.totals.failed, 1)
  assert.equal(result.totals.sessions, 1)
})

test('empty input produces an empty but valid result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trace-scan-'))
  const result = await scan(root)
  assert.equal(result.totals.sessions, 0)
  assert.deepEqual(result.findings, ['no sessions found'])
  assert.equal(result.concentration, 0)
})
