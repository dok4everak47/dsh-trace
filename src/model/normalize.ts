/**
 * The only module allowed to know the raw event shape.
 *
 * Everything here is defensive on purpose: session logs are untrusted input
 * written by a host that ships new event types every few days. Unknown types are
 * counted and ignored; malformed fields degrade to "absent" rather than throw.
 */

import type {
  Tape,
  TapeContext,
  TapeMessage,
  TapeMessageKind,
  TapeSession,
  TapeStep,
  TapeToolCall,
  TapeTurn,
  TapeUsage,
} from './tape.ts'
import { addUsage, emptyUsage } from './tape.ts'

export type RawEvent = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function eventTime(event: RawEvent, fallback: number): number {
  return asNumber(event['time']) ?? asNumber(event['time0']) ?? fallback
}

function usageFrom(value: unknown): TapeUsage | undefined {
  const rec = asRecord(value)
  if (!rec) return undefined
  const inputTokens = asNumber(rec['inputTokens'])
  const outputTokens = asNumber(rec['outputTokens'])
  const cacheReadTokens = asNumber(rec['cacheReadTokens'])
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined) return undefined
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
  }
}

/** Concatenates the `text` parts of a message content array. */
function textOf(content: unknown): { text: string; reasoningChars: number } {
  const parts: string[] = []
  let reasoningChars = 0
  for (const item of asArray(content)) {
    const rec = asRecord(item)
    if (!rec) continue
    const text = asString(rec['text'])
    if (text === undefined) continue
    if (rec['type'] === 'reasoning') reasoningChars += text.length
    else if (rec['type'] === 'text') parts.push(text)
  }
  return { text: parts.join('\n'), reasoningChars }
}

/** Characters of tool output that were fed back into the context. */
function toolResultChars(content: unknown): number {
  let chars = 0
  for (const item of asArray(content)) {
    const rec = asRecord(item)
    if (!rec) continue
    // v4 puts the text on the item itself; v0 nests it under `content`.
    chars += asString(rec['text'])?.length ?? 0
    const inner = rec['content']
    if (typeof inner === 'string') chars += inner.length
    for (const nested of asArray(inner)) {
      const part = asRecord(nested)
      if (!part) continue
      chars += asString(part['text'])?.length ?? 0
    }
  }
  return chars
}

export interface TapeBuilder {
  push(event: RawEvent): void
  finish(options?: { skipped?: number }): Tape
}

