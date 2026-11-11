/**
 * Ingest: compressed event log in, tape out.
 *
 * The log is zstd-compressed JSONL. We never load the whole file into memory —
 * the largest local session decompresses to tens of megabytes and A6 requires a
 * full-corpus run without OOM — so the file is streamed through
 * `createZstdDecompress` and split into lines with `readline`.
 *
 * Decompression uses `node:zlib` (Node >= 23.8). No native dependency, no
 * `zstd` binary at runtime: see AGENTS.md constraint 1.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createZstdDecompress } from 'node:zlib'

import { createTapeBuilder, sessionFromHeader } from '../model/normalize.ts'
import type { RawEvent, TapeBuilder } from '../model/normalize.ts'
import type { Tape } from '../model/tape.ts'

export type LineResult =
  | { ok: true; line: number; event: RawEvent }
  | { ok: false; line: number; error: string }

export async function* readEvents(path: string): AsyncGenerator<LineResult> {
  const raw = createReadStream(path)
  const stream = path.endsWith('.zstd') ? raw.pipe(createZstdDecompress()) : raw
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let line = 0
  try {
    for await (const text of lines) {
      line += 1
      const trimmed = text.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (error) {
        yield { ok: false, line, error: (error as Error).message }
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        yield { ok: false, line, error: 'line is not a JSON object' }
        continue
      }
      yield { ok: true, line, event: parsed as RawEvent }
    }
  } finally {
    lines.close()
    raw.destroy()
  }
}

export interface ReadSessionOptions {
  /** Called for every unparseable line; ingest never throws on bad input. */
  onSkip?: (line: number, error: string) => void
}

export async function readSession(path: string, options: ReadSessionOptions = {}): Promise<Tape> {
  let builder: TapeBuilder | undefined
  /** Events that arrived before the header line. Usually none, occasionally one. */
  const preHeader: RawEvent[] = []
  let skipped = 0

  for await (const result of readEvents(path)) {
    if (!result.ok) {
      skipped += 1
      options.onSkip?.(result.line, result.error)
      continue
    }
    if (builder === undefined) {
      const header = sessionFromHeader(result.event)
      if (header === undefined) {
        preHeader.push(result.event)
        continue
      }
      builder = createTapeBuilder(header)
      for (const queued of preHeader) builder.push(queued)
      preHeader.length = 0
      builder.push(result.event)
      continue
    }
    builder.push(result.event)
  }

  if (builder === undefined) {
    throw new Error(`${path}: no session header line found`)
  }
  return builder.finish({ skipped })
}
