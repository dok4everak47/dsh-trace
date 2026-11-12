/**
 * Corpus scan: run the tape and the attribution over a directory of sessions.
 *
 * The single-session report answers "what happened here". The scan answers "what
 * keeps happening": how much of everything the models processed was context they
 * had already seen, which tools pay for it, and how concentrated the cost is.
 *
 * Sessions are read with a small concurrency pool — disk-bound, and a full
 * 383-session corpus takes a few seconds either way, but the pool keeps that
 * true as the corpus grows.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readSession } from '../ingest/read.ts'
import { promptTokens } from '../model/tape.ts'
import type { Tape } from '../model/tape.ts'
import { attributeSession } from './attribute.ts'
import type { RepeatFinding, ToolAttribution } from './attribute.ts'

export interface ScanTotals {
  sessions: number
  failed: number
  skipped: number
  events: number
  turns: number
  steps: number
  toolCalls: number
  prompt: number
  carried: number
  fresh: number
  uncached: number
  output: number
  cacheMisses: number
  toolOutputChars: number
}

export interface ScanSessionRow {
  id: string
  cwd: string
  schemaVersion: number
  prompt: number
  carried: number
  fresh: number
  turns: number
  toolCalls: number
  cacheMisses: number
}

export interface ScanResult {
  totals: ScanTotals
  tools: ToolAttribution[]
  /** Files read more than once; `sessions` counts distinct sessions. */
  repeats: Array<RepeatFinding & { sessions: number }>
  /** Worst sessions by prompt tokens. */
  sessions: ScanSessionRow[]
  /** Prompt tokens per turn, across the whole corpus. */
  turnPrompt: { p50: number; p90: number; p99: number; max: number }
  /** Share of all prompt tokens taken by the most expensive 10% of turns. */
  concentration: number
  /**
   * Cumulative share of prompt tokens taken by the most expensive `percent`% of
   * turns, sampled every 5 points. The straighter this line bends toward the
   * corner, the more the cost concentrates in a handful of turns.
   */
  curve: Array<{ percent: number; share: number }>
  findings: string[]
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)))
  return sorted[index] ?? 0
}

/**
 * One session per directory. A session can be written more than once while the
 * log format migrates (`session.jsonl.zstd` next to `session.v4.jsonl.zstd`), and
 * counting both inflates every aggregate. The highest schema version wins.
 */
function schemaRank(name: string): number {
  if (name.includes('.v4.')) return 4
  if (name.includes('.v3.')) return 3
  if (name.includes('.v2.')) return 2
  return 1
}

export async function findSessionFiles(root: string): Promise<string[]> {
  const byDirectory = new Map<string, string>()
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.name.endsWith('.jsonl.zstd') && !entry.name.endsWith('.jsonl')) continue
      const current = byDirectory.get(directory)
      if (current === undefined || schemaRank(entry.name) > schemaRank(current.split('/').pop() ?? '')) {
        byDirectory.set(directory, path)
      }
    }
  }
  await walk(root)
  return [...byDirectory.values()].sort()
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function buildFindings(result: Omit<ScanResult, 'findings'>): string[] {
  const totals = result.totals
  if (totals.sessions === 0) return ['no sessions found']
  const findings: string[] = []
  const carriedShare = totals.prompt === 0 ? 0 : totals.carried / totals.prompt
  findings.push(
    `${formatPercent(carriedShare)} of ${(totals.prompt / 1e6).toFixed(1)}M prompt tokens was context re-sent; only ${formatPercent(
      totals.fresh / Math.max(1, totals.prompt)
    )} was new content`
  )
  findings.push(
    `the most expensive 10% of turns produced ${formatPercent(result.concentration)} of all prompt tokens (median turn ${result.turnPrompt.p50.toLocaleString()} tokens, p99 ${result.turnPrompt.p99.toLocaleString()})`
  )
  if (totals.cacheMisses > 0) {
    findings.push(
      `${totals.cacheMisses} cache misses across ${totals.sessions} sessions re-billed ${(totals.uncached / 1e6).toFixed(2)}M input tokens at full rate`
    )
  }
  const worstTool = result.tools[0]
  if (worstTool !== undefined) {
    findings.push(
      `${worstTool.name} accounts for ${formatPercent(worstTool.amplifiedTokens / Math.max(1, totals.prompt))} of attributable prompt tokens (${worstTool.calls.toLocaleString()} calls)`
    )
  }
  if (result.repeats.length > 0) {
    const top = result.repeats[0]!
    findings.push(`most re-read file was opened ${top.reads}× (${(top.chars / 1e3).toFixed(1)}k chars): ${top.path}`)
  }
  return findings
}

/** Read every session under a path; a single file is a group of one. */
export async function readGroup(path: string, options: { concurrency?: number } = {}): Promise<Array<Tape | null>> {
  const { stat } = await import('node:fs/promises')
  const info = await stat(path)
  if (info.isFile()) {
    try {
      return [await readSession(path)]
    } catch {
      return [null]
    }
  }
  const files = await findSessionFiles(path)
  const tapes = await mapLimit(files, options.concurrency ?? 4, async (file) => {
    try {
      return await readSession(file)
    } catch {
      return null
    }
  })
  return tapes
}

