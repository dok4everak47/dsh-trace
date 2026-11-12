#!/usr/bin/env node
/**
 * Build docs/article.html from docs/article.md.
 *
 * A dev-time script, not part of the package: the article only uses a small
 * subset of Markdown (headings, paragraphs, lists, tables, fenced code, images,
 * bold, inline code), and pulling a parser dependency into a project whose whole
 * pitch is "zero dependencies" for the sake of docs would be silly.
 *
 * Usage: node scripts/build-article.mjs [--embed]
 *   --embed inlines the PNGs as data URIs so the HTML is a single shareable file.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const docs = resolve(here, '..', 'docs')

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function inline(text) {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return out
}

function renderTable(rows) {
  const cells = (row) =>
    row
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
  const header = cells(rows[0])
  const body = rows.slice(2).map(cells)
  const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('')
  const trs = body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('\n')
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${trs}\n</tbody></table>`
}

function render(markdown) {
  const lines = markdown.split('\n')
  const out = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.startsWith('```')) {
      const code = []
      index++
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++])
      index++
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ''))}</h${level}>`)
      index++
      continue
    }

    if (line.startsWith('|') && lines[index + 1]?.startsWith('|')) {
      const rows = []
      while (index < lines.length && lines[index].startsWith('|')) rows.push(lines[index++])
      out.push(renderTable(rows))
      continue
    }

    if (/^[-*]\s/.test(line)) {
      const items = []
      while (index < lines.length && /^[-*]\s/.test(lines[index])) items.push(lines[index++].replace(/^[-*]\s*/, ''))
      out.push(`<ul>\n${items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</ul>`)
      continue
    }

    if (line.startsWith('> ')) {
      const quoted = []
      while (index < lines.length && lines[index].startsWith('> ')) quoted.push(lines[index++].slice(2))
      out.push(`<blockquote>${inline(quoted.join(' '))}</blockquote>`)
      continue
    }

    if (line.trim() === '') {
      index++
      continue
    }

    const paragraph = []
    while (index < lines.length && lines[index].trim() !== '' && !/^(#{1,6}\s|```|\||[-*]\s|> )/.test(lines[index])) {
      paragraph.push(lines[index++])
    }
    out.push(`<p>${inline(paragraph.join(' '))}</p>`)
  }

  return out.join('\n')
}

const STYLE = `
:root { --bg:#0b0d10; --panel:#12151a; --line:#1e232b; --ink:#e7eaee; --muted:#8a939f; --accent:#5eead4; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 64px 28px 96px; max-width: 760px;
  background: var(--bg); color: var(--ink);
  font: 17px/1.75 ui-sans-serif, -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
h1 { font-size: 34px; line-height: 1.25; letter-spacing: -.02em; margin: 0 0 28px; font-weight: 650; }
h2 { font-size: 22px; margin: 48px 0 16px; letter-spacing: -.01em; font-weight: 600; }
h3 { font-size: 18px; margin: 34px 0 12px; color: var(--accent); font-weight: 600; }
p { margin: 0 0 20px; }
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(94,234,212,.3); }
strong { font-weight: 650; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .88em; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; overflow-x: auto; }
pre code { background: none; border: 0; padding: 0; font-size: 13.5px; line-height: 1.6; }
img { width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--line); margin: 8px 0 24px; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 24px; font-size: 15px; }
th { text-align: left; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); padding: 8px 10px 8px 0; }
td { border-bottom: 1px solid #151a21; padding: 8px 10px 8px 0; }
ul { margin: 0 0 20px; padding-left: 22px; }
li { margin: 6px 0; }
blockquote { margin: 0 0 20px; padding: 12px 18px; border-left: 2px solid var(--accent); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 40px 0; }
`

async function embedImages(html, { embed }) {
  if (!embed) return html
  const sources = [...html.matchAll(/src="(\.\/[^"]+)"/g)].map((match) => match[1])
  let output = html
  for (const source of new Set(sources)) {
    const bytes = await readFile(join(docs, source.replace('./', '')))
    output = output.replaceAll(`src="${source}"`, `src="data:image/png;base64,${bytes.toString('base64')}"`)
  }
  return output
}

const markdown = await readFile(join(docs, 'article.md'), 'utf8')
const body = render(markdown)
const embed = process.argv.includes('--embed')
const withImages = await embedImages(body, { embed })
const title = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? 'dsh-trace').trim()

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${withImages}
</body>
</html>
`

await writeFile(join(docs, 'article.html'), html, 'utf8')
process.stdout.write(`docs/article.html  (${(html.length / 1024).toFixed(1)} kB${embed ? ', images embedded' : ''})\n`)
