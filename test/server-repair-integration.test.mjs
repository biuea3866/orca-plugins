import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'helpers', 'fake-agent.mjs')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const branch = 'feat/GRT-1-repair'
const servers = []
after(async () => { for (const server of servers) await server.close() })

// A Gradle build whose wrapper is a script: detekt and test fail while Foo.kt still says BAD (or `.always-fail` exists).
function fixture({ alwaysFail = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sr-repair-')))
  const remote = join(root, 'remote.git'), work = join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'clone', '-q', remote, work)
  git(work, 'config', 'user.name', 't'); git(work, 'config', 'user.email', 't@t')
  mkdirSync(join(work, 'mod/src'), { recursive: true }); mkdirSync(join(work, 'other'), { recursive: true })
  writeFileSync(join(work, 'settings.gradle.kts'), 'include(":mod")\n')
  writeFileSync(join(work, 'mod/build.gradle.kts'), '\n')
  writeFileSync(join(work, 'mod/src/Foo.kt'), 'val ok = 1\n')
  writeFileSync(join(work, 'other/Bar.txt'), 'bar\n')
  writeFileSync(join(work, 'gradlew'), '#!/bin/sh\nif grep -q BAD mod/src/Foo.kt || [ -e .always-fail ]; then echo "Foo.kt:1 BAD rule violated" >&2; exit 1; fi\necho "BUILD SUCCESSFUL"\n')
  chmodSync(join(work, 'gradlew'), 0o755)
  if (alwaysFail) writeFileSync(join(work, '.always-fail'), '')
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'init')
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  git(work, 'checkout', '-q', '-b', branch); git(work, 'push', '-q', '-u', 'origin', branch)
  return { root, remote, work }
}

async function boot(work, env) {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-rplugin-'))
  mkdirSync(join(pluginRoot, 'panel'), { recursive: true }); mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
  writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
  const runners = { exec: async (command, args, options) => {
    if (command.endsWith('git') || command.endsWith('gradlew')) return execCommand(command, args, options)
    return { stdout: JSON.stringify({ ok: true, result: { repos: [], worktrees: [], terminals: [] } }), stderr: '', code: 0 }
  } }
  const agentCommands = { claude: { command: process.execPath, args: [fakeAgent], answerArgs: [fakeAgent], env }, codex: { command: process.execPath, args: [fakeAgent], env } }
  const server = createServer({ homeDir: mkdtempSync(join(tmpdir(), 'sr-rhome-')), pluginRoot, runners, agentCommands, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0, repairPollMs: 30, repairTimeoutMs: 20_000 })
  await server.listen(); servers.push(server)
  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { 'X-SR-Token': server.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  const created = await api('POST', '/api/sessions', { kind: 'local', repoPath: work, baseRef: 'main' })
  return { api, sessionId: created.body.id }
}

async function publishBroken(work, api, sessionId, file = 'mod/src/Foo.kt') {
  writeFileSync(join(work, file), 'val bad = BAD\n')
  const preview = await api('GET', `/api/sessions/${sessionId}/publish-preview`)
  assert.equal(preview.status, 200)
  return api('POST', `/api/sessions/${sessionId}/publish`, { snapshot: preview.body.snapshot, paths: [file], message: preview.body.message })
}

test('a failed check is repaired by an AI run, verified again and then committed and pushed', async () => {
  const { remote, work, root } = fixture()
  const promptOut = join(root, 'prompt.md')
  const { api, sessionId } = await boot(work, { FAKE_AGENT_EDIT: join(work, 'mod/src/Foo.kt'), FAKE_AGENT_PROMPT_OUT: promptOut })
  const published = await publishBroken(work, api, sessionId)
  assert.equal(published.status, 200, JSON.stringify(published.body))
  assert.equal(published.body.repairs.length, 1)
  assert.deepEqual(published.body.repairs[0].changedFiles, ['mod/src/Foo.kt'])
  assert.equal(published.body.repairs[0].failedStep.kind, 'detekt')
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), published.body.commit, 'the repaired state was pushed')
  assert.equal(git(work, 'show', `${published.body.commit}:mod/src/Foo.kt`), 'edited by fake agent', 'the committed file is the repaired one that passed the checks')
  const prompt = readFileSync(promptOut, 'utf8')
  assert.match(prompt, /검증 실패 수정 요청/); assert.match(prompt, /Foo\.kt:1 BAD rule violated/); assert.match(prompt, /- mod\b/)
  const runs = (await api('GET', `/api/sessions/${sessionId}/runs`)).body.runs
  assert.ok(runs.some((run) => run.id === published.body.repairs[0].runId && run.repair === true), 'the repair run is kept in the history')
  const checks = (await api('GET', `/api/sessions/${sessionId}/publish-checks`)).body.checks
  assert.equal(checks.status, 'passed')
})

test('a repair that edits files outside the failed module stops the publication and pushes nothing', async () => {
  const { remote, work } = fixture()
  const before = git(remote, 'rev-parse', `refs/heads/${branch}`)
  const { api, sessionId } = await boot(work, { FAKE_AGENT_EDIT: join(work, 'other/Bar.txt') })
  const published = await publishBroken(work, api, sessionId)
  assert.equal(published.status, 409)
  assert.equal(published.body.error.code, 'repair_out_of_scope')
  assert.match(published.body.error.message, /other\/Bar\.txt/)
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), before)
  assert.equal(git(work, 'rev-parse', 'HEAD'), before, 'nothing was committed')
})

test('a repair that changes nothing stops instead of repeating the same failure', async () => {
  const { remote, work } = fixture()
  const before = git(remote, 'rev-parse', `refs/heads/${branch}`)
  const { api, sessionId } = await boot(work, {})
  const published = await publishBroken(work, api, sessionId)
  assert.equal(published.status, 409)
  assert.equal(published.body.error.code, 'repair_no_change')
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), before)
})

test('when the checks keep failing the publication stops after two repair rounds with the repairs that were tried', async () => {
  const { remote, work } = fixture({ alwaysFail: true })
  const before = git(remote, 'rev-parse', `refs/heads/${branch}`)
  const { api, sessionId } = await boot(work, { FAKE_AGENT_EDIT: join(work, 'mod/src/Foo.kt'), FAKE_AGENT_APPEND: '1' })
  const published = await publishBroken(work, api, sessionId)
  assert.equal(published.status, 400)
  assert.equal(published.body.error.code, 'pre_publish_checks_failed')
  assert.equal(published.body.error.repairs.length, 2)
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), before)
  assert.equal(git(work, 'rev-parse', 'HEAD'), before, 'nothing was committed')
})

test('the repair progress is visible in the checks state while it runs', async () => {
  const { work } = fixture()
  const { api, sessionId } = await boot(work, { FAKE_AGENT_EDIT: join(work, 'mod/src/Foo.kt'), FAKE_AGENT_SLEEP_MS: '600' })
  const pending = publishBroken(work, api, sessionId)
  let seen = null
  for (let attempt = 0; attempt < 80 && !seen; attempt += 1) {
    const checks = (await api('GET', `/api/sessions/${sessionId}/publish-checks`)).body.checks
    if (checks?.repair?.active) seen = checks.repair
    else await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(seen, 'a polling UI sees the repair')
  assert.equal(seen.round, 1); assert.equal(seen.max, 2); assert.ok(seen.runId)
  assert.equal((await pending).status, 200)
  const done = (await api('GET', `/api/sessions/${sessionId}/publish-checks`)).body.checks
  assert.equal(done.repair.active, false)
  assert.equal(done.repair.rounds.length, 1)
})
