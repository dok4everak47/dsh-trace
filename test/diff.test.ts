import assert from 'node:assert/strict'
import test from 'node:test'

import { createTapeBuilder } from '../src/model/normalize.ts'
import { diffTapes } from '../src/report/diff.ts'
import type { Tape } from '../src/model/tape.ts'
import type { TapeSession } from '../src/model/tape.ts'

function makeTape(calls: Array<{ name: string; args: string }>, schemaVersion = 4): Tape {
  const session: TapeSession = { id: `session-${Math.random().toString(36).slice(2, 8)}`, schemaVersion, createdAt: 1_000, cwd: '/tmp' }
  const builder = createTapeBuilder(session)
  builder.push({ type: 'turn/start', time: 1_000, data: { turn: 1 } })
  builder.push({
    type: 'assistant/chunk',
    time: 1_001,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } },
  })
  calls.forEach((call, index) => {
    builder.push({ type: 'tool/call', time: 1_002 + index, data: { turn: 1, step: 1, callId: `c${index}`, name: call.name, arguments: call.args } })
  })
  return builder.finish()
}

test('identical runs have no divergence', () => {
  const calls = [
    { name: 'bash', args: '{"command":"ls"}' },
    { name: 'read', args: '{"file_path":"/a.txt"}' },
    { name: 'bash', args: '{"command":"cat a.txt"}' },
  ]
  const result = diffTapes(makeTape(calls), makeTape(calls))
  assert.equal(result.matched, 3)
  assert.equal(result.identical, 3)
  assert.equal(result.aOnly, 0)
  assert.equal(result.bOnly, 0)
  assert.equal(result.firstStructural, null)
  assert.equal(result.firstDrift, null)
})

test('the same plan with different arguments is drift, not divergence', () => {
  const a = makeTape([
    { name: 'bash', args: '{"command":"ls -la"}' },
    { name: 'read', args: '{"file_path":"/a.txt"}' },
  ])
  const b = makeTape([
    { name: 'bash', args: '{"command":"ls"}' },
    { name: 'read', args: '{"file_path":"/a.txt"}' },
  ])
  const result = diffTapes(a, b)
  assert.equal(result.matched, 2)
  assert.equal(result.identical, 1)
  assert.equal(result.firstStructural, null)
  assert.equal(result.firstDrift?.type, 'drifted')
})

test('volatile fields do not count as drift', () => {
  const a = makeTape([{ name: 'bash', args: '{"command":"ls","description":"list files"}' }])
  const b = makeTape([{ name: 'bash', args: '{"description":"List the directory","command":"ls"}' }])
  const result = diffTapes(a, b)
  assert.equal(result.identical, 1)
  assert.equal(result.firstDrift, null)
})

test('an extra call on one side is a structural divergence', () => {
  const a = makeTape([
    { name: 'bash', args: '{"command":"ls"}' },
    { name: 'read', args: '{"file_path":"/a.txt"}' },
  ])
  const b = makeTape([{ name: 'bash', args: '{"command":"ls"}' }])
  const result = diffTapes(a, b)
  assert.equal(result.aOnly, 1)
  assert.equal(result.bOnly, 0)
  assert.equal(result.firstStructural?.type, 'a-only')
})

test('a reordered plan keeps the common subsequence', () => {
  const a = makeTape([
    { name: 'bash', args: '{"command":"ls"}' },
    { name: 'read', args: '{"file_path":"/a.txt"}' },
  ])
  const b = makeTape([
    { name: 'read', args: '{"file_path":"/a.txt"}' },
    { name: 'bash', args: '{"command":"ls"}' },
  ])
  const result = diffTapes(a, b)
  assert.equal(result.matched, 1)
  assert.equal(result.aOnly, 1)
  assert.equal(result.bOnly, 1)
})

test('turn metrics line up side by side', () => {
  const tape = makeTape([{ name: 'bash', args: '{"command":"ls"}' }])
  const result = diffTapes(tape, tape)
  assert.equal(result.turns.length, 1)
  assert.equal(result.turns[0]?.a?.steps, 1)
  assert.equal(result.turns[0]?.b?.steps, 1)
  assert.equal(result.turns[0]?.a?.prompt, 100)
})

test('ops are capped by the limit while counters stay complete', () => {
  const calls = Array.from({ length: 6 }, (_, index) => ({ name: `tool${index}`, args: '{}' }))
  const result = diffTapes(makeTape(calls), makeTape([]), { limit: 2 })
  assert.equal(result.ops.length, 2)
  assert.equal(result.aOnly, 6)
})
