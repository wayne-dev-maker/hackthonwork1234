// The pitch demo, end to end in the terminal, against the real XRPL testnet.
//   npm run demo            fresh testnet accounts every run
//   npm run demo -- --reuse reuse the accounts in .warden/state.json
import 'dotenv/config'
import * as warden from './warden.js'
import * as ledger from './ledger.js'
import * as store from './state.js'
import { agentMode } from './agent.js'
import { JOBS } from './presets.js'

const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`
const dim = c(2)
const bold = c(1)
const COLORS = { agent: c(35), guard: c(33), ledger: c(36), owner: c(34) }

function scene(title) {
  console.log(`\n${bold('━━ ' + title + ' ' + '━'.repeat(Math.max(0, 60 - title.length)))}`)
}

function print(events) {
  for (const e of events) {
    const mark = e.ok === true ? c(32)('✔') : e.ok === false ? c(31)('✖') : dim('•')
    console.log(`${mark} ${COLORS[e.layer](e.layer.toUpperCase().padEnd(6))} ${e.title}`)
    if (e.detail) console.log(dim(`         ${e.detail}`))
    if (e.url) console.log(dim(`         ${e.url}`))
  }
}

async function main() {
  console.log(bold('\nWARDEN') + dim("  AI that pays Africa's talent, on a leash it can't break."))
  console.log(dim(`Network: ${ledger.NETWORK}   Agent: ${agentMode()}`))

  const reuse = process.argv.includes('--reuse') && store.load()
  if (!reuse) {
    scene('Setup: an agency in Cape Town hires Tendai in Harare')
    store.clear()
    await warden.setup((msg) => console.log(dim(`  … ${msg}`)))
    print(store.load().log)
  }
  const tendai = Object.values(store.load().freelancers)[0].address

  scene('1. Tendai delivers a logo. Nobody clicks anything.')
  print(await warden.submitJob({ freelancer: tendai, ...JOBS.logo }))

  scene('2. The attack: a poisoned invoice')
  print(await warden.runAttack())

  scene('3. A bigger job, over the per-job cap')
  print(await warden.submitJob({ freelancer: tendai, ...JOBS.brand }))

  scene('4. The owner raises the cap, outside the agent')
  print(await warden.setPolicy({ perJobCap: 10 }))
  print(await warden.submitJob({ freelancer: tendai, ...JOBS.brand }))

  const snap = await warden.snapshot()
  const f = snap.freelancers[0]
  scene('Result')
  console.log(`  Tendai paid:      ${f.claimed} XRP of a ${f.channelAmount} XRP channel`)
  console.log(`  Attacker got:     ${snap.attacker.balance ?? 0} XRP`)
  console.log(`  Tendai's account: ${f.url}`)
  console.log(dim('\n  Open the dashboard with: npm start\n'))
}

main()
  .catch((err) => {
    console.error(c(31)(`\n${err.stack ?? err}`))
    process.exitCode = 1
  })
  .finally(() => ledger.disconnect())
