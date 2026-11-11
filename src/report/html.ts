/**
 * Self-contained HTML report.
 *
 * Constraints that shape this file: one file, zero external requests, readable
 * offline, and good enough as a screenshot — because that screenshot is how the
 * project gets seen. No charting library: bars are divs with percentage widths,
 * so the page renders identically in a fresh browser with no network.
 */

import { homedir } from 'node:os'

import type { Tape } from '../model/tape.ts'
import type { SessionAttribution, TurnAttribution } from './attribute.ts'
import { formatTokens, share } from './attribute.ts'
import type { DiffResult } from './diff.ts'

export interface HtmlOptions {
  title?: string
  diff?: DiffResult | null
  generatedAt?: Date
  /** Cap the number of turn rows drawn; the rest are summarised. */
  maxTurns?: number
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const STYLE = `
:root {
  --bg: #0b0d10;
  --panel: #12151a;
  --line: #1e232b;
  --ink: #e7eaee;
  --muted: #8a939f;
  --bar: #5b6779;
  --dim: #2b323c;
  --accent: #5eead4;
  --warn: #f5a524;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); }
body {
  font: 14px/1.5 ui-sans-serif, -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
  padding: 48px 56px 72px;
  max-width: 1180px;
  margin: 0 auto;
}
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; margin-bottom: 4px; }
.wordmark { font-size: 13px; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); }
.session { color: var(--muted); font-size: 12.5px; }
h1 { font-size: 26px; line-height: 1.25; margin: 18px 0 6px; font-weight: 600; letter-spacing: -.01em; }
.sub { color: var(--muted); font-size: 13px; }
.takeaway { margin: 22px 0 0; color: #c8d0da; font-size: 15px; line-height: 1.55; max-width: 860px; }
.takeaway b { color: var(--accent); font-weight: 600; }
section { margin-top: 40px; }
h2 { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin: 0 0 16px; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 28px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
.stat .k { color: var(--muted); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; }
.stat .v { font-size: 26px; margin-top: 6px; letter-spacing: -.02em; }
.stat .n { color: var(--muted); font-size: 12px; margin-top: 2px; }
.row { display: grid; grid-template-columns: 92px 1fr 150px; gap: 16px; align-items: center; padding: 5px 0; }
.row .label { color: var(--muted); font-size: 12px; }
.track { position: relative; height: 18px; background: #10141a; box-shadow: inset 0 0 0 1px #171d26; border-radius: 4px; overflow: hidden; }
.fill { position: absolute; top: 0; bottom: 0; }
.fill.carried { background: var(--bar); }
.fill.fresh { background: var(--accent); }
.row .value { text-align: right; font-size: 12px; color: var(--ink); white-space: nowrap; }
.miss { color: var(--warn); }
.legend { display: flex; gap: 18px; color: var(--muted); font-size: 12px; margin-top: 14px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); padding: 8px 10px 8px 0; }
td { border-bottom: 1px solid #151a21; padding: 7px 10px 7px 0; vertical-align: top; }
td.tools { white-space: nowrap; color: var(--muted); }
td.num, th.num { text-align: right; }
.path { color: var(--muted); word-break: break-all; }
.diffgrid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.diffcard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.diffcard .k { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; }
.diffcard .v { font-size: 20px; margin-top: 4px; }
.call { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-top: 12px; font-size: 12.5px; }
.call .side { color: var(--muted); }
footer { margin-top: 56px; color: #5c6572; font-size: 11.5px; display: flex; justify-content: space-between; gap: 20px; }
`

function barRow(label: string, total: number, carried: number, fresh: number, max: number, right: string, titleText: string): string {
  const totalWidth = max === 0 ? 0 : Math.max(0.8, (total / max) * 100)
  const carriedShare = total === 0 ? 0 : Math.min(1, carried / total)
  const carriedWidth = totalWidth * carriedShare
  const freshWidth = Math.max(0, totalWidth - carriedWidth)
  return `<div class="row" title="${escapeHtml(titleText)}">
  <div class="label mono">${escapeHtml(label)}</div>
  <div class="track"><div class="fill carried" style="width:${carriedWidth.toFixed(2)}%"></div><div class="fill fresh" style="left:${carriedWidth.toFixed(2)}%;width:${freshWidth.toFixed(2)}%"></div></div>
  <div class="value mono">${right}</div>
</div>`
}

function statCard(key: string, value: string, note: string): string {
  return `<div class="stat"><div class="k">${escapeHtml(key)}</div><div class="v mono">${escapeHtml(value)}</div><div class="n">${escapeHtml(note)}</div></div>`
}

/** Reports get shared; nobody else needs to know where the home directory lives. */
function redactor(): (value: string) => string {
  const home = homedir()
  if (home.length === 0) return (value) => value
  return (value) => value.split(home).join('~')
}

export function renderHtml(tape: Tape, attribution: SessionAttribution, options: HtmlOptions = {}): string {
  const redact = redactor()
  const totals = attribution.totals
  const generatedAt = options.generatedAt ?? new Date()
  const byTurn = new Map<number, TurnAttribution>()
  for (const turn of attribution.turns) byTurn.set(turn.turn, turn)

  const chronological = tape.turns.filter((turn) => turn.steps.length > 0)
  const maxPrompt = Math.max(1, ...chronological.map((turn) => byTurn.get(turn.turn)?.prompt ?? 0))
  const maxTurns = options.maxTurns ?? 120
  const drawn = chronological.slice(0, maxTurns)

  const turnRows = drawn
    .map((turn) => {
      const attributionOfTurn = byTurn.get(turn.turn)
      if (attributionOfTurn === undefined) return ''
      const title = `turn ${turn.turn} · ${attributionOfTurn.steps} steps · prompt ${formatTokens(attributionOfTurn.prompt)} · carried ${formatTokens(attributionOfTurn.carried)} · fresh ${formatTokens(attributionOfTurn.fresh)} · ${attributionOfTurn.cacheMisses} cache miss`
      const right = attributionOfTurn.cacheMisses > 0
        ? `<span class="miss">${formatTokens(attributionOfTurn.prompt)} · ${attributionOfTurn.cacheMisses} miss</span>`
        : formatTokens(attributionOfTurn.prompt)
      return barRow(`t${turn.turn}`, attributionOfTurn.prompt, attributionOfTurn.carried, attributionOfTurn.fresh, maxPrompt, right, title)
    })
    .join('')

  const maxTool = Math.max(1, ...attribution.tools.map((tool) => tool.amplifiedTokens))
  const toolRows = attribution.tools
    .slice(0, 10)
    .map((tool) =>
      barRow(
        tool.name,
        tool.amplifiedTokens,
        Math.max(0, tool.amplifiedTokens - tool.freshTokens),
        tool.freshTokens,
        maxTool,
        `${formatTokens(tool.amplifiedTokens)} · ${share(tool.amplifiedTokens, totals.prompt)}`,
        `${tool.name}: ${tool.calls} calls, ${formatTokens(tool.resultChars)} chars of output, ${formatTokens(tool.amplifiedTokens)} prompt tokens (×${(tool.amplifiedTokens / Math.max(1, tool.freshTokens)).toFixed(1)} re-read)`
      )
    )
    .join('')

  const repeatRows = attribution.repeats
    .slice(0, 8)
    .map(
      (repeat) => `<tr><td class="mono num">${repeat.reads}×</td><td class="mono num">${formatTokens(repeat.chars)}</td><td class="tools mono">${escapeHtml(repeat.tools.join(' · '))}</td><td class="path mono">${escapeHtml(redact(repeat.path))}</td></tr>`
    )
    .join('')

  const diffSection = options.diff
    ? `<section>
  <h2>Diff · ${escapeHtml(options.diff.a.id)} vs ${escapeHtml(options.diff.b.id)}</h2>
  <div class="diffgrid">
    <div class="diffcard"><div class="k">matched</div><div class="v mono">${options.diff.matched}</div></div>
    <div class="diffcard"><div class="k">identical</div><div class="v mono">${options.diff.identical}</div></div>
    <div class="diffcard"><div class="k">drifted</div><div class="v mono">${options.diff.matched - options.diff.identical}</div></div>
    <div class="diffcard"><div class="k">a-only</div><div class="v mono">${options.diff.aOnly}</div></div>
    <div class="diffcard"><div class="k">b-only</div><div class="v mono">${options.diff.bOnly}</div></div>
  </div>
  ${
    options.diff.firstStructural === null
      ? '<div class="call"><span class="side">tool sequences agree</span></div>'
      : `<div class="call"><span class="side">first structural divergence at call #${options.diff.firstStructural.type === 'b-only' ? options.diff.firstStructural.b.index : (options.diff.firstStructural as { a: { index: number } }).a.index}</span></div>`
  }
</section>`
    : ''

  const model = tape.context?.model === undefined ? 'unknown model' : `${tape.context.provider ?? '?'}/${tape.context.model}`
  const started = new Date(tape.session.createdAt).toISOString().replace('T', ' ').slice(0, 19)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title ?? `dsh-trace · ${tape.session.id}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="wordmark">dsh-trace</div>
  <div class="session mono">schema v${tape.session.schemaVersion} · ${escapeHtml(model)}</div>
</header>
<h1>${escapeHtml(redact(tape.session.cwd) || tape.session.id)}</h1>
<div class="sub mono">${escapeHtml(tape.session.id)} · started ${escapeHtml(started)} · ${totals.turns} turns · ${totals.steps} steps</div>

<div class="stats">
  ${statCard('prompt tokens', formatTokens(totals.prompt), `${formatTokens(totals.uncached)} billed uncached`)}
  ${statCard('carried', share(totals.carried, totals.prompt), 'context re-sent')}
  ${statCard('fresh', share(totals.fresh, totals.prompt), `${formatTokens(totals.fresh)} tokens of new content`)}
  ${statCard('cache misses', String(totals.cacheMisses), `peak context ${formatTokens(totals.peakPrompt)}`)}
</div>

<p class="takeaway"><b>${share(totals.carried, totals.prompt)}</b> of everything the model processed was context it had already seen; <b>${share(totals.fresh, totals.prompt)}</b> was new content — ${formatTokens(totals.fresh)} tokens against ${formatTokens(totals.prompt)} re-read.</p>

<section>
  <h2>Context by turn</h2>
  ${turnRows}
  ${chronological.length > drawn.length ? `<div class="sub" style="margin-top:10px">+${chronological.length - drawn.length} more turns not drawn</div>` : ''}
  <div class="legend">
    <span><span class="swatch" style="background:var(--dim)"></span>carried — the same context, re-sent</span>
    <span><span class="swatch" style="background:var(--accent)"></span>fresh — content added this turn</span>
  </div>
</section>

<section>
  <h2>Cost by tool · prompt tokens attributable, including re-reads</h2>
  ${toolRows}
</section>

${
  attribution.repeats.length === 0
    ? ''
    : `<section>
  <h2>Repeated reads · same file, more than once</h2>
  <table>
    <thead><tr><th class="num">reads</th><th class="num">chars</th><th>tools</th><th>path</th></tr></thead>
    <tbody>${repeatRows}</tbody>
  </table>
</section>`
}
${diffSection}
<footer>
  <span>generated ${escapeHtml(generatedAt.toISOString().replace('T', ' ').slice(0, 19))} · chars→tokens ${attribution.calibration.tokensPerChar.toFixed(2)} (n=${attribution.calibration.samples}) · ${formatTokens(totals.unattributed)} unattributed</span>
  <span>offline, single file, no dependencies</span>
</footer>
</body>
</html>`
}
