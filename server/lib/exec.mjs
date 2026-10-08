import { execFile } from 'node:child_process'

/** Promise wrapper around execFile that never rejects on non-zero exit (only on spawn failure). */
export function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) return reject(error)
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
    })
  })
}
