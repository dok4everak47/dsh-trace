#!/usr/bin/env node
/**
 * CLI surface for the tape. Milestone D1 shipped `ingest`; `report`, `replay`
 * and `diff` land on D2–D4 and plug in here.
 */

import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readSession } from '../ingest/read.ts'
import type { Tape } from '../model/tape.ts'
import { attributeSession, formatTokens, share } from '../report/attribute.ts'
import type { SessionAttribution } from '../report/attribute.ts'
import { diffTapes } from '../report/diff.ts'
import { renderHtml, renderScanHtml } from '../report/html.ts'
import { scan } from '../report/scan.ts'
import { compareGroups } from '../report/compare.ts'
import type { CompareResult } from '../report/compare.ts'
import type { CallRef, DiffOp, DiffResult } from '../report/diff.ts'

const USAGE = `dsh-trace — offline trace for DeepSeek Harness agent sessions

Usage:
  dsh-trace ingest <session.jsonl.zstd> [--json] [--quiet]
  dsh-trace report <session.jsonl.zstd> [--json] [--turns N] [--tools N]
  dsh-trace diff <a.jsonl.zstd> <b.jsonl.zstd> [--json] [--limit N]
  dsh-trace html <session.jsonl.zstd> [-o report.html] [--diff <other.jsonl.zstd>]
  dsh-trace scan <sessions-dir> [--json] [--html scan.html] [--top N]
  dsh-trace compare <a-dir|file> <b-dir|file> [--json] [--label-a X] [--label-b Y]

Options:
  --json     print machine-readable output
  --quiet    suppress tables, keep the summary
  --turns N  how many turns to list (default 10)
  --tools N  how many tools to list (default 10)
  --limit N  how many divergences to list (default 10)
  -o PATH    where to write the HTML report (default dsh-trace-report.html)
  --html P   write the scan summary page to P
  --top N    rows to show in tables (default 10)
  --label-a  name for the first group in compare
  --label-b  name for the second group in compare
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

export function renderReport(tape: Tape, attribution: SessionAttribution, options: { turns: number; tools: number }): string {
  const totals = attribution.totals
  const out: string[] = []
  out.push(
    `prompt ${formatTokens(totals.prompt)} · carried ${formatTokens(totals.carried)} (${share(totals.carried, totals.prompt)})` +
      ` · fresh ${formatTokens(totals.fresh)} (${share(totals.fresh, totals.prompt)})` +
      ` · uncached ${formatTokens(totals.uncached)} (${share(totals.uncached, totals.prompt)})`
  )
  out.push(
    `output ${formatTokens(totals.output)} · unattributed ${formatTokens(totals.unattributed)}` +
      ` · chars→tokens ${attribution.calibration.tokensPerChar.toFixed(2)} (n=${attribution.calibration.samples})` +
      ` · evicted ${formatTokens(totals.evicted)}` +
      ` · peak context ${formatTokens(totals.peakPrompt)} · cache misses ${totals.cacheMisses}` +
      ` · ${totals.turns} turns / ${totals.steps} steps`
  )

  const turnRows = attribution.turns.slice(0, options.turns).map((turn) => [
    String(turn.turn),
    formatTokens(turn.prompt),
    formatTokens(turn.carried),
    formatTokens(turn.fresh),
    String(turn.steps),
    formatTokens(turn.peakPrompt),
    turn.cacheMisses > 0 ? String(turn.cacheMisses) : '-',
    turn.topTool === null ? '-' : `${turn.topTool.name} ${formatTokens(turn.topTool.amplified)}`,
  ])
  out.push('')
  out.push(renderGrid(['turn', 'prompt', 'carried', 'fresh', 'steps', 'peak', 'miss', 'top tool'], turnRows, new Set([4, 6])))

  const toolRows = attribution.tools.slice(0, options.tools).map((tool) => [
    tool.name,
    String(tool.calls),
    formatTokens(tool.resultChars),
    formatTokens(tool.freshTokens),
    formatTokens(tool.amplifiedTokens),
    share(tool.amplifiedTokens, totals.prompt),
    tool.errors > 0 ? String(tool.errors) : '-',
  ])
  out.push('')
  out.push(renderGrid(['tool', 'calls', 'chars', 'fresh', 'amplified', 'of prompt', 'errors'], toolRows, new Set([1, 6])))

  if (attribution.repeats.length > 0) {
    out.push('')
    out.push(`repeated file reads (${attribution.repeats.length}):`)
    for (const repeat of attribution.repeats.slice(0, options.tools)) {
      out.push(`  ${repeat.reads}x  ${formatTokens(repeat.chars)} chars  ${repeat.tools.join('+')}  ${repeat.path}`)
    }
  }
  return out.join('\n')
}

function renderGrid(header: string[], rows: string[][], rightAligned: Set<number>): string {
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)))
  const format = (cells: string[]): string =>
    cells
      .map((cell, index) => (rightAligned.has(index) ? padStart(cell, widths[index] ?? 0) : pad(cell, widths[index] ?? 0)))
      .join('  ')
      .trimEnd()
  return [format(header), ...rows.map(format)].join('\n')
}

function describeCall(ref: CallRef | undefined): string {
  if (ref === undefined) return '(none)'
  return `#${ref.index} t${ref.turn}/s${ref.step} ${ref.name} ${ref.args}`
}

