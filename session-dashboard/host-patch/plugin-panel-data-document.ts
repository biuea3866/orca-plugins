export const PANEL_DATA_TYPE = 'orca-panel-data'
const MAX_DATA_LENGTH = 1024 * 1024
const DATA_BLOCK = /<script type="application\/json" id="orca-panel-data">([\s\S]*?)<\/script>/g

export function readPanelDataDocument(html: string): { identity: string; data: unknown } {
  const matches = [...html.matchAll(DATA_BLOCK)]
  if (matches.length === 0) return { identity: html, data: undefined }
  if (matches.length !== 1) throw new Error('Panel must contain a single data document')
  const payload = matches[0][1]
  if (payload.length > MAX_DATA_LENGTH) throw new Error('Panel data exceeds the size limit')
  const data: unknown = JSON.parse(payload)
  return { identity: html.replace(DATA_BLOCK, '<script type="application/json" id="orca-panel-data"></script>'), data }
}
