/**
 * Token attribution: where a session's context budget actually goes.
 *
 * The model that matters here is prompt tokens — uncached input + cache reads —
 * not `inputTokens`. On a cached provider, `inputTokens` is only the *fresh*
 * slice of each request, so treating it as context size produces phantom jumps
 * of hundreds of thousands of tokens the moment the cache misses. The first
 * version of this report did exactly that and blamed `bash` for 557% of the bill.
 *
 * With prompt tokens, each turn decomposes exactly:
 *
 *   Σ prompt_i = prompt_0 + Σ_i>0 (carried_i + fresh_i)
 *   carried_i  = min(prompt_i, prompt_i-1)   ← the same context re-sent
 *   fresh_i    = max(0, prompt_i - prompt_i-1) ← content appended after step i-1
 *
 * `fresh` is then attributed back to what caused it (tool results and the
 * assistant's own message), and multiplied by the number of later steps that
 * re-read it — that product is the real cost of one expensive tool call.
 */

import { promptTokens } from '../model/tape.ts'
import type { Tape, TapeToolCall, TapeTurn } from '../model/tape.ts'

export interface ToolAttribution {
  name: string
  calls: number
  errors: number
  resultChars: number
  /** Fresh prompt tokens this tool's output contributed. */
  freshTokens: number
  /** Fresh tokens × how many later steps re-read them. */
  amplifiedTokens: number
}

export interface TurnAttribution {
  turn: number
  steps: number
  prompt: number
  uncached: number
  carried: number
  fresh: number
  evicted: number
  output: number
  peakPrompt: number
  /** Steps where most of the context was billed uncached — i.e. cache expired. */
  cacheMisses: number
  topTool: { name: string; amplified: number } | null
  /** Fresh tokens this turn's content could not explain. */
  unattributed: number
}

export interface RepeatFinding {
  path: string
  reads: number
  chars: number
  tools: string[]
}

export interface AttributionTotals {
  turns: number
  steps: number
  prompt: number
  uncached: number
  carried: number
  fresh: number
  evicted: number
  output: number
  cacheMisses: number
  peakPrompt: number
  /**
   * Fresh tokens that appended content does not explain — compaction summaries,
   * tool-schema changes, model switches. Reported rather than hidden.
   */
  unattributed: number
}

export interface Calibration {
  /** Median of (prompt delta / appended chars) over usable steps. */
  tokensPerChar: number
  samples: number
}

export interface SessionAttribution {
  totals: AttributionTotals
  calibration: Calibration
  turns: TurnAttribution[]
  tools: ToolAttribution[]
  repeats: RepeatFinding[]
}

/**
 * Steps are noisy individually: a schema change or a compaction summary inflates
 * one prompt without any tool output to blame. So attribution uses one session-wide
 * chars→tokens ratio (median, robust), and whatever a step's content cannot explain
 * is counted as `unattributed` instead of being dumped on a random tool.
 */
function calibrate(tape: Tape, assistantChars: Map<string, number>, callsByStep: Map<string, TapeToolCall[]>): Calibration {
  const samples: number[] = []
  for (const turn of tape.turns) {
    const steps = turn.steps.filter((step) => promptTokens(step.usage) > 0).sort((a, b) => a.step - b.step)
    for (let i = 1; i < steps.length; i++) {
      const delta = promptTokens(steps[i]!.usage) - promptTokens(steps[i - 1]!.usage)
      if (delta <= 0) continue
      const key = `${turn.turn}:${steps[i - 1]!.step}`
      const callChars = (callsByStep.get(key) ?? []).reduce((sum, call) => sum + (call.resultChars ?? 0), 0)
      const chars = callChars + (assistantChars.get(key) ?? 0)
      if (chars < 200) continue
      const ratio = delta / chars
      if (ratio > 0.02 && ratio < 3) samples.push(ratio)
    }
  }
  if (samples.length === 0) return { tokensPerChar: 0.35, samples: 0 }
  samples.sort((a, b) => a - b)
  return { tokensPerChar: samples[Math.floor(samples.length / 2)]!, samples: samples.length }
}

/** Tools whose first argument names a file we can recognise later. */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'read_image', 'notebook_read', 'notebook_edit'])

function filePathOf(call: TapeToolCall): string | undefined {
  if (!PATH_TOOLS.has(call.name)) return undefined
  try {
    const args: unknown = JSON.parse(call.args)
    if (typeof args !== 'object' || args === null) return undefined
    const record = args as Record<string, unknown>
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    return undefined
  }
  return undefined
}

function assistantCharsByStep(tape: Tape): Map<string, number> {
  const map = new Map<string, number>()
  for (const message of tape.messages) {
    if (message.kind !== 'assistant') continue
    if (message.turn === null || message.step === null) continue
    const key = `${message.turn}:${message.step}`
    const chars = message.text.length + message.reasoningChars
    map.set(key, (map.get(key) ?? 0) + chars)
  }
  return map
}

