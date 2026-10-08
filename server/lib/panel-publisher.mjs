// Regenerates <pluginRoot>/panel/index.html with embedded data. Orca's dev
// plugin watcher notices the write (300ms debounce) and re-reads the panel.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPanelDocument } from './panel-document.mjs'

export const PANEL_MAX_BYTES = 6 * 1024 * 1024
/** Hard cap for the JSON data block: the patched Orca host rejects panel data above 1MB. */
export const PANEL_DATA_MAX_BYTES = 900 * 1024
export const PANEL_FILE_LINE_CAP = 3000
export const PANEL_LOG_TAIL_BYTES = 16 * 1024

export class PanelPublisher {
  constructor({ pluginRoot, outputRoot = pluginRoot, collect, debounceMs = 150, log = () => {} }) {
    this.pluginRoot = pluginRoot
    this.outputRoot = outputRoot
    this.collect = collect
    this.debounceMs = debounceMs
    this.log = log
    this.timer = null
    this.lastHtml = null
    this.pending = null
    this.writing = Promise.resolve()
  }

  templatePath() { return join(this.pluginRoot, 'panel', 'template.html') }
  outputPath() { return join(this.outputRoot, 'panel.html') }

  readModules() {
    const modules = {}
    for (const name of ['selection', 'threads']) {
      const path = join(this.pluginRoot, 'ui', 'lib', `${name}.mjs`)
      if (existsSync(path)) modules[name] = readFileSync(path, 'utf8')
    }
    return modules
  }

  /** Schedules a regeneration; multiple calls within the debounce window coalesce. */
  schedule(reason = 'change') {
    if (this.timer) clearTimeout(this.timer)
    if (this.debounceMs === 0) return this.flush(reason)
    this.timer = setTimeout(() => { this.timer = null; this.flush(reason).catch((error) => this.log(`panel publish failed: ${error.message}`)) }, this.debounceMs)
    this.timer.unref?.()
    return this.writing
  }

  /** Waits until every scheduled/in-flight publish has been written. */
  async settle() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; await this.flush('settle') }
    await this.writing
  }

  async flush(reason) {
    this.writing = this.writing.then(() => this.publish(reason)).catch((error) => this.log(`panel publish failed: ${error.message}`))
    return this.writing
  }

  async publish(reason) {
    if (!existsSync(this.templatePath())) return false
    const data = await this.collect(reason)
    let html = buildPanelDocument({ template: readFileSync(this.templatePath(), 'utf8'), data, modules: this.readModules() })
    if (Buffer.byteLength(JSON.stringify(data)) > PANEL_DATA_MAX_BYTES) {
      const slimRuns = Object.fromEntries(Object.entries(data.runs ?? {}).map(([id, run]) => [id, { ...run, logTail: '' }]))
      let slim = { ...data, runs: slimRuns }
      if (Buffer.byteLength(JSON.stringify(slim)) > PANEL_DATA_MAX_BYTES) slim = { ...slim, sessions: fitSessionsToBudget(slim.sessions, slim.viewState, { budgetBytes: PANEL_DATA_MAX_BYTES / 2 }) }
      if (Buffer.byteLength(JSON.stringify(slim)) > PANEL_DATA_MAX_BYTES) slim = { ...slim, sessions: {}, oversized: true }
      html = buildPanelDocument({ template: readFileSync(this.templatePath(), 'utf8'), data: slim, modules: this.readModules() })
    }
    if (html === this.lastHtml) return false
    mkdirSync(this.outputRoot, { recursive: true })
    const tmpPath = `${this.outputPath()}.tmp`
    writeFileSync(tmpPath, html)
    renameSync(tmpPath, this.outputPath())
    this.lastHtml = html
    return true
  }
}

/** Trims per-file diff lines so a session fits the panel budget. */
export function trimFilesForPanel(files) {
  return files.map((file) => {
    const total = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    if (total <= PANEL_FILE_LINE_CAP) return file
    return { ...file, hunks: [], truncated: true, panelTruncated: true }
  })
}

/**
 * Keeps full hunks only for as many files as fit the byte budget, prioritising
 * the file the user is viewing and files that carry threads. Trimmed files get
 * `hunks: []` + `panelTruncated: true` so the panel can offer to load them.
 */
export function fitSessionsToBudget(sessions, viewState = {}, { budgetBytes = PANEL_DATA_MAX_BYTES } = {}) {
  const sessionIds = Object.keys(sessions)
  if (sessionIds.length === 0) return {}
  const perSession = Math.floor(budgetBytes / sessionIds.length)
  const result = {}
  for (const id of sessionIds) {
    const entry = sessions[id]
    const files = entry.diff?.files ?? []
    const viewed = viewState[id]?.file ?? null
    const threadPaths = new Set((entry.session?.threads ?? []).map((thread) => thread.path))
    const base = JSON.stringify({ ...entry, diff: { ...entry.diff, files: files.map((file) => ({ ...file, hunks: [] })) } }).length
    let remaining = perSession - base
    const order = [...files.keys()].sort((left, right) => rank(files[left]) - rank(files[right]))
    function rank(file) { return file.path === viewed ? 0 : threadPaths.has(file.path) ? 1 : 2 }
    const keep = new Set()
    for (const index of order) {
      const cost = JSON.stringify(files[index].hunks).length
      if (files[index].path === viewed || cost <= remaining) { keep.add(index); remaining -= cost }
    }
    result[id] = { ...entry, diff: { ...entry.diff, files: files.map((file, index) => keep.has(index) || file.hunks.length === 0 ? file : { ...file, hunks: [], panelTruncated: true }) } }
  }
  return result
}
