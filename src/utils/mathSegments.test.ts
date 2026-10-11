import { describe, expect, it } from 'vitest'
import { splitMathSegments } from './mathSegments'
import { renderMath } from './mathRenderer'

const formulas = (text: string) => splitMathSegments(text).filter((segment) => segment.kind === 'math')

describe('conversation math delimiters', () => {
  it('preserves LaTeX underscores and multiline matrices before Markdown parses them', () => {
    expect(formulas(String.raw`inline \(x_i^2 + \frac{1}{2}\) and $E=mc^2$
\[
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
\]
$$\sum_{i=1}^n i$$`)).toMatchObject([
      { value: String.raw`x_i^2 + \frac{1}{2}`, display: false },
      { value: 'E=mc^2', display: false },
      { value: String.raw`
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
`, display: true },
      { value: String.raw`\sum_{i=1}^n i`, display: true },
    ])
  })

  it('keeps code, links, escaped dollars, prices and incomplete streamed formulas as text', () => {
    const text = 'code `$x$` and ``\\(y\\)``; [file](/tmp/$x$/a.md) https://example.com/$x$; \\$5, $5 and $10. unfinished \\(x_i'
    expect(formulas(text)).toEqual([])
    expect(splitMathSegments(text)).toEqual([{ kind: 'text', value: text }])
  })

  it('keeps inline source intact when extracting display blocks', () => {
    expect(splitMathSegments('a $x_i$\n\n$$y$$\nend', true)).toEqual([
      { kind: 'text', value: 'a $x_i$\n\n' },
      { kind: 'math', raw: '$$y$$', value: 'y', display: true },
      { kind: 'text', value: '\nend' },
    ])
  })

  it('ignores escaped delimiters and supports pipes inside math', () => {
    expect(formulas(String.raw`\\(no\\) \(\lvert x \rvert\) $|x|$`)).toMatchObject([
      { value: String.raw`\lvert x \rvert` }, { value: '|x|' },
    ])
  })

  it('leaves excessively long formulas as source', () => {
    expect(formulas('$$' + 'x'.repeat(20_000) + '$$')).toEqual([])
  })

  it('does not reinterpret an incomplete display delimiter as inline math', () => {
    expect(formulas('$$x_i$')).toEqual([])
    expect(formulas('$$x_i$$')).toMatchObject([{ value: 'x_i', display: true }])
  })
})

describe('bounded local math renderer', () => {
  it('renders fractions and matrices', () => {
    expect(renderMath(String.raw`\frac{x_i^2}{2}`, false)).toContain('class="katex"')
    expect(renderMath(String.raw`\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}`, true)).toContain('katex-display')
  })

  it('does not allow untrusted HTML links or raw HTML', () => {
    const html = renderMath(String.raw`\href{javascript:alert(1)}{x}`, false)
    expect(html).not.toContain('<a ')
    expect(renderMath('<script>alert(1)</script>', false)).not.toContain('<script>')
  })

  it('handles invalid syntax without interrupting the conversation', () => {
    expect(renderMath(String.raw`\unknowncommand{x}`, false)).toContain('katex')
    expect(renderMath(String.raw`\frac{`, false)).toContain('katex-error')
  })
})
