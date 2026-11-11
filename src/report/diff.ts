/**
 * Diff: two runs of the same task, aligned step by step.
 *
 * Exact argument matching is useless here — two runs of one task almost never
 * emit byte-identical arguments (timestamps, absolute paths, `head -80` vs
 * `head -100`). What tends to repeat is the *shape* of the work: which tool was
 * called, in what order. So alignment runs on the tool-name sequence, and every
 * aligned pair is then compared on canonical arguments:
 *
 *   same tool, same args  → `identical`
 *   same tool, other args → `drifted`   (the interesting middle ground)
 *   tool only on one side → `a-only` / `b-only`
 *
 * The first structural divergence (tool names disagree) is reported separately
 * from the first argument drift, because they mean different things: one is a
 * different plan, the other is the same plan with different inputs.
 */

import type { Tape, TapeToolCall, TapeTurn } from '../model/tape.ts'
import { promptTokens } from '../model/tape.ts'

export interface CallRef {
  index: number
  turn: number
  step: number
  name: string
  /** Canonicalized arguments, truncated for display. */
  args: string
}

export type DiffOp =
  | { type: 'identical'; a: CallRef; b: CallRef }
  | { type: 'drifted'; a: CallRef; b: CallRef }
  | { type: 'a-only'; a: CallRef }
  | { type: 'b-only'; b: CallRef }

export interface TurnMetrics {
  turn: number
  steps: number
  prompt: number
  output: number
}

export interface DiffResult {
  a: { id: string; calls: number }
  b: { id: string; calls: number }
  /** Aligned pairs, by tool name. */
  matched: number
  /** Of the aligned pairs, how many had identical arguments. */
  identical: number
  aOnly: number
  bOnly: number
  approximate: boolean
  /** First place the tool sequences disagree. */
  firstStructural: DiffOp | null
  /** First aligned pair whose arguments differ. */
  firstDrift: DiffOp | null
  ops: DiffOp[]
  turns: Array<{ turn: number; a: TurnMetrics | null; b: TurnMetrics | null }>
}

/** Stable key ordering, so `{"a":1,"b":2}` and `{"b":2,"a":1}` compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = canonical(record[key])
    return out
  }
  return value
}

/** Fields that change between runs without changing what the call did. */
const VOLATILE_KEYS = new Set(['description', 'timeout', 'timeout_ms'])

function canonicalArgs(call: TapeToolCall): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(call.args)
  } catch {
    return call.args
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return JSON.stringify(canonical(parsed))
  const record = { ...(parsed as Record<string, unknown>) }
  for (const key of VOLATILE_KEYS) delete record[key]
  return JSON.stringify(canonical(record))
}

export function signatureOf(call: TapeToolCall): string {
  return `${call.name}\u0000${canonicalArgs(call)}`
}

function toRef(call: TapeToolCall, index: number): CallRef {
  const args = call.args.length > 140 ? `${call.args.slice(0, 137)}...` : call.args
  return { index, turn: call.turn, step: call.step, name: call.name, args }
}

function lcsAlign(a: number[], b: number[], aCalls: TapeToolCall[], bCalls: TapeToolCall[]): DiffOp[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const index = i * width + j
      dp[index] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      const left = aCalls[i]!
      const right = bCalls[j]!
      ops.push(
        signatureOf(left) === signatureOf(right)
          ? { type: 'identical', a: toRef(left, i), b: toRef(right, j) }
          : { type: 'drifted', a: toRef(left, i), b: toRef(right, j) }
      )
      i++
      j++
      continue
    }
    const down = dp[(i + 1) * width + j] ?? 0
    const right = dp[i * width + j + 1] ?? 0
    if (down >= right) {
      ops.push({ type: 'a-only', a: toRef(aCalls[i]!, i) })
      i++
    } else {
      ops.push({ type: 'b-only', b: toRef(bCalls[j]!, j) })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'a-only', a: toRef(aCalls[i]!, i) })
    i++
  }
  while (j < m) {
    ops.push({ type: 'b-only', b: toRef(bCalls[j]!, j) })
    j++
  }
  return ops
}

function greedyAlign(a: number[], b: number[], aCalls: TapeToolCall[], bCalls: TapeToolCall[]): DiffOp[] {
  const ops: DiffOp[] = []
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const left = aCalls[index]!
    const right = bCalls[index]!
    if (a[index] === b[index]) {
      ops.push(
        signatureOf(left) === signatureOf(right)
          ? { type: 'identical', a: toRef(left, index), b: toRef(right, index) }
          : { type: 'drifted', a: toRef(left, index), b: toRef(right, index) }
      )
    } else {
      ops.push({ type: 'a-only', a: toRef(left, index) })
      ops.push({ type: 'b-only', b: toRef(right, index) })
    }
  }
  for (let index = length; index < a.length; index++) ops.push({ type: 'a-only', a: toRef(aCalls[index]!, index) })
  for (let index = length; index < b.length; index++) ops.push({ type: 'b-only', b: toRef(bCalls[index]!, index) })
  return ops
}

/** Cost ceiling for the exact DP: roughly 8 MB of Int32 cells. */
const MAX_DP_CELLS = 2_000_000

export function diffTapes(a: Tape, b: Tape, options: { limit?: number } = {}): DiffResult {
  const limit = options.limit ?? 10
  const aCalls = a.toolCalls
  const bCalls = b.toolCalls

  const ids = new Map<string, number>()
  const intern = (name: string): number => {
    const existing = ids.get(name)
    if (existing !== undefined) return existing
    const id = ids.size
    ids.set(name, id)
    return id
  }
  const aIds = aCalls.map((call) => intern(call.name))
  const bIds = bCalls.map((call) => intern(call.name))

  const exact = aIds.length * bIds.length <= MAX_DP_CELLS
  const ops = exact ? lcsAlign(aIds, bIds, aCalls, bCalls) : greedyAlign(aIds, bIds, aCalls, bCalls)

  const matched = ops.filter((op) => op.type === 'identical' || op.type === 'drifted').length
  const identical = ops.filter((op) => op.type === 'identical').length
  const aOnly = ops.filter((op) => op.type === 'a-only').length
  const bOnly = ops.filter((op) => op.type === 'b-only').length

  return {
    a: { id: a.session.id, calls: aCalls.length },
    b: { id: b.session.id, calls: bCalls.length },
    matched,
    identical,
    aOnly,
    bOnly,
    approximate: !exact,
    firstStructural: ops.find((op) => op.type === 'a-only' || op.type === 'b-only') ?? null,
    firstDrift: ops.find((op) => op.type === 'drifted') ?? null,
    ops: ops.slice(0, limit),
    turns: alignTurns(a, b),
  }
}

function metricsOf(turn: TapeTurn): TurnMetrics {
  return {
    turn: turn.turn,
    steps: turn.steps.length,
    prompt: turn.steps.reduce((sum, step) => sum + promptTokens(step.usage), 0),
    output: turn.steps.reduce((sum, step) => sum + step.usage.outputTokens, 0),
  }
}

function alignTurns(a: Tape, b: Tape): DiffResult['turns'] {
  const length = Math.max(a.turns.length, b.turns.length)
  const rows: DiffResult['turns'] = []
  for (let index = 0; index < length; index++) {
    const left = a.turns[index]
    const right = b.turns[index]
    rows.push({
      turn: index + 1,
      a: left === undefined ? null : metricsOf(left),
      b: right === undefined ? null : metricsOf(right),
    })
  }
  return rows
}