export function createTapeBuilder(session: TapeSession): TapeBuilder {
  const turns = new Map<number, TapeTurn>()
  const toolCalls: TapeToolCall[] = []
  const callsById = new Map<string, TapeToolCall>()
  const messages: TapeMessage[] = []
  const byType: Record<string, number> = {}
  let context: TapeContext | null = null
  let events = 0
  let lastTime = session.createdAt

  function ensureTurn(turn: number, at: number): TapeTurn {
    const existing = turns.get(turn)
    if (existing) return existing
    const created: TapeTurn = { turn, startAt: at, steps: [], usage: emptyUsage(), toolCalls: [] }
    turns.set(turn, created)
    return created
  }

  function applyUsage(turn: number, step: number, usage: TapeUsage, mode: 'accumulate' | 'set-if-empty'): void {
    const target = ensureStep(turn, step)
    if (mode === 'accumulate') {
      addUsage(target.usage, usage)
      return
    }
    // The assembled step and the streamed chunks describe the same request;
    // do not count both.
    if (target.usage.inputTokens === 0 && target.usage.outputTokens === 0) addUsage(target.usage, usage)
  }

  function ensureStep(turn: number, step: number): TapeStep {
    const owner = ensureTurn(turn, lastTime)
    const existing = owner.steps.find((candidate) => candidate.step === step)
    if (existing) return existing
    const created: TapeStep = { turn, step, usage: emptyUsage() }
    owner.steps.push(created)
    return created
  }

  function ensureCall(
    callId: string,
    name: string,
    args: string,
    turn: number,
    step: number,
    at: number
  ): TapeToolCall {
    const existing = callsById.get(callId)
    if (existing) return existing
    const created: TapeToolCall = { callId, name, args, turn, step, at }
    callsById.set(callId, created)
    toolCalls.push(created)
    const owner = ensureTurn(turn, at)
    owner.toolCalls.push(callId)
    return created
  }

  function addMessage(kind: TapeMessageKind, text: string, reasoningChars: number, turn: number | null, step: number | null, at: number): void {
    // Streamed chunks carry no text here; only the assembled message does.
    if (text.length === 0 && reasoningChars === 0) return
    messages.push({ kind, turn, step, text, reasoningChars, at })
  }

  function push(event: RawEvent): void {
    events += 1
    const type = asString(event['type'])
    if (type === undefined) return
    byType[type] = (byType[type] ?? 0) + 1
    const at = eventTime(event, lastTime)
    lastTime = at
    const data = asRecord(event['data']) ?? {}
    const turn = asNumber(data['turn'])
    const step = asNumber(data['step'])

    switch (type) {
      case 'turn/start': {
        if (turn === undefined) return
        ensureTurn(turn, at).startAt = at
        return
      }
      case 'turn/end': {
        if (turn === undefined) return
        const owner = ensureTurn(turn, at)
        owner.endAt = at
        const reason = asString(data['reason'])
        if (reason !== undefined) owner.reason = reason
        return
      }
      case 'step/start': {
        if (turn === undefined || step === undefined) return
        ensureStep(turn, step).startAt = at
        return
      }
      case 'step/end': {
        if (turn === undefined || step === undefined) return
        const target = ensureStep(turn, step)
        target.endAt = at
        const usage = usageFrom(data['usage'])
        if (usage) applyUsage(turn, step, usage, 'set-if-empty')
        return
      }
      case 'assistant/chunk': {
        const chunk = asRecord(data['chunk'])
        if (chunk?.['type'] !== 'usage') return
        if (turn === undefined || step === undefined) return
        const usage = usageFrom(chunk['usage'])
        if (usage) addUsage(ensureStep(turn, step).usage, usage)
        return
      }
      case 'assistant/message': {
        const message = asRecord(data['message'])
        if (!message) return
        const usage = usageFrom(data['usage'])
        if (usage && turn !== undefined && step !== undefined) applyUsage(turn, step, usage, 'set-if-empty')
        const { text, reasoningChars } = textOf(message['content'])
        addMessage('assistant', text, reasoningChars, turn ?? null, step ?? null, at)
        // Older logs only carry tool calls inside the assembled message.
        for (const item of asArray(message['content'])) {
          const part = asRecord(item)
          if (part?.['type'] !== 'tool-call') continue
          const callId = asString(part['id'])
          const name = asString(part['name'])
          if (callId === undefined || name === undefined) continue
          ensureCall(callId, name, asString(part['arguments']) ?? '', turn ?? 0, step ?? 0, at)
        }
        return
      }
      case 'user/message':
      case 'system/message': {
        const message = asRecord(data['message']) ?? data
        const { text } = textOf(message['content'])
        const kind: TapeMessageKind = type === 'user/message' ? 'user' : 'system'
        addMessage(kind, text, 0, turn ?? null, step ?? null, at)
        return
      }
      case 'tool/call': {
        const callId = asString(data['callId'])
        const name = asString(data['name'])
        if (callId === undefined || name === undefined) return
        ensureCall(callId, name, asString(data['arguments']) ?? '', turn ?? 0, step ?? 0, at)
        return
      }
      case 'tool/result': {
        const message = asRecord(data['message'])
        if (!message) return
        const source = asRecord(message['source'])
        const firstPart = asRecord(asArray(message['content'])[0])
        const callId = asString(source?.['callId']) ?? asString(firstPart?.['toolCallId'])
        if (callId === undefined) return
        const call = callsById.get(callId)
        if (!call) return
        call.resultChars = toolResultChars(message['content'])
        call.resultAt = at
        call.isError = firstPart?.['isError'] === true || data['error'] !== undefined
        return
      }
      case 'request/header': {
        const header = asRecord(data['header'])
        if (!header) return
        const config = asRecord(header['config'])
        const tools = asArray(header['tools'])
        let toolDefsChars = 0
        for (const tool of tools) toolDefsChars += JSON.stringify(tool ?? {}).length
        const next: TapeContext = {
          toolCount: tools.length,
          toolDefsChars,
        }
        const system = asString(header['system'])
        if (system !== undefined) next.systemChars = system.length
        const provider = asString(config?.['provider'])
        const model = asString(config?.['model'])
        if (provider !== undefined) next.provider = provider
        if (model !== undefined) next.model = model
        context = context === null ? next : { ...context, ...next }
        return
      }
      case 'request/context': {
        const provider = asString(data['provider'])
        const model = asString(data['model'])
        const contextWindow = asNumber(data['contextWindow'])
        const base: TapeContext = context ?? { toolCount: 0, toolDefsChars: 0 }
        if (provider !== undefined) base.provider = provider
        if (model !== undefined) base.model = model
        if (contextWindow !== undefined) base.contextWindow = contextWindow
        context = base
        return
      }
      default:
        return
    }
  }

  function finish(options?: { skipped?: number }): Tape {
    const orderedTurns = [...turns.values()].sort((a, b) => a.turn - b.turn)
    for (const turn of orderedTurns) {
      turn.steps.sort((a, b) => a.step - b.step)
      for (const step of turn.steps) addUsage(turn.usage, step.usage)
    }
    return {
      session,
      turns: orderedTurns,
      toolCalls,
      messages,
      context,
      stats: { events, skipped: options?.skipped ?? 0, byType },
    }
  }

  return { push, finish }
}

export function sessionFromHeader(event: RawEvent): TapeSession | undefined {
  if (asString(event['type']) !== 'session') return undefined
  const id = asString(event['id'])
  const cwd = asString(event['cwd'])
  const createdAt = asNumber(event['createdAt'])
  const schemaVersion = asNumber(event['version'])
  if (id === undefined || cwd === undefined || createdAt === undefined || schemaVersion === undefined) return undefined
  const session: TapeSession = { id, cwd, createdAt, schemaVersion }
  const agentPreset = asString(event['agentPreset'])
  const delegationDepth = asNumber(event['delegationDepth'])
  if (agentPreset !== undefined) session.agentPreset = agentPreset
  if (delegationDepth !== undefined) session.delegationDepth = delegationDepth
  return session
}
