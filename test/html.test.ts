import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTapeBuilder } from '../src/model/normalize.ts'
import { attributeSession } from '../src/report/attribute.ts'
import { diffTapes } from '../src/report/diff.ts'
import { renderHtml } from '../src/report/html.ts'
import type { Tape } from '../src/model/tape.ts'

function makeTape(cwd = '/tmp/workspace'): Tape {
  const builder = createTapeBuilder({ id: 'session-html', schemaVersion: 4, createdAt: 1_700_000_000_000, cwd })
  builder.push({ type: 'turn/start', time: 1_700_000_000_001, data: { turn: 1 } })
  builder.push({
    type: 'assistant/chunk',
    time: 1_700_000_000_002,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 9_000 } } },
  })
  builder.push({ type: 'tool/call', time: 1_700_000_000_003, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: `{"file_path":"${cwd}/a.txt"}` } })
  builder.push({
    type: 'tool/result',
    time: 1_700_000_000_004,
    data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'x'.repeat(400) }] } },
  })
  builder.push({ type: 'tool/call', time: 1_700_000_000_005, data: { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: `{"file_path":"${cwd}/a.txt"}` } })
  builder.push({
    type: 'tool/result',
    time: 1_700_000_000_006,
    data: { turn: 1, step: 1, message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'x'.repeat(400) }] } },
  })
  builder.push({
    type: 'assistant/chunk',
    time: 1_700_000_000_007,
    data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 1_200, outputTokens: 60, cacheReadTokens: 9_500 } } },
  })
  builder.push({ type: 'request/context', time: 1_700_000_000_008, data: { provider: 'magpie', model: 'auto/test', contextWindow: 100_000 } })
  return builder.finish()
}

test('the report is a single self-contained document', () => {
  const tape = makeTape()
  const html = renderHtml(tape, attributeSession(tape), { generatedAt: new Date(1_700_000_100_000) })
  assert.match(html, /^<!doctype html>/)
  assert.ok(!html.includes('http://'), 'no http resources')
  assert.ok(!html.includes('https://'), 'no https resources')
  assert.ok(!html.includes('<script'), 'no scripts needed')
  assert.match(html, /prompt tokens/i)
  assert.match(html, /carried/i)
  // 10.0k prompt tokens: 9k cached + 1k live in step 1, then 10.7k in step 2.
  assert.ok(html.includes('20.7k'), 'prompt total is rendered')
})

test('session text is escaped, never injected', () => {
  const tape = makeTape('/tmp/<script>alert(1)</script>')
  const html = renderHtml(tape, attributeSession(tape))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('home directory paths are redacted', () => {
  const tape = makeTape(join(homedir(), 'projects/demo'))
  const html = renderHtml(tape, attributeSession(tape))
  assert.ok(!html.includes(homedir()), 'home directory does not leak')
  assert.ok(html.includes('~/projects/demo'))
})

test('repeated reads surface as a section', () => {
  const tape = makeTape()
  const html = renderHtml(tape, attributeSession(tape))
  assert.match(html, /Repeated reads/i)
  assert.ok(html.includes('2×'))
})

test('a diff renders as its own section', () => {
  const tape = makeTape()
  const other = makeTape()
  const html = renderHtml(tape, attributeSession(tape), { diff: diffTapes(tape, other) })
  assert.match(html, /Diff ·/i)
  assert.match(html, /matched/i)
})
