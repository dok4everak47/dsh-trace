import assert from 'node:assert/strict'
import test from 'node:test'

import { createTapeBuilder } from '../src/model/normalize.ts'
import type { RawEvent } from '../src/model/normalize.ts'
import { promptTokens } from '../src/model/tape.ts'
import type { TapeSession } from '../src/model/tape.ts'
import { attributeSession } from '../src/report/attribute.ts'

const session: TapeSession = { id: 'session-a', schemaVersion: 4, createdAt: 1_000, cwd: '/tmp' }

function usageEvent(turn: number, step: number, input: number, cacheRead: number, output = 10): RawEvent {
  return {
    type: 'assistant/chunk',
    time: 1_000 + step,
    data: { turn, step, chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead } } },
  }
}

function toolCall(turn: number, step: number, callId: string, name: string, args: string, time = 1_000): RawEvent {
  return { type: 'tool/call', time, data: { turn, step, callId, name, arguments: args } }
}

function toolResult(turn: number, step: number, callId: string, text: string, time = 1_000): RawEvent {
  return {
    type: 'tool/result',
    time,
    data: {
      turn,
      step,
      message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text }] },
    },
  }
}

test('prompt tokens are the sum of uncached input and cache reads', () => {
  assert.equal(promptTokens({ inputTokens: 300, outputTokens: 1, cacheReadTokens: 640_000 }), 640_300)
})

test('carried and fresh decompose the prompt exactly', () => {
  const builder = createTapeBuilder(session)
  builder.push({ type: 'turn/start', time: 1_000, data: { turn: 1 } })
  builder.push(usageEvent(1, 1, 100, 0))
  builder.push(usageEvent(1, 2, 150, 0))
  builder.push(usageEvent(1, 3, 180, 0))
  const tape = builder.finish()

  const attribution = attributeSession(tape)
  const turn = attribution.turns[0]!
  assert.equal(turn.prompt, 430)
  assert.equal(turn.carried, 250) // min(150,100) + min(180,150)
  assert.equal(turn.fresh, 80) // (150-100) + (180-150)
  assert.equal(turn.uncached, 430)

  const steps = tape.turns[0]!.steps.filter((step) => promptTokens(step.usage) > 0).sort((a, b) => a.step - b.step)
  assert.equal(promptTokens(steps[0]!.usage) + turn.carried + turn.fresh, turn.prompt)
})

test('fresh tokens with no explaining content are counted as unattributed', () => {
  const builder = createTapeBuilder(session)
  builder.push({ type: 'turn/start', time: 1_000, data: { turn: 1 } })
  builder.push(usageEvent(1, 1, 100, 0))
  builder.push(usageEvent(1, 2, 400, 0))
  const attribution = attributeSession(builder.finish())
  assert.equal(attribution.turns[0]?.fresh, 300)
  assert.equal(attribution.turns[0]?.unattributed, 300)
})

test('tool output is attributed with the calibrated ratio, never above the delta', () => {
  const builder = createTapeBuilder(session)
  builder.push({ type: 'turn/start', time: 1_000, data: { turn: 1 } })
  builder.push(usageEvent(1, 1, 100, 0))
  builder.push(toolCall(1, 1, 'c1', 'read', '{"file_path":"/a.txt"}'))
  builder.push(toolResult(1, 1, 'c1', 'x'.repeat(1_000)))
  builder.push(usageEvent(1, 2, 400, 0))
  builder.push(usageEvent(1, 3, 400, 0))

  const attribution = attributeSession(builder.finish())
  const tool = attribution.tools.find((entry) => entry.name === 'read')
  assert.equal(attribution.calibration.samples, 1)
  assert.ok(tool !== undefined)
  assert.equal(tool.calls, 1)
  assert.equal(tool.resultChars, 1_000)
  assert.ok(tool.freshTokens <= 300)
  assert.ok(attribution.turns[0]!.unattributed >= 0)
})

test('cache misses are counted where most of the context was billed uncached', () => {
  const builder = createTapeBuilder(session)
  builder.push({ type: 'turn/start', time: 1_000, data: { turn: 1 } })
  builder.push(usageEvent(1, 1, 90_000, 0))
  builder.push(usageEvent(1, 2, 200, 90_000))
  const attribution = attributeSession(builder.finish())
  assert.equal(attribution.turns[0]?.cacheMisses, 1)
})

test('the same file read twice is reported as a repeat', () => {
  const builder = createTapeBuilder(session)
  builder.push({ type: 'turn/start', time: 1_000, data: { turn: 1 } })
  builder.push(usageEvent(1, 1, 100, 0))
  builder.push(toolCall(1, 1, 'c1', 'read', '{"file_path":"/a.txt"}'))
  builder.push(toolResult(1, 1, 'c1', 'hello'))
  builder.push(toolCall(1, 1, 'c2', 'read', '{"file_path":"/a.txt"}'))
  builder.push(toolResult(1, 1, 'c2', 'hello'))
  const attribution = attributeSession(builder.finish())
  assert.equal(attribution.repeats.length, 1)
  assert.equal(attribution.repeats[0]?.reads, 2)
  assert.equal(attribution.repeats[0]?.path, '/a.txt')
  assert.equal(attribution.repeats[0]?.chars, 10)
})

test('tool counts come from the call log, not the attribution walk', () => {
  const builder = createTapeBuilder(session)
  builder.push({ type: 'turn/start', time: 1_000, data: { turn: 1 } })
  builder.push(usageEvent(1, 1, 100, 0))
  builder.push(toolCall(1, 1, 'c1', 'bash', '{"command":"ls"}'))
  builder.push({
    type: 'tool/result',
    time: 1_001,
    data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'boom', isError: true }] } },
  })
  const attribution = attributeSession(builder.finish())
  const tool = attribution.tools.find((entry) => entry.name === 'bash')
  assert.equal(tool?.calls, 1)
  assert.equal(tool?.errors, 1)
  assert.equal(tool?.resultChars, 4)
})
