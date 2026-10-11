import katex from 'katex'
import 'katex/dist/katex.min.css'

const rendered = new Map<string, string>()
const CACHE_LIMIT = 200

export function renderMath(value: string, display: boolean): string {
  const key = `${display ? 'block' : 'inline'}\u0000${value}`
  const cached = rendered.get(key)
  if (cached !== undefined) return cached
  const html = katex.renderToString(value, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    maxExpand: 200,
    maxSize: 20,
  })
  rendered.set(key, html)
  if (rendered.size > CACHE_LIMIT) rendered.delete(rendered.keys().next().value!)
  return html
}
