import { describe, expect, it } from 'vitest'
import { readPanelDataDocument } from './plugin-panel-data-document'

const block = (value: unknown): string => `<script type="application/json" id="orca-panel-data">${JSON.stringify(value)}</script>`

describe('panel data documents', () => {
  it('separates data from the document identity', () => {
    const first = readPanelDataDocument('<h1>Panel</h1>' + block({ count: 1 }))
    const next = readPanelDataDocument('<h1>Panel</h1>' + block({ count: 2 }))
    expect(first.identity).toBe(next.identity)
    expect(next.data).toEqual({ count: 2 })
    expect(readPanelDataDocument('<h2>Panel</h2>' + block({ count: 2 })).identity).not.toBe(first.identity)
  })
  it('keeps ordinary plugin documents unchanged', () => {
    expect(readPanelDataDocument('<h1>Panel</h1>')).toEqual({ identity: '<h1>Panel</h1>', data: undefined })
  })
  it('rejects invalid, duplicate and oversized payloads', () => {
    expect(() => readPanelDataDocument('<script type="application/json" id="orca-panel-data">{</script>')).toThrow()
    expect(() => readPanelDataDocument(block(1) + block(2))).toThrow()
    expect(() => readPanelDataDocument(block('a'.repeat(1024 * 1024)))).toThrow()
  })
})