export function attributeSession(tape: Tape): SessionAttribution {
  const callsByStep = new Map<string, TapeToolCall[]>()
  for (const call of tape.toolCalls) {
    const key = `${call.turn}:${call.step}`
    const list = callsByStep.get(key)
    if (list) list.push(call)
    else callsByStep.set(key, [call])
  }
  const assistantChars = assistantCharsByStep(tape)

  const tools = new Map<string, ToolAttribution>()
  const repeatReads = new Map<string, RepeatFinding>()
  const turns: TurnAttribution[] = []

  // Counts come from the call log itself; only the token attribution needs the
  // step walk below. Keeping them separate stops double counting.
  for (const call of tape.toolCalls) {
    const entry = tools.get(call.name) ?? {
      name: call.name,
      calls: 0,
      errors: 0,
      resultChars: 0,
      freshTokens: 0,
      amplifiedTokens: 0,
    }
    entry.calls += 1
    if (call.isError === true) entry.errors += 1
    entry.resultChars += call.resultChars ?? 0
    tools.set(call.name, entry)

    const path = filePathOf(call)
    if (path === undefined) continue
    const existing = repeatReads.get(path) ?? { path, reads: 0, chars: 0, tools: [] }
    existing.reads += 1
    existing.chars += call.resultChars ?? 0
    if (!existing.tools.includes(call.name)) existing.tools.push(call.name)
    repeatReads.set(path, existing)
  }

  const totals: AttributionTotals = {
    turns: 0,
    steps: 0,
    prompt: 0,
    uncached: 0,
    carried: 0,
    fresh: 0,
    evicted: 0,
    output: 0,
    cacheMisses: 0,
    peakPrompt: 0,
    unattributed: 0,
  }

  const calibration = calibrate(tape, assistantChars, callsByStep)

  for (const turn of tape.turns) {
    const steps = turn.steps
      .filter((step) => promptTokens(step.usage) > 0)
      .sort((a, b) => a.step - b.step)
    if (steps.length === 0) continue

    const attribution: TurnAttribution = {
      turn: turn.turn,
      steps: steps.length,
      prompt: 0,
      uncached: 0,
      carried: 0,
      fresh: 0,
      evicted: 0,
      output: 0,
      peakPrompt: 0,
      cacheMisses: 0,
      topTool: null,
      unattributed: 0,
    }
    const perTool = new Map<string, number>()

    for (let i = 0; i < steps.length; i++) {
      const current = steps[i]!
      const prompt = promptTokens(current.usage)
      attribution.prompt += prompt
      attribution.uncached += current.usage.inputTokens
      attribution.output += current.usage.outputTokens
      attribution.peakPrompt = Math.max(attribution.peakPrompt, prompt)
      if (prompt > 20_000 && current.usage.inputTokens > prompt * 0.5) attribution.cacheMisses += 1

      if (i === 0) continue

      const previous = steps[i - 1]!
      const previousPrompt = promptTokens(previous.usage)
      attribution.carried += Math.min(prompt, previousPrompt)
      const delta = prompt - previousPrompt
      if (delta <= 0) {
        attribution.evicted += -delta
        continue
      }
      attribution.fresh += delta

      // Whatever was appended after `previous.step` is what inflated the prompt.
      const key = `${turn.turn}:${previous.step}`
      const calls = callsByStep.get(key) ?? []
      const toolChars = calls.reduce((sum, call) => sum + (call.resultChars ?? 0), 0)
      const messageChars = assistantChars.get(key) ?? 0
      const totalChars = toolChars + messageChars
      if (totalChars === 0) {
        attribution.unattributed += delta
        continue
      }
      const explained = Math.min(delta, totalChars * calibration.tokensPerChar)
      if (delta > explained) attribution.unattributed += delta - explained
      const tokensPerChar = explained / totalChars
      const multiplier = steps.length - i

      for (const call of calls) {
        const entry = tools.get(call.name)
        if (entry === undefined) continue
        const freshTokens = (call.resultChars ?? 0) * tokensPerChar
        const amplified = freshTokens * multiplier
        entry.freshTokens += freshTokens
        entry.amplifiedTokens += amplified
        perTool.set(call.name, (perTool.get(call.name) ?? 0) + amplified)
      }
    }

    if (perTool.size > 0) {
      const [name, amplified] = [...perTool.entries()].sort((a, b) => b[1] - a[1])[0]!
      attribution.topTool = { name, amplified }
    }

    turns.push(attribution)
    totals.turns += 1
    totals.steps += attribution.steps
    totals.prompt += attribution.prompt
    totals.uncached += attribution.uncached
    totals.carried += attribution.carried
    totals.fresh += attribution.fresh
    totals.evicted += attribution.evicted
    totals.output += attribution.output
    totals.cacheMisses += attribution.cacheMisses
    totals.peakPrompt = Math.max(totals.peakPrompt, attribution.peakPrompt)
    totals.unattributed += attribution.unattributed
  }

  turns.sort((a, b) => b.prompt - a.prompt)

  return {
    totals,
    calibration,
    turns,
    tools: [...tools.values()].sort((a, b) => b.amplifiedTokens - a.amplifiedTokens),
    repeats: [...repeatReads.values()]
      .filter((finding) => finding.reads > 1)
      .sort((a, b) => b.chars * b.reads - a.chars * a.reads),
  }
}

export function share(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}
