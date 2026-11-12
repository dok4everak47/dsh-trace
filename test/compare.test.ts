import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { compareGroups } from '../src/report/compare.ts'

function sessionLines(id: string, turns: number, input: number, cacheRead: number): string[] {
  const lines = [JSON.stringify({ type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd: `/tmp/${id}` })]
  for (let turn = 1; turn <= turns; turn++) {
    lines.push(JSON.stringify({ type: 'turn/start', seq: turn * 10, time: 1_700_000_000_000 + turn, data: { turn } }))
    lines.push(JSON.stringify({ type: 'tool/call', seq: turn * 10 + 1, time: 1_700_000_000_000 + turn, data: { turn, step: 1, callId: `c${turn}`, name: 'bash', arguments: '{}' } }))
    lines.push(
      JSON.stringify({
        type: 'tool/result',
        seq: turn * 10 + 2,
        time: 1_700_000_000_000 + turn,
        data: { turn, step: 1, message: { source: { callId: `c${turn}` }, content: [{ type: 'text', text: 'x'.repeat(500) }] } },
      })
    )
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        seq: turn * 10 + 3,
        time: 1_700_000_000_000 + turn,
        data: {
          turn,
          step: 2,
          usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: cacheRead },
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        },
      })
    )
  }
  return lines
}

async function group(root: string, name: string, sessions: number, turns: number, input: number, cacheRead: number, misses = 0): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  for (let index = 0; index < sessions; index++) {
    const id = `${name}-${index}`
    const sessionDir = join(dir, id)
    await mkdir(sessionDir, { recursive: true })
    const lines = sessionLines(id, turns, input, cacheRead)
    // A cache miss: bill the whole context as uncached.
    if (index < misses) {
      lines.push(
        JSON.stringify({
          type: 'assistant/message',
          seq: 9_999 + index,
          time: 1_700_000_000_000,
          data: {
            turn: turns,
            step: 3,
            usage: { inputTokens: input + cacheRead, outputTokens: 1, cacheReadTokens: 0 },
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          },
        })
      )
    }
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`)))
  }
  return dir
}

test('comparing two groups reports per-session deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trace-compare-'))
  const before = await group(root, 'before', 2, 3, 100, 900)
  const after = await group(root, 'after', 2, 3, 100, 400)

  const result = await compareGroups(before, after, { labels: { a: 'before', b: 'after' } })
  assert.equal(result.a.sessions, 2)
  assert.equal(result.b.sessions, 2)

  const promptPerSession = result.metrics.find((metric) => metric.key === 'prompt / session')
  assert.ok(promptPerSession !== undefined)
  // before: 1000 prompt per step × 2 steps per turn × 3 turns; after: 500 in the
  // same shape, so the per-session cost should halve.
  assert.ok(Math.abs(promptPerSession.b / promptPerSession.a - 0.5) < 0.05, `ratio ${promptPerSession.b / promptPerSession.a}`)

  const carried = result.metrics.find((metric) => metric.key === 'carried')
  // Same shape, smaller context: the share is unchanged, only the absolute cost moves.
  assert.ok(Math.abs((carried?.a ?? 0) - (carried?.b ?? 0)) < 0.02, `carried a=${carried?.a} b=${carried?.b}`)
  // Three requests with an identical prompt each: two of the three are re-sends.
  assert.ok(Math.abs((carried?.a ?? 0) - 2 / 3) < 0.02, `carried a=${carried?.a}`)
})

test('a single session file can be compared with another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trace-compare-'))
  const before = await group(root, 'before', 1, 2, 100, 900)
  const after = await group(root, 'after', 1, 2, 100, 100)
  const result = await compareGroups(
    join(before, 'before-0', 'session.v4.jsonl.zstd'),
    join(after, 'after-0', 'session.v4.jsonl.zstd')
  )
  assert.equal(result.a.sessions, 1)
  assert.equal(result.b.sessions, 1)
  assert.equal(result.a.turns, 2)
  assert.ok(result.metrics.length >= 5)
  assert.ok(result.tools.some((tool) => tool.name === 'bash'))
})

test('cache misses are reported per session, not in total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trace-compare-'))
  const before = await group(root, 'before', 4, 2, 20_000, 180_000, 4)
  const after = await group(root, 'after', 2, 2, 20_000, 180_000, 1)

  const result = await compareGroups(before, after)
  const misses = result.metrics.find((metric) => metric.key === 'cache misses / session')
  assert.ok(misses !== undefined)
  assert.ok(Math.abs((misses.a ?? 0) - 1) < 0.001, `a=${misses.a}`)
  assert.ok(Math.abs((misses.b ?? 0) - 0.5) < 0.001, `b=${misses.b}`)
})
