import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import * as warden from './warden.js'
import { JOBS } from './presets.js'

const app = express()
const PORT = Number(process.env.PORT || 3000)
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

app.use(express.json())
app.use(express.static(PUBLIC))

// One ledger operation at a time, so two clicks can't race on channel balances.
let queue = Promise.resolve()
const serial = (fn) => {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

const route = (fn) => async (req, res) => {
  try {
    res.json(await serial(() => fn(req)))
  } catch (err) {
    console.error(err)
    res.status(400).json({ error: err.message })
  }
}

app.get('/api/state', route(() => warden.snapshot()))
// The poisoned invoice needs the attacker's address, so the dashboard fills in {{ATTACKER}}.
app.get('/api/presets', (req, res) =>
  res.json(
    Object.fromEntries(
      Object.entries(JOBS).map(([k, j]) => [
        k,
        { ...j, invoice: typeof j.invoice === 'function' ? j.invoice('{{ATTACKER}}') : j.invoice },
      ]),
    ),
  ),
)
app.post('/api/setup', route(() => warden.setup((msg) => console.log(`  setup: ${msg}`))))
app.post('/api/jobs', route((req) => warden.submitJob(req.body)))
app.post('/api/attack', route(() => warden.runAttack()))
app.post('/api/policy', route((req) => warden.setPolicy(req.body)))
app.post('/api/revoke', route(() => warden.revoke()))
app.post('/api/restore', route(() => warden.restore()))
app.post('/api/reset', route(() => warden.reset()))

app.listen(PORT, () => {
  console.log(`Warden dashboard on http://localhost:${PORT}`)
})
