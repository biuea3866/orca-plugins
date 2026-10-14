// Fake AI agent CLI used by the integration tests. Reads the prompt from stdin,
// writes it to FAKE_AGENT_PROMPT_OUT, optionally edits a file, optionally sleeps.
// With FAKE_AGENT_ANSWER it behaves like an agent asked to answer review questions: it reads the response code and
// the thread ids from the prompt and prints one answer block per thread.
import { readFileSync, writeFileSync } from 'node:fs'

const prompt = readFileSync(0, 'utf8')
if (process.env.FAKE_AGENT_PROMPT_OUT) writeFileSync(process.env.FAKE_AGENT_PROMPT_OUT, prompt)
process.stdout.write(`fake agent received ${prompt.length} chars\n`)
if (process.env.FAKE_AGENT_ANSWER) {
  const nonce = /응답 코드: (\S+)/.exec(prompt)?.[1]
  const threadIds = [...prompt.matchAll(/### 스레드 \d+ — (thr_[0-9a-f]+)/g)].map((match) => match[1])
  const skip = new Set(String(process.env.FAKE_AGENT_SKIP ?? '').split(',').filter(Boolean))
  for (const id of threadIds) {
    if (skip.has(id)) continue
    process.stdout.write(`@@ANSWER:${id}:${nonce}@@\n답변: ${id} 에 대한 설명입니다.\n둘째 줄\n@@END:${nonce}@@\n`)
  }
}
// A real agent asked to answer questions is read-only, so the fake one edits only for fix prompts.
const answering = prompt.includes('질문 답변 요청')
if (!answering) for (const target of String(process.env.FAKE_AGENT_EDIT ?? '').split(',').filter(Boolean)) writeFileSync(target, 'edited by fake agent\n')
const sleepMs = Number(process.env.FAKE_AGENT_SLEEP_MS ?? 0)
if (sleepMs > 0) {
  setTimeout(() => { process.stdout.write('done after sleep\n'); process.exit(Number(process.env.FAKE_AGENT_EXIT ?? 0)) }, sleepMs)
} else {
  process.exit(Number(process.env.FAKE_AGENT_EXIT ?? 0))
}
