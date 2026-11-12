/**
 * Compare two groups of sessions — usually the same task run before and after a
 * change to how the agent is driven.
 *
 * The metrics are the ones that move when you clamp tool output or stop churning
 * the prompt prefix: prompt tokens per session, the carried share, cache misses
 * per session, and the size of a typical turn. Absolute totals are useless across
 * groups of different size, so everything is reported per session as well as in
 * total.
 */

import type { Tape } from '../model/tape.ts'
import { aggregate, readGroup } from './scan.ts'
import type { ScanResult } from './scan.ts'

export interface GroupSummary {
  label: string
  sessions: number
  failed: number
  turns: number
  /** Prompt tokens per session — the comparable size measure. */
  promptPerSession: number
  promptTotal: number
  carriedShare: number
  freshShare: number
  uncachedShare: number
  /** Cache misses per session. */
  missesPerSession: number
  /** Median prompt tokens in a turn. */
  medianTurn: number
  /** Share of prompt tokens taken by the most expensive 10% of turns. */
  concentration: number
}

export interface MetricDelta {
  key: string
  a: number
  b: number
  /** Relative change for amounts, percentage-point change for shares. */
  delta: number
  kind: 'amount' | 'share' | 'count'
}

export interface CompareResult {
  a: GroupSummary
  b: GroupSummary
  metrics: MetricDelta[]
  tools: Array<{ name: string; aShare: number; bShare: number; aTokens: number; bTokens: number }>
}

function summarise(label: string, scan: ScanResult): GroupSummary {
  const totals = scan.totals
  const sessions = Math.max(1, totals.sessions)
  return {
    label,
    sessions: totals.sessions,
    failed: totals.failed,
    turns: totals.turns,
    promptPerSession: totals.prompt / sessions,
    promptTotal: totals.prompt,
    carriedShare: totals.prompt === 0 ? 0 : totals.carried / totals.prompt,
    freshShare: totals.prompt === 0 ? 0 : totals.fresh / totals.prompt,
    uncachedShare: totals.prompt === 0 ? 0 : totals.uncached / totals.prompt,
    missesPerSession: totals.cacheMisses / sessions,
    medianTurn: scan.turnPrompt.p50,
    concentration: scan.concentration,
  }
}

function change(a: number, b: number): number {
  return a === 0 ? 0 : (b - a) / a
}

export function compareScans(a: ScanResult, b: ScanResult, labels = { a: 'before', b: 'after' }): CompareResult {
  const groupA = summarise(labels.a, a)
  const groupB = summarise(labels.b, b)

  const metrics: MetricDelta[] = [
    { key: 'prompt / session', a: groupA.promptPerSession, b: groupB.promptPerSession, delta: change(groupA.promptPerSession, groupB.promptPerSession), kind: 'amount' },
    { key: 'carried', a: groupA.carriedShare, b: groupB.carriedShare, delta: groupB.carriedShare - groupA.carriedShare, kind: 'share' },
    { key: 'fresh', a: groupA.freshShare, b: groupB.freshShare, delta: groupB.freshShare - groupA.freshShare, kind: 'share' },
    { key: 'uncached', a: groupA.uncachedShare, b: groupB.uncachedShare, delta: groupB.uncachedShare - groupA.uncachedShare, kind: 'share' },
    { key: 'cache misses / session', a: groupA.missesPerSession, b: groupB.missesPerSession, delta: change(groupA.missesPerSession, groupB.missesPerSession), kind: 'amount' },
    { key: 'median turn', a: groupA.medianTurn, b: groupB.medianTurn, delta: change(groupA.medianTurn, groupB.medianTurn), kind: 'amount' },
    { key: 'top 10% share', a: groupA.concentration, b: groupB.concentration, delta: groupB.concentration - groupA.concentration, kind: 'share' },
  ]

  const names = new Set([...a.tools.map((tool) => tool.name), ...b.tools.map((tool) => tool.name)])
  const tools = [...names]
    .map((name) => {
      const left = a.tools.find((tool) => tool.name === name)
      const right = b.tools.find((tool) => tool.name === name)
      return {
        name,
        aTokens: left?.amplifiedTokens ?? 0,
        bTokens: right?.amplifiedTokens ?? 0,
        aShare: a.totals.prompt === 0 ? 0 : (left?.amplifiedTokens ?? 0) / a.totals.prompt,
        bShare: b.totals.prompt === 0 ? 0 : (right?.amplifiedTokens ?? 0) / b.totals.prompt,
      }
    })
    .sort((x, y) => Math.max(y.aTokens, y.bTokens) - Math.max(x.aTokens, x.bTokens))
    .slice(0, 8)

  return { a: groupA, b: groupB, metrics, tools }
}

export async function compareGroups(
  aPath: string,
  bPath: string,
  options: { labels?: { a: string; b: string }; top?: number } = {}
): Promise<CompareResult> {
  const tapesA: Array<Tape | null> = await readGroup(aPath)
  const tapesB: Array<Tape | null> = await readGroup(bPath)
  const scanA = aggregate(tapesA, { top: options.top })
  const scanB = aggregate(tapesB, { top: options.top })
  return compareScans(scanA, scanB, options.labels)
}
