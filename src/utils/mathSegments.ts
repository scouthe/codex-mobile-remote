export type MathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; raw: string; display: boolean }

const MAX_FORMULA_LENGTH = 16_384

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  while (index > 0 && text[--index] === '\\') backslashes += 1
  return backslashes % 2 === 1
}

function readMath(text: string, start: number): Extract<MathSegment, { kind: 'math' }> | null {
  let open: string
  let close: string
  let display = false
  if (text.startsWith('\\(', start)) {
    open = '\\('; close = '\\)'
  } else if (text.startsWith('\\[', start)) {
    open = '\\['; close = '\\]'; display = true
  } else if (text.startsWith('$$', start)) {
    open = close = '$$'; display = true
  } else if (text[start] === '$') {
    open = close = '$'
    if (!text[start + 1] || /\s|\$/u.test(text[start + 1])) return null
  } else {
    return null
  }
  let end = text.indexOf(close, start + open.length)
  while (end >= 0 && end - start <= MAX_FORMULA_LENGTH && isEscaped(text, end)) {
    end = text.indexOf(close, end + close.length)
  }
  if (end < 0 || end - start > MAX_FORMULA_LENGTH) return null
  const value = text.slice(start + open.length, end)
  if (!value.trim() || (!display && value.includes('\n'))) return null
  // Dollar math cannot end in whitespace or immediately precede a digit:
  // "costs $5 and $10" must remain ordinary text.
  if (open === '$' && (/\s/u.test(value[value.length - 1]) || /\d|\$/u.test(text[end + 1] ?? ''))) return null
  return { kind: 'math', value, raw: text.slice(start, end + close.length), display }
}

function skipLink(text: string, start: number): number {
  let labelDepth = 1
  let cursor = start + 1
  for (; cursor < text.length && labelDepth > 0; cursor += 1) {
    if (text[cursor] === '\\') { cursor += 1; continue }
    if (text[cursor] === '[') labelDepth += 1
    if (text[cursor] === ']') labelDepth -= 1
  }
  if (labelDepth || text[cursor] !== '(') return start
  let targetDepth = 1
  for (cursor += 1; cursor < text.length && targetDepth > 0; cursor += 1) {
    if (text[cursor] === '\\') { cursor += 1; continue }
    if (text[cursor] === '(') targetDepth += 1
    if (text[cursor] === ')') targetDepth -= 1
  }
  return targetDepth === 0 ? cursor : start
}

/** Split before Markdown processing, preserving code, link targets and LaTeX markers. */
export function splitMathSegments(text: string, displayOnly = false): MathSegment[] {
  if (!text.includes('$') && !text.includes('\\(') && !text.includes('\\[')) return [{ kind: 'text', value: text }]
  const segments: MathSegment[] = []
  let cursor = 0
  let textStart = 0
  while (cursor < text.length) {
    if (text[cursor] === '`') {
      let length = 1
      while (text[cursor + length] === '`') length += 1
      const end = text.indexOf('`'.repeat(length), cursor + length)
      cursor = end < 0 ? cursor + length : end + length
      continue
    }
    if (text[cursor] === '[') {
      const end = skipLink(text, cursor)
      if (end > cursor) { cursor = end; continue }
    }
    if (text.startsWith('https://', cursor) || text.startsWith('http://', cursor)) {
      while (cursor < text.length && !/\s/u.test(text[cursor])) cursor += 1
      continue
    }
    const math = readMath(text, cursor)
    if (math) {
      if (!displayOnly || math.display) {
        if (cursor > textStart) segments.push({ kind: 'text', value: text.slice(textStart, cursor) })
        segments.push(math)
        textStart = cursor + math.raw.length
      }
      cursor += math.raw.length
      continue
    }
    cursor += text.startsWith('$$', cursor) || text[cursor] === '\\' ? 2 : 1
  }
  if (textStart < text.length) segments.push({ kind: 'text', value: text.slice(textStart) })
  return segments.length ? segments : [{ kind: 'text', value: text }]
}
