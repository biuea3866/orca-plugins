// Builds the sandboxed panel document: static template + one JSON data block.
// The template never changes between regenerations, so a host that diffs the
// document identity (patched Orca) can keep the iframe and only push data.

import { createHash } from 'node:crypto'

export const PANEL_DATA_ID = 'orca-panel-data'
export const DATA_PLACEHOLDER = '/*__ORCA_SELF_REVIEW_DATA__*/'
const DATA_BLOCK = /<script type="application\/json" id="orca-panel-data">[\s\S]*?<\/script>/g

export function scriptSafeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Replaces `/*__INLINE:<name>__*​/` placeholders with module source (exports stripped). */
export function inlineModules(template, modules) {
  return template.replace(/\/\*__INLINE:([a-zA-Z0-9_-]+)__\*\//g, (match, name) => {
    const source = modules[name]
    if (typeof source !== 'string') throw new Error(`no inline module named ${name}`)
    return source
      .replace(/^export default .*$/gm, '')
      .replace(/^export\s+(const|let|var|function|class)\s/gm, '$1 ')
      .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  })
}

export function buildPanelDocument({ template, data, modules = {} }) {
  if (!template.includes(DATA_PLACEHOLDER)) throw new Error(`panel template is missing the ${DATA_PLACEHOLDER} placeholder`)
  const withModules = inlineModules(template, modules)
  const dataScript = `<script type="application/json" id="${PANEL_DATA_ID}">${scriptSafeJson(data)}</script>`
  // The placeholder sits inside a <script> tag in the template; replace that whole tag with the data block.
  // Function replacer: a string replacement would interpret `$&`/`$'` inside the JSON payload.
  return withModules.replace(new RegExp(`<script>\\s*${DATA_PLACEHOLDER.replace(/[/*]/g, '\\$&')}\\s*</script>`), () => dataScript)
}

/** Hash of the document with the data block blanked out. */
export function panelIdentity(html) {
  return createHash('sha1').update(html.replace(DATA_BLOCK, `<script type="application/json" id="${PANEL_DATA_ID}"></script>`)).digest('hex')
}