export async function scan(root: string, options: { concurrency?: number; top?: number } = {}): Promise<ScanResult> {
  const tapes = await readGroup(root, { concurrency: options.concurrency })
  return aggregate(tapes, options)
}

export function aggregate(tapes: Array<Tape | null>, options: { top?: number } = {}): ScanResult {
  const top = options.top ?? 10

  const totals: ScanTotals = {
    sessions: 0,
    failed: 0,
    skipped: 0,
    events: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    prompt: 0,
    carried: 0,
    fresh: 0,
    uncached: 0,
    output: 0,
    cacheMisses: 0,
    toolOutputChars: 0,
  }
  const tools = new Map<string, ToolAttribution>()
  const repeats = new Map<string, RepeatFinding & { sessions: number }>()
  const rows: ScanSessionRow[] = []
  const turnPrompts: number[] = []

  for (const tape of tapes) {
    if (tape === null) {
      totals.failed += 1
      continue
    }
    const attribution = attributeSession(tape)
    totals.sessions += 1
    totals.skipped += tape.stats.skipped
    totals.events += tape.stats.events
    totals.turns += attribution.totals.turns
    totals.steps += attribution.totals.steps
    totals.toolCalls += tape.toolCalls.length
    totals.prompt += attribution.totals.prompt
    totals.carried += attribution.totals.carried
    totals.fresh += attribution.totals.fresh
    totals.uncached += attribution.totals.uncached
    totals.output += attribution.totals.output
    totals.cacheMisses += attribution.totals.cacheMisses
    totals.toolOutputChars += tape.toolCalls.reduce((sum, call) => sum + (call.resultChars ?? 0), 0)

    for (const turn of tape.turns) {
      const prompt = turn.steps.reduce((sum, step) => sum + promptTokens(step.usage), 0)
      if (prompt > 0) turnPrompts.push(prompt)
    }

    for (const tool of attribution.tools) {
      const entry = tools.get(tool.name) ?? {
        name: tool.name,
        calls: 0,
        errors: 0,
        resultChars: 0,
        freshTokens: 0,
        amplifiedTokens: 0,
      }
      entry.calls += tool.calls
      entry.errors += tool.errors
      entry.resultChars += tool.resultChars
      entry.freshTokens += tool.freshTokens
      entry.amplifiedTokens += tool.amplifiedTokens
      tools.set(tool.name, entry)
    }

    for (const repeat of attribution.repeats) {
      const entry = repeats.get(repeat.path) ?? { ...repeat, sessions: 0 }
      entry.reads = Math.max(entry.reads, repeat.reads)
      entry.chars += repeat.chars
      entry.sessions += 1
      for (const tool of repeat.tools) if (!entry.tools.includes(tool)) entry.tools.push(tool)
      repeats.set(repeat.path, entry)
    }

    rows.push({
      id: tape.session.id,
      cwd: tape.session.cwd,
      schemaVersion: tape.session.schemaVersion,
      prompt: attribution.totals.prompt,
      carried: attribution.totals.carried,
      fresh: attribution.totals.fresh,
      turns: attribution.totals.turns,
      toolCalls: tape.toolCalls.length,
      cacheMisses: attribution.totals.cacheMisses,
    })
  }

  turnPrompts.sort((a, b) => a - b)
  const sortedTurns = [...turnPrompts].sort((a, b) => b - a)
  const topTenth = sortedTurns.slice(0, Math.max(1, Math.floor(sortedTurns.length / 10)))
  const topTenthSum = topTenth.reduce((sum, value) => sum + value, 0)

  const curve: Array<{ percent: number; share: number }> = []
  const totalPrompt = totals.prompt
  for (let percent = 0; percent <= 100; percent += 5) {
    const take = Math.max(1, Math.round((sortedTurns.length * percent) / 100))
    const taken = sortedTurns.slice(0, take).reduce((sum, value) => sum + value, 0)
    curve.push({ percent, share: totalPrompt === 0 ? 0 : taken / totalPrompt })
  }

  const partial: Omit<ScanResult, 'findings'> = {
    totals,
    tools: [...tools.values()].sort((a, b) => b.amplifiedTokens - a.amplifiedTokens),
    repeats: [...repeats.values()].filter((repeat) => repeat.reads > 1).sort((a, b) => b.chars - a.chars).slice(0, top),
    sessions: rows.sort((a, b) => b.prompt - a.prompt).slice(0, top),
    turnPrompt: {
      p50: percentile(turnPrompts, 0.5),
      p90: percentile(turnPrompts, 0.9),
      p99: percentile(turnPrompts, 0.99),
      max: sortedTurns[0] ?? 0,
    },
    concentration: totals.prompt === 0 ? 0 : topTenthSum / totals.prompt,
    curve,
  }

  return { ...partial, findings: buildFindings(partial) }
}

export type { Tape }
