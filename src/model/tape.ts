/**
 * The tape is what a session log looks like after it has been made answerable.
 *
 * Raw logs are append-only event streams: thousands of `tool/call`,
 * `assistant/chunk`, `turn/start` lines interleaved with streamed reasoning
 * fragments. Almost nothing in the codebase should have to know that shape —
 * ingest normalizes once into `Tape`, and every report, replay and diff reads
 * the tape instead. If DSH renames an event field, only `normalize.ts` changes.
 */

export interface TapeUsage {
  /**
   * Uncached input tokens — what gets billed at full rate. On providers with
   * prompt caching this is far smaller than the context actually processed.
   */
  inputTokens: number
  outputTokens: number
  /** Context served from the provider's prompt cache; billed cheaper, still re-read. */
  cacheReadTokens: number
}

export interface TapeSession {
  /** `session-<uuid>` as recorded in the header line. */
  id: string
  /** Schema version of the log itself (0, 3, 4 seen in the wild). */
  schemaVersion: number
  createdAt: number
  cwd: string
  agentPreset?: string
  delegationDepth?: number
}

export interface TapeToolCall {
  callId: string
  name: string
  /** Raw JSON string as the model emitted it; parsing is the caller's problem. */
  args: string
  turn: number
  step: number
  at: number
  /** Characters of tool output that went back into the context. */
  resultChars?: number
  isError?: boolean
  resultAt?: number
}

export interface TapeStep {
  turn: number
  step: number
  startAt?: number
  endAt?: number
  usage: TapeUsage
}

export interface TapeTurn {
  turn: number
  startAt?: number
  endAt?: number
  /** Why the turn stopped, when the log says so (`stop`, `max-steps`, ...). */
  reason?: string
  steps: TapeStep[]
  usage: TapeUsage
  /** callIds in emission order — the tape keeps the calls themselves flat. */
  toolCalls: string[]
}

export type TapeMessageKind = 'user' | 'assistant' | 'system'

export interface TapeMessage {
  kind: TapeMessageKind
  turn: number | null
  step: number | null
  text: string
  /** Reasoning that accompanied an assistant message; billed as output tokens. */
  reasoningChars: number
  at: number
}

/**
 * The last `request/header` seen. This is the only place the tape records what
 * the model was actually shown: system prompt size and tool schema count.
 */
export interface TapeContext {
  provider?: string
  model?: string
  contextWindow?: number
  /**
   * Only schema v0 logs carry the assembled system prompt in `request/header`.
   * v4 does not, so this stays absent rather than being guessed — attribution
   * measures the base context from the first request's input tokens instead.
   */
  systemChars?: number
  toolCount: number
  toolDefsChars: number
}

export interface TapeStats {
  events: number
  /** Lines that failed to parse. Never silently dropped — surfaced in reports. */
  skipped: number
  byType: Record<string, number>
}

export interface Tape {
  session: TapeSession
  turns: TapeTurn[]
  toolCalls: TapeToolCall[]
  messages: TapeMessage[]
  context: TapeContext | null
  stats: TapeStats
}

export function emptyUsage(): TapeUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
}

export function addUsage(into: TapeUsage, usage: TapeUsage): void {
  into.inputTokens += usage.inputTokens
  into.outputTokens += usage.outputTokens
  into.cacheReadTokens += usage.cacheReadTokens
}

/**
 * How much context the model actually processed: uncached input plus whatever
 * the cache served. This — not `inputTokens` — is the number that tracks
 * conversation size, and the one attribution must be built on. Using
 * `inputTokens` alone produces phantom jumps of hundreds of thousands of tokens
 * whenever the cache misses, which is how the first version of this report lied.
 */
export function promptTokens(usage: TapeUsage): number {
  return usage.inputTokens + usage.cacheReadTokens
}