function describeOp(op: DiffOp, side: 'a' | 'b'): string {
  switch (op.type) {
    case 'identical':
    case 'drifted':
      return describeCall(side === 'a' ? op.a : op.b)
    case 'a-only':
      return side === 'a' ? describeCall(op.a) : '(nothing)'
    case 'b-only':
      return side === 'b' ? describeCall(op.b) : '(nothing)'
  }
}

export function renderDiff(result: DiffResult): string {
  const out: string[] = []
  out.push(`a: ${result.a.id}  (${result.a.calls} calls)`)
  out.push(`b: ${result.b.id}  (${result.b.calls} calls)`)
  out.push('')
  out.push(
    `tool sequence: matched ${result.matched} · identical ${result.identical}` +
      ` · drifted ${result.matched - result.identical} · a-only ${result.aOnly} · b-only ${result.bOnly}` +
      `${result.approximate ? ' · approximate' : ''}`
  )

  if (result.firstStructural === null) out.push('tool sequences agree')
  else {
    const op = result.firstStructural
    out.push('')
    out.push('first structural divergence:')
    out.push(`  a: ${describeOp(op, 'a')}`)
    out.push(`  b: ${describeOp(op, 'b')}`)
  }

  if (result.firstDrift !== null) {
    const op = result.firstDrift
    out.push('')
    out.push('first argument drift:')
    out.push(`  a: ${describeOp(op, 'a')}`)
    out.push(`  b: ${describeOp(op, 'b')}`)
  }

  const differing = result.ops.filter((op) => op.type !== 'identical').slice(0, 5)
  if (differing.length > 0) {
    out.push('')
    out.push('first differing calls:')
    for (const op of differing) {
      out.push(`  [${op.type}] a: ${describeOp(op, 'a')}`)
      out.push(`            b: ${describeOp(op, 'b')}`)
    }
  }

  const rows = result.turns.map((row) => [
    String(row.turn),
    `${row.a?.steps ?? '-'} / ${row.b?.steps ?? '-'}`,
    `${row.a === null ? '-' : formatTokens(row.a.prompt)} / ${row.b === null ? '-' : formatTokens(row.b.prompt)}`,
  ])
  out.push('')
  out.push(renderGrid(['turn', 'steps a/b', 'prompt a/b'], rows, new Set()))
  return out.join('\n')
}

function formatDelta(metric: CompareResult['metrics'][number]): string {
  const sign = metric.kind === 'share' ? (metric.delta >= 0 ? '+' : '') : metric.delta >= 0 ? '+' : ''
  if (metric.kind === 'share') return `${sign}${(metric.delta * 100).toFixed(1)} pp`
  return `${sign}${(metric.delta * 100).toFixed(1)}%`
}

function formatMetric(metric: CompareResult['metrics'][number], value: number): string {
  if (metric.kind === 'share') return `${(value * 100).toFixed(1)}%`
  if (metric.key === 'cache misses / session') return value.toFixed(1)
  return formatTokens(value)
}

