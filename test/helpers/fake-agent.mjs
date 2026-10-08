// Fake AI agent CLI used by the integration test. Reads the prompt from stdin,
// writes it to FAKE_AGENT_PROMPT_OUT, optionally edits a file, optionally sleeps.
import { readFileSync, writeFileSync } from 'node:fs'

const prompt = readFileSync(0, 'utf8')
if (process.env.FAKE_AGENT_PROMPT_OUT) writeFileSync(process.env.FAKE_AGENT_PROMPT_OUT, prompt)
process.stdout.write(`fake agent received ${prompt.length} chars\n`)
for (const target of String(process.env.FAKE_AGENT_EDIT ?? '').split(',').filter(Boolean)) writeFileSync(target, 'edited by fake agent\n')
const sleepMs = Number(process.env.FAKE_AGENT_SLEEP_MS ?? 0)
if (sleepMs > 0) {
  setTimeout(() => { process.stdout.write('done after sleep\n'); process.exit(Number(process.env.FAKE_AGENT_EXIT ?? 0)) }, sleepMs)
} else {
  process.exit(Number(process.env.FAKE_AGENT_EXIT ?? 0))
}
