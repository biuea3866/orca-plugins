// PATH resolution for a process that may have been started from a GUI PATH.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, accessSync, constants, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'

const ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

function nvmBinDirs() {
  const root = join(homedir(), '.nvm', 'versions', 'node')
  if (!existsSync(root)) return []
  return readdirSync(root).map((version) => join(root, version, 'bin'))
}

export function candidateDirs() {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...nvmBinDirs(),
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'bin'),
    '/Applications/Orca.app/Contents/Resources/bin',
    '/usr/bin',
    '/bin'
  ].filter((dir) => existsSync(dir))
}

export function loginShellPath(env = process.env) {
  const shell = env.SHELL || '/bin/zsh'
  try {
    const output = execFileSync(shell, ['-lc', 'echo "$PATH"'], { encoding: 'utf8', timeout: 3000, env, stdio: ['ignore', 'pipe', 'ignore'] })
    return output.trim().split('\n').pop() || ''
  } catch {
    return ''
  }
}

/** Builds the PATH the server and its children use; returns it and applies it to env. */
export function enrichPath(env = process.env) {
  const parts = [...loginShellPath(env).split(delimiter), ...String(env.PATH ?? '').split(delimiter), ...candidateDirs()].filter(Boolean)
  const unique = [...new Set(parts)]
  env.PATH = unique.join(delimiter)
  return env.PATH
}

export function resolveBin(name, env = process.env) {
  if (name === 'orca' && existsSync(ORCA_CLI)) return ORCA_CLI
  if (name.includes('/')) return existsSync(name) ? name : null
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name)
    if (dir && existsSync(candidate)) return candidate
  }
  return null
}

/** Vendor CLI only: never use Orca's LLM-router shims. */
export function resolveLocalAgent(name,{env=process.env,directories=candidateDirs()}={}) {
  if(!['claude','codex'].includes(name))return null
  const explicit=env[`ORCA_SELF_REVIEW_${name.toUpperCase()}_BIN`]
  const candidates=explicit?[explicit]:[...String(env.PATH??'').split(delimiter),...directories].filter(Boolean).map(dir=>join(dir,name))
  for(const file of candidates){
    try{
      const resolved=realpathSync(file)
      if(/[\/]\.orca[\/]bin[\/]/.test(file)||/[\/]\.orca[\/]bin[\/]/.test(resolved))continue
      accessSync(resolved,constants.X_OK)
      const buffer=Buffer.alloc(4096),fd=openSync(resolved,'r');let size;try{size=readSync(fd,buffer,0,buffer.length,0)}finally{closeSync(fd)};const prefix=buffer.subarray(0,size).toString('utf8')
      if(prefix.startsWith('#!')&&/llm_router|llm-router/.test(prefix))continue
      return resolved
    }catch{/* next installation */}
  }
  return null
}
