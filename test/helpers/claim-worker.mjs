// A process that races the others for a run's finish claim: it waits for the go-file of each trial, then claims.
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RunManager } from '../../server/lib/runs.mjs'

const [, , base, index, trials] = process.argv
const manager = new RunManager({ homeDir: base, agentCommands: {}, git: {} })
const runId = (trial) => 'run_' + String(trial).padStart(12, '0')
for (let trial = 0; trial < Number(trials); trial += 1) {
  while (!existsSync(join(base, `go.${trial}`))) { /* spin: all workers leave the gate together */ }
  const won = manager.claimFinish(runId(trial))
  // written aside and renamed, so a reader never sees the result file before its content is there
  writeFileSync(join(base, `part.${trial}.${index}`), won ? '1' : '0')
  renameSync(join(base, `part.${trial}.${index}`), join(base, `res.${trial}.${index}`))
}
process.exit(0)
