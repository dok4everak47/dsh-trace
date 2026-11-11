import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { readEvents, readSession } from '../src/ingest/read.ts'

const header = JSON.stringify({
  type: 'session',
  version: 4,
  id: 'session-fixture',
  createdAt: 1_700_000_000_000,
  cwd: '/tmp/fixture',
  agentPreset: 'liangshen',
})

const turnStart = JSON.stringify({ type: 'turn/start', seq: 0, time: 1_700_000_000_001, data: { turn: 1 } })
const toolCall = JSON.stringify({
  type: 'tool/call',
  seq: 1,
  time: 1_700_000_000_002,
  data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' },
})
const turnEnd = JSON.stringify({ type: 'turn/end', seq: 2, time: 1_700_000_000_003, data: { turn: 1, reason: 'stop' } })

async function fixture(kind: 'jsonl' | 'zstd'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-trace-'))
  const name = kind === 'zstd' ? 'session.v4.jsonl.zstd' : 'session.jsonl'
  const path = join(dir, name)
  const text = [header, turnStart, 'not json at all', toolCall, '', turnEnd].join('\n')
  const bytes = kind === 'zstd' ? zstdCompressSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8')
  await writeFile(path, bytes)
  return path
}

test('plain jsonl parses and counts bad lines', async () => {
  const path = await fixture('jsonl')
  const tape = await readSession(path)
  assert.equal(tape.session.id, 'session-fixture')
  assert.equal(tape.turns.length, 1)
  assert.equal(tape.toolCalls.length, 1)
  assert.equal(tape.stats.skipped, 1)
})

test('zstd-compressed jsonl parses the same way', async () => {
  const path = await fixture('zstd')
  const tape = await readSession(path)
  assert.equal(tape.session.schemaVersion, 4)
  assert.equal(tape.turns.length, 1)
  assert.equal(tape.toolCalls.length, 1)
  assert.equal(tape.stats.skipped, 1)
})

test('onSkip reports the offending line number', async () => {
  const path = await fixture('zstd')
  const seen: number[] = []
  await readSession(path, { onSkip: (line) => seen.push(line) })
  assert.deepEqual(seen, [3])
})

test('readEvents yields structured errors instead of throwing', async () => {
  const path = await fixture('jsonl')
  const errors = []
  for await (const result of readEvents(path)) {
    if (!result.ok) errors.push(result)
  }
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.line, 3)
})

test('a file without a header is rejected with its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-trace-'))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, `${turnStart}\n${turnEnd}\n`)
  await assert.rejects(readSession(path), /no session header/)
})

test('the CLI entry point survives symlinked invocation', async () => {
  const { isEntryPoint } = await import('../src/cli/main.ts')
  const { symlink } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-trace-entry-'))
  const real = join(dir, 'main.js')
  const link = join(dir, 'dsh-trace')
  await writeFile(real, '// entry\n')
  await symlink(real, link)

  assert.equal(isEntryPoint(real, pathToFileURL(real).href), true)
  assert.equal(isEntryPoint(link, pathToFileURL(real).href), true, 'symlinked bin still counts')
  assert.equal(isEntryPoint(undefined, pathToFileURL(real).href), false)
  assert.equal(isEntryPoint(join(dir, 'other.js'), pathToFileURL(real).href), false)
})
