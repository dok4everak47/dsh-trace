#!/usr/bin/env node
/**
 * CLI surface for the tape. Milestone D1 shipped `ingest`; `report`, `replay`
 * and `diff` land on D2–D4 and plug in here.
 */

import { pathToFileURL } from 'node:url'

import { readSession } from '../ingest/read.ts'
import type { Tape } from '../model/tape.ts'

const USAGE = `dsh-trace — offline trace for DeepSeek Harness agent sessions

Usage:
  dsh-trace ingest <session.jsonl.zstd> [--json] [--quiet]

Options:
  --json    print the normalized tape as JSON
  --quiet   suppress the per-turn table, keep the summary
`

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

function clock(epochMs: number | undefined): string {
  if (epochMs === undefined) return '--:--:--'
  const date = new Date(epochMs)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function summarizeTools(tape: Tape, callIds: string[]): string {
  if (callIds.length === 0) return '-'
  const names = callIds.map((id) => tape.toolCalls.find((call) => call.callId === id)?.name ?? '?')
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count === 1 ? name : `${name}×${count}`))
    .join(', ')
}

export function renderTable(tape: Tape): string {
  const header = ['turn', 'start', 'steps', 'in', 'out', 'tools']
  const rows = tape.turns.map((turn) => [
    String(turn.turn),
    clock(turn.startAt),
    String(turn.steps.length),
    String(turn.usage.inputTokens),
    String(turn.usage.outputTokens),
    summarizeTools(tape, turn.toolCalls),
  ])
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0))
  )
  const line = (cells: string[]): string =>
    cells.map((cell, index) => pad(cell, widths[index] ?? 0)).join('  ').trimEnd()
  const numeric = new Set([2, 3, 4])
  const numericLine = (cells: string[]): string =>
    cells
      .map((cell, index) => (numeric.has(index) ? padStart(cell, widths[index] ?? 0) : pad(cell, widths[index] ?? 0)))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(numericLine)].join('\n')
}

export function summary(tape: Tape): string {
  const input = tape.turns.reduce((sum, turn) => sum + turn.usage.inputTokens, 0)
  const output = tape.turns.reduce((sum, turn) => sum + turn.usage.outputTokens, 0)
  const failed = tape.toolCalls.filter((call) => call.isError === true).length
  const resultChars = tape.toolCalls.reduce((sum, call) => sum + (call.resultChars ?? 0), 0)
  const context = tape.context
  const parts = [
    `${tape.turns.length} turns`,
    `${tape.toolCalls.length} tool calls${failed > 0 ? ` (${failed} failed)` : ''}`,
    `${input} in / ${output} out tokens`,
    `${resultChars} chars of tool output`,
    `${tape.stats.events} events`,
  ]
  if (tape.stats.skipped > 0) parts.push(`${tape.stats.skipped} unparseable lines`)
  if (context) {
    const system = context.systemChars === undefined ? 'system prompt not in log' : `${context.systemChars} chars system`
    const model = context.model === undefined ? '' : ` · ${context.provider ?? '?'}/${context.model}`
    parts.push(`context: ${system} + ${context.toolCount} tools${model}`)
  }
  return parts.join(' · ')
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return command === undefined ? 2 : 0
  }
  if (command !== 'ingest') {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
    return 2
  }

  const json = rest.includes('--json')
  const quiet = rest.includes('--quiet')
  const path = rest.find((arg) => !arg.startsWith('-'))
  if (path === undefined) {
    process.stderr.write(`missing session path\n\n${USAGE}`)
    return 2
  }

  let tape: Tape
  try {
    tape = await readSession(path, {
      onSkip: (line, error) => process.stderr.write(`skipped line ${line}: ${error}\n`),
    })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(tape, null, 2)}\n`)
    return 0
  }

  const session = tape.session
  process.stdout.write(
    `${session.id}  ${session.cwd}  schema=v${session.schemaVersion}` +
      `${session.agentPreset ? `  preset=${session.agentPreset}` : ''}\n\n`
  )
  if (!quiet && tape.turns.length > 0) process.stdout.write(`${renderTable(tape)}\n\n`)
  process.stdout.write(`${summary(tape)}\n`)
  return 0
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