export function renderCompare(result: CompareResult): string {
  const out: string[] = []
  out.push(
    `${result.a.label}: ${result.a.sessions} sessions / ${result.a.turns} turns` +
      `   ${result.b.label}: ${result.b.sessions} sessions / ${result.b.turns} turns`
  )
  out.push('')
  const rows = result.metrics.map((metric) => [
    metric.key,
    formatMetric(metric, metric.a),
    formatMetric(metric, metric.b),
    formatDelta(metric),
  ])
  out.push(renderGrid(['metric', result.a.label, result.b.label, 'change'], rows, new Set([1, 2, 3])))
  out.push('')
  const toolRows = result.tools.map((tool) => [
    tool.name,
    `${(tool.aShare * 100).toFixed(1)}%`,
    `${(tool.bShare * 100).toFixed(1)}%`,
    `${((tool.bShare - tool.aShare) * 100).toFixed(1)} pp`,
  ])
  out.push(renderGrid(['tool', result.a.label, result.b.label, 'change'], toolRows, new Set([1, 2, 3])))
  return out.join('\n')
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return command === undefined ? 2 : 0
  }
  const known = ['ingest', 'report', 'diff', 'html', 'scan', 'compare']
  if (!known.includes(command)) {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
    return 2
  }

  const json = rest.includes('--json')
  const quiet = rest.includes('--quiet')
  const paths = rest.filter((arg, index) => !arg.startsWith('-') && !(index > 0 && rest[index - 1]?.startsWith('--')))
  const path = paths[0]
  const numberArg = (flag: string, fallback: number): number => {
    const index = rest.indexOf(flag)
    const raw = index >= 0 ? rest[index + 1] : undefined
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  if (path === undefined) {
    process.stderr.write(`missing session path\n\n${USAGE}`)
    return 2
  }

  if (command === 'compare') {
    const labelAIndex = rest.indexOf('--label-a')
    const labelBIndex = rest.indexOf('--label-b')
    const consumed = new Set<number>()
    for (const index of [labelAIndex, labelBIndex]) {
      if (index >= 0) {
        consumed.add(index)
        consumed.add(index + 1)
      }
    }
    const positional = rest.filter((arg, index) => !arg.startsWith('-') && !consumed.has(index))
    const [first, second] = positional
    if (first === undefined || second === undefined) {
      process.stderr.write(`compare needs two paths\n\n${USAGE}`)
      return 2
    }
    try {
      const result = await compareGroups(first, second, {
        labels: {
          a: labelAIndex >= 0 ? (rest[labelAIndex + 1] ?? 'before') : 'before',
          b: labelBIndex >= 0 ? (rest[labelBIndex + 1] ?? 'after') : 'after',
        },
      })
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return 0
      }
      process.stdout.write(`${renderCompare(result)}\n`)
      return 0
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
      return 1
    }
  }

  if (command === 'scan') {
    const htmlIndex = rest.indexOf('--html')
    const htmlFile = htmlIndex >= 0 ? rest[htmlIndex + 1] : undefined
    const consumed = new Set<number>()
    if (htmlIndex >= 0) {
      consumed.add(htmlIndex)
      consumed.add(htmlIndex + 1)
    }
    for (const flag of ['--top', '--concurrency']) {
      const index = rest.indexOf(flag)
      if (index >= 0) {
        consumed.add(index)
        consumed.add(index + 1)
      }
    }
    const positional = rest.filter((arg, index) => !arg.startsWith('-') && !consumed.has(index))
    const root = positional[0]
    if (root === undefined) {
      process.stderr.write(`scan needs a directory\n\n${USAGE}`)
      return 2
    }
    try {
      const result = await scan(root, { top: numberArg('--top', 10), concurrency: numberArg('--concurrency', 4) })
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return 0
      }
      const totals = result.totals
      process.stdout.write(
        `${totals.sessions} sessions${totals.failed > 0 ? ` (${totals.failed} unreadable)` : ''}` +
          ` · ${formatTokens(totals.prompt)} prompt · ${share(totals.carried, totals.prompt)} carried` +
          ` · ${formatTokens(totals.fresh)} fresh · ${totals.cacheMisses} cache misses` +
          ` · ${totals.toolCalls} tool calls\n\n`
      )
      process.stdout.write(`what the corpus says:\n`)
      for (const finding of result.findings) process.stdout.write(`  → ${finding}\n`)
      process.stdout.write('\n')
      const toolRows = result.tools.slice(0, 8).map((tool) => [
        tool.name,
        String(tool.calls),
        formatTokens(tool.resultChars),
        formatTokens(tool.amplifiedTokens),
        share(tool.amplifiedTokens, totals.prompt),
      ])
      process.stdout.write(`${renderGrid(['tool', 'calls', 'chars', 'attributed', 'of prompt'], toolRows, new Set([1]))}\n\n`)
      const sessionRows = result.sessions.slice(0, 8).map((session) => [
        formatTokens(session.prompt),
        share(session.carried, session.prompt),
        String(session.turns),
        String(session.toolCalls),
        String(session.cacheMisses),
        session.cwd,
      ])
      process.stdout.write(`${renderGrid(['prompt', 'carried', 'turns', 'calls', 'miss', 'workspace'], sessionRows, new Set([0, 2, 3, 4]))}\n`)
      if (htmlFile !== undefined) {
        const html = renderScanHtml(result, { root })
        await writeFile(htmlFile, html, 'utf8')
        process.stdout.write(`\n${htmlFile}  (${(html.length / 1024).toFixed(1)} kB)\n`)
      }
      return 0
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
      return 1
    }
  }

  if (command === 'html') {
    const outIndex = rest.findIndex((arg) => arg === '-o' || arg === '--out')
    const outFile = outIndex >= 0 ? rest[outIndex + 1] : undefined
    const diffIndex = rest.indexOf('--diff')
    const diffFile = diffIndex >= 0 ? rest[diffIndex + 1] : undefined
    const consumed = new Set<number>()
    if (outIndex >= 0) {
      consumed.add(outIndex)
      consumed.add(outIndex + 1)
    }
    if (diffIndex >= 0) {
      consumed.add(diffIndex)
      consumed.add(diffIndex + 1)
    }
    const positional = rest.filter((arg, index) => !arg.startsWith('-') && !consumed.has(index))
    const sessionPath = positional[0]
    if (sessionPath === undefined) {
      process.stderr.write(`html needs a session path\n\n${USAGE}`)
      return 2
    }
    try {
      const tape = await readSession(sessionPath)
      const attribution = attributeSession(tape)
      const second = diffFile === undefined ? null : await readSession(diffFile)
      const html = renderHtml(tape, attribution, { diff: second === null ? null : diffTapes(tape, second) })
      const target = outFile ?? 'dsh-trace-report.html'
      await writeFile(target, html, 'utf8')
      process.stdout.write(`${target}  (${(html.length / 1024).toFixed(1)} kB)\n`)
      return 0
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
      return 1
    }
  }

  if (command === 'diff') {
    const [, second] = paths
    if (second === undefined) {
      process.stderr.write(`diff needs two session paths\n\n${USAGE}`)
      return 2
    }
    let left: Tape
    let right: Tape
    try {
      left = await readSession(path!)
      right = await readSession(second)
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
      return 1
    }
    const result = diffTapes(left, right, { limit: numberArg('--limit', 10) })
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`${renderDiff(result)}\n`)
    return 0
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

  if (command === 'report') {
    const attribution = attributeSession(tape)
    if (json) {
      process.stdout.write(`${JSON.stringify(attribution, null, 2)}\n`)
      return 0
    }
    process.stdout.write(
      `${tape.session.id}  ${tape.session.cwd}  schema=v${tape.session.schemaVersion}\n\n`
    )
    process.stdout.write(`${renderReport(tape, attribution, { turns: numberArg('--turns', 10), tools: numberArg('--tools', 10) })}\n`)
    return 0
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

/**
 * Is this module the script the user ran?
 *
 * The naive `import.meta.url === pathToFileURL(process.argv[1])` check is wrong
 * twice over: npm installs the bin as a symlink, and macOS symlinks /tmp to
 * /private/tmp. Both make the two paths differ textually while pointing at the
 * same file, so the CLI would exit silently with status 0. Compare real paths.
 */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return moduleUrl === pathToFileURL(entry).href
  }
}

/** A closed pipe (`| head`) is a normal way to stop a CLI, not a crash. */
function ignoreEpipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  ignoreEpipe(process.stdout)
  ignoreEpipe(process.stderr)
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
