import assert from 'node:assert/strict'
import test from 'node:test'

import { createTapeBuilder, sessionFromHeader } from '../src/model/normalize.ts'
import type { RawEvent } from '../src/model/normalize.ts'
import type { TapeSession } from '../src/model/tape.ts'

const session: TapeSession = {
  id: 'session-test',
  schemaVersion: 0,
  createdAt: 1_000,
  cwd: '/tmp/example',
}

function event(type: string, data: Record<string, unknown>, time: number): RawEvent {
  return { type, time, data }
}

test('v0 shape: streamed usage and nested tool-result content', () => {
  const builder = createTapeBuilder(session)
  builder.push(event('turn/start', { turn: 1 }, 1_000))
  builder.push(event('step/start', { turn: 1, step: 1 }, 1_001))
  builder.push({
    type: 'assistant/chunk',
    time: 1_002,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } } },
  })
  builder.push(event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, 1_003))
  builder.push({
    type: 'tool/result',
    time: 1_004,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'hello world' }] }],
      },
    },
  })
  builder.push(event('step/end', { turn: 1, step: 1 }, 1_005))
  builder.push(event('turn/end', { turn: 1, reason: 'stop' }, 1_006))

  const tape = builder.finish()

  assert.equal(tape.turns.length, 1)
  assert.equal(tape.turns[0]?.turn, 1)
  assert.deepEqual(tape.turns[0]?.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 })
  assert.equal(tape.turns[0]?.reason, 'stop')
  assert.equal(tape.toolCalls.length, 1)
  assert.equal(tape.toolCalls[0]?.resultChars, 'hello world'.length)
  assert.equal(tape.toolCalls[0]?.isError, false)
  assert.deepEqual(tape.turns[0]?.toolCalls, ['c1'])
})

test('v4 shape: usage on the assembled message, text on the result item', () => {
  const builder = createTapeBuilder({ ...session, schemaVersion: 4 })
  builder.push(event('turn/start', { turn: 1 }, 2_000))
  builder.push(event('step/start', { turn: 1, step: 1 }, 2_001))
  builder.push({
    type: 'assistant/message',
    time: 2_002,
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 13_009, outputTokens: 98, totalTokens: 13_107 },
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking about it' },
          { type: 'text', text: 'here you go' },
          { type: 'tool-call', id: 'call-1', name: 'web_fetch', arguments: '{"url":"https://example.com"}' },
        ],
      },
    },
  })
  // Same request reported again on step/end: must not be counted twice.
  builder.push(event('step/end', { turn: 1, step: 1, usage: { inputTokens: 13_009, outputTokens: 98 } }, 2_003))
  builder.push({
    type: 'tool/result',
    time: 2_004,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: 'HTTP 200 OK' }],
      },
    },
  })
  builder.push(event('turn/end', { turn: 1, reason: 'stop' }, 2_005))

  const tape = builder.finish()

  assert.deepEqual(tape.turns[0]?.usage, { inputTokens: 13_009, outputTokens: 98, cacheReadTokens: 0 })
  assert.equal(tape.toolCalls.length, 1, 'tool call registered from assistant/message content')
  assert.equal(tape.toolCalls[0]?.resultChars, 'HTTP 200 OK'.length)
  const assistant = tape.messages.find((message) => message.kind === 'assistant')
  assert.equal(assistant?.text, 'here you go')
  assert.equal(assistant?.reasoningChars, 'thinking about it'.length)
})

test('usage from streamed chunks accumulates, assembled usage does not double count', () => {
  const builder = createTapeBuilder(session)
  builder.push(event('turn/start', { turn: 1 }, 1_000))
  const chunk = (input: number, output: number): RawEvent => ({
    type: 'assistant/chunk',
    time: 1_001,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output } } },
  })
  builder.push(chunk(10, 1))
  builder.push(chunk(10, 2))
  const tape = builder.finish()
  assert.deepEqual(tape.turns[0]?.usage, { inputTokens: 20, outputTokens: 3, cacheReadTokens: 0 })
})

test('request/header and request/context fill the context block', () => {
  const builder = createTapeBuilder({ ...session, schemaVersion: 0 })
  builder.push({
    type: 'request/header',
    time: 1_000,
    data: {
      header: {
        config: { provider: 'token-r', model: 'deepseek-v4-flash' },
        system: 'x'.repeat(120),
        tools: [{ name: 'bash' }, { name: 'read' }],
      },
    },
  })
  const tape = builder.finish()
  assert.equal(tape.context?.systemChars, 120)
  assert.equal(tape.context?.toolCount, 2)
  assert.equal(tape.context?.provider, 'token-r')
  assert.ok((tape.context?.toolDefsChars ?? 0) > 0)
})

test('v4 has no system prompt in the header: the field stays absent', () => {
  const builder = createTapeBuilder({ ...session, schemaVersion: 4 })
  builder.push({
    type: 'request/header',
    time: 1_000,
    data: { header: { config: { provider: 'magpie', model: 'auto/hy3' }, tools: [{ name: 'bash' }] } },
  })
  builder.push({ type: 'request/context', time: 1_001, data: { provider: 'magpie', model: 'auto/hy3', contextWindow: 960_000 } })
  const tape = builder.finish()
  assert.equal(tape.context?.systemChars, undefined)
  assert.equal(tape.context?.contextWindow, 960_000)
  assert.equal(tape.context?.model, 'auto/hy3')
})

test('unknown event types are counted and never throw', () => {
  const builder = createTapeBuilder(session)
  builder.push({ type: 'future/thing', time: 1_000, data: { anything: [1, 2, 3] } })
  builder.push({ type: 'turn/start' })
  builder.push({ time: 1_001 })
  const tape = builder.finish({ skipped: 2 })
  assert.equal(tape.stats.byType['future/thing'], 1)
  assert.equal(tape.stats.skipped, 2)
  assert.equal(tape.stats.events, 3)
})

test('error results are flagged', () => {
  const builder = createTapeBuilder(session)
  builder.push(event('turn/start', { turn: 1 }, 1_000))
  builder.push(event('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'bash', arguments: '{}' }, 1_001))
  builder.push({
    type: 'tool/result',
    time: 1_002,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'c9' },
        content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'boom' }] }],
      },
    },
  })
  const tape = builder.finish()
  assert.equal(tape.toolCalls[0]?.isError, true)
  assert.equal(tape.toolCalls[0]?.resultChars, 4)
})

test('sessionFromHeader rejects non-header events', () => {
  assert.equal(sessionFromHeader({ type: 'turn/start', data: {} }), undefined)
  assert.deepEqual(sessionFromHeader({ type: 'session', id: 's', cwd: '/', createdAt: 1, version: 4 }), {
    id: 's',
    cwd: '/',
    createdAt: 1,
    schemaVersion: 4,
  })
})
