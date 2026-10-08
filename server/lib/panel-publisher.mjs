// Regenerates <pluginRoot>/panel/index.html with embedded data. Orca's dev
// plugin watcher notices the write (300ms debounce) and re-reads the panel.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPanelDocument } from './panel-document.mjs'

export const PANEL_MAX_BYTES = 6 * 1024 * 1024
export const PANEL_FILE_LINE_CAP = 3000
export const PANEL_LOG_TAIL_BYTES = 16 * 1024

export class PanelPublisher {
  constructor({ pluginRoot, collect, debounceMs = 150, log = () => {} }) {
    this.pluginRoot = pluginRoot
    this.collect = collect
    this.debounceMs = debounceMs
    this.log = log
    this.timer = null
    this.lastHtml = null
    this.pending = null
    this.writing = Promise.resolve()
  }

  templatePath() { return join(this.pluginRoot, 'panel', 'template.html') }
  outputPath() { return join(this.pluginRoot, 'panel', 'index.html') }

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
    if (Buffer.byteLength(html) > PANEL_MAX_BYTES) {
      html = buildPanelDocument({ template: readFileSync(this.templatePath(), 'utf8'), data: { ...data, sessions: {}, oversized: true }, modules: this.readModules() })
    }
    if (html === this.lastHtml) return false
    mkdirSync(join(this.pluginRoot, 'panel'), { recursive: true })
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
