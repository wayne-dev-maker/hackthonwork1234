// Orchestration: who may do what, in what order. Every step is logged as an event tagged
// with the layer that made the call (agent, guard, ledger, owner).
import xrpl from 'xrpl'
import * as ledger from './ledger.js'
import * as guard from './guard.js'
import * as store from './state.js'
import { reviewDelivery, agentMode } from './agent.js'
import { JOBS } from './presets.js'

const DEFAULT_POLICY = { perJobCap: 5, dailyCap: 15, paused: false }
const MAX_LOG = 200

const drops = (xrp) => xrpl.xrpToDrops(String(xrp))
const today = () => new Date().toISOString().slice(0, 10)

function walletsOf(state) {
  return Object.fromEntries(Object.entries(state.wallets).map(([k, w]) => [k, xrpl.Wallet.fromSeed(w.seed)]))
}

function guardContext(state) {
  const spentToday = guard.round6(
    state.spend.filter((s) => s.at.startsWith(today())).reduce((sum, s) => sum + s.amount, 0),
  )
  return { policy: state.policy, freelancers: state.freelancers, spentToday }
}

function nameOf(state, address) {
  return state.freelancers[address]?.name ?? (address === state.wallets.attacker.address ? 'an unknown wallet' : address)
}

function recorder(state) {
  const events = []
  const record = (layer, ok, title, detail = '', url) => {
    const event = { at: new Date().toISOString(), layer, ok, title, detail, url }
    events.push(event)
    state.log.push(event)
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG)
    return event
  }
  return { events, record }
}

function requireState() {
  const state = store.load()
  if (!state) throw new Error('Run setup first (POST /api/setup or npm run demo)')
  return state
}

// ---------------------------------------------------------------------------------------
// Setup: build the four layers on testnet.
// ---------------------------------------------------------------------------------------
export async function setup(progress = () => {}) {
  progress('Funding the business treasury from the testnet faucet')
  const treasury = await ledger.fund()
  progress("Funding the agent's operating wallet")
  const ops = await ledger.fund()
  progress("Funding Tendai's wallet")
  const tendai = await ledger.fund()

  // Keys that never need XRP of their own: they only sign.
  const agent = xrpl.Wallet.generate()
  const guardWallet = xrpl.Wallet.generate()
  const attacker = xrpl.Wallet.generate()

  const state = {
    createdAt: new Date().toISOString(),
    network: ledger.NETWORK,
    wallets: Object.fromEntries(
      Object.entries({ treasury, ops, tendai, agent, guard: guardWallet, attacker }).map(([k, w]) => [
        k,
        { address: w.address, seed: w.seed },
      ]),
    ),
    policy: { ...DEFAULT_POLICY },
    freelancers: {},
    spend: [],
    log: [],
  }
  const { record } = recorder(state)
  record('owner', true, 'Testnet accounts funded', 'Treasury, agent operating wallet and Tendai, from the XRPL testnet faucet.')

  progress('Putting the agent wallet behind a 2-of-2 multisig (agent + guard)')
  const signerList = await ledger.signAndSubmit(
    {
      TransactionType: 'SignerListSet',
      Account: ops.address,
      SignerQuorum: 2,
      SignerEntries: [agent, guardWallet].map((w) => ({ SignerEntry: { Account: w.address, SignerWeight: 1 } })),
    },
    ops,
  )
  if (!signerList.ok) throw new Error(`SignerListSet failed: ${signerList.code}`)
  record(
    'ledger',
    true,
    'Agent wallet locked to 2-of-2 multisig',
    'Any payment from it needs the agent AND the guard to sign. The owner keeps the master key.',
    signerList.url,
  )

  progress('Opening a payment channel from the treasury to Tendai')
  const treasuryBalance = await ledger.balance(treasury.address)
  const channelAmount = Math.min(50, Math.floor(treasuryBalance - 10))
  const channel = await ledger.signAndSubmit(
    {
      TransactionType: 'PaymentChannelCreate',
      Account: treasury.address,
      Destination: tendai.address,
      Amount: drops(channelAmount),
      SettleDelay: 86400,
      PublicKey: guardWallet.publicKey,
    },
    treasury,
  )
  if (!channel.ok) throw new Error(`PaymentChannelCreate failed: ${channel.code}`)
  const channelId = channel.meta.AffectedNodes.find((n) => n.CreatedNode?.LedgerEntryType === 'PayChannel')
    .CreatedNode.LedgerIndex

  state.freelancers[tendai.address] = {
    key: 'tendai',
    name: 'Tendai',
    city: 'Harare',
    role: 'Brand designer',
    address: tendai.address,
    channelId,
    channelAmount,
    claimed: 0,
  }
  record(
    'ledger',
    true,
    `Channel opened: ${channelAmount} XRP for Tendai`,
    "The ledger locks it to Tendai's wallet and this maximum. Only the guard's key can sign claims against it.",
    channel.url,
  )
  record('owner', true, 'Guard rules set', `Per-job cap ${DEFAULT_POLICY.perJobCap} XRP, daily cap ${DEFAULT_POLICY.dailyCap} XRP.`)

  store.save(state)
  return snapshot()
}

// ---------------------------------------------------------------------------------------
// The happy path: freelancer submits, agent reviews, guard checks, ledger settles.
// ---------------------------------------------------------------------------------------
export async function submitJob({ freelancer: address, brief, delivery, invoice }) {
  const state = requireState()
  const wallets = walletsOf(state)
  const { events, record } = recorder(state)
  const freelancer = state.freelancers[address] ?? Object.values(state.freelancers)[0]

  const proposal = await reviewDelivery({ brief, delivery, invoice, freelancer })
  if (proposal.decision !== 'pay') {
    record('agent', false, 'Agent rejected the delivery', `${proposal.reasoning} [${proposal.model}]`)
  } else {
    record(
      'agent',
      true,
      `Agent proposes ${proposal.amount} XRP to ${nameOf(state, proposal.recipient)}`,
      `${proposal.reasoning} [${proposal.model}]`,
    )
    await payThroughChannel(state, wallets, proposal, record)
  }

  store.save(state)
  return events
}

async function payThroughChannel(state, wallets, proposal, record) {
  const verdict = guard.evaluate(proposal, guardContext(state))
  if (!verdict.approved) {
    record('guard', false, 'Guard refused to sign', verdict.reasons.join(' · '))
    return false
  }

  const payee = state.freelancers[proposal.recipient]
  const cumulative = guard.round6(payee.claimed + Number(proposal.amount))
  const signature = guard.signClaim(payee.channelId, cumulative, wallets.guard)
  record(
    'guard',
    true,
    'Guard signed the claim',
    `Approved payee, ${proposal.amount} ≤ ${state.policy.perJobCap} XRP per job, inside the daily cap.`,
  )

  // In production Tendai's own wallet redeems the claim. Here we redeem it for them.
  const result = await ledger.signAndSubmit(
    {
      TransactionType: 'PaymentChannelClaim',
      Account: payee.address,
      Channel: payee.channelId,
      Balance: drops(cumulative),
      Amount: drops(cumulative),
      Signature: signature.toUpperCase(),
      PublicKey: wallets.guard.publicKey,
    },
    wallets[payee.key],
  )
  if (!result.ok) {
    record('ledger', false, `Ledger rejected the claim: ${result.code}`, result.message ?? '', result.url)
    return false
  }

  payee.claimed = cumulative
  state.spend.push({ at: new Date().toISOString(), amount: Number(proposal.amount), to: payee.address })
  record(
    'ledger',
    true,
    `Settled: ${proposal.amount} XRP to ${payee.name}`,
    `Validated in seconds. ${guard.round6(payee.channelAmount - payee.claimed)} XRP left in the channel.`,
    result.url,
  )
  return true
}

// ---------------------------------------------------------------------------------------
// The attack: a poisoned invoice, then a fully hijacked agent trying every way around.
// ---------------------------------------------------------------------------------------
export async function runAttack() {
  const state = requireState()
  const wallets = walletsOf(state)
  const { events, record } = recorder(state)
  const tendai = Object.values(state.freelancers)[0]
  const attacker = state.wallets.attacker.address
  const attackerBefore = await ledger.balance(attacker)

  // 1. The agent reads an invoice with an injected instruction.
  const proposal = await reviewDelivery({
    brief: JOBS.attack.brief,
    delivery: JOBS.attack.delivery,
    invoice: JOBS.attack.invoice(attacker),
    freelancer: tendai,
  })
  const fooled = proposal.decision === 'pay' && proposal.recipient !== tendai.address
  record(
    'agent',
    !fooled,
    fooled
      ? `Agent fell for it: proposes ${proposal.amount} XRP to an unknown wallet`
      : 'Agent spotted the injection this time',
    `${proposal.reasoning} [${proposal.model}]`,
  )

  // 2. Assume the worst, whatever the model did: the agent is fully hijacked.
  const evil = { decision: 'pay', recipient: attacker, amount: 40 }
  record('agent', null, 'Assume the agent is fully hijacked', `It demands 40 XRP to ${attacker} and tries every route.`)

  // Layer 3: the guard.
  const verdict = guard.evaluate(evil, guardContext(state))
  record('guard', verdict.approved, verdict.approved ? 'Guard signed (unexpected!)' : 'Guard refused to sign', verdict.reasons.join(' · '))

  // Layer 2: there is no channel to pull from.
  const open = await ledger.channels(state.wallets.treasury.address, attacker)
  record(
    'ledger',
    open.length > 0,
    'No payment channel to that wallet',
    `The treasury has ${open.length} channels to ${attacker}, so there is nothing to claim against.`,
  )

  // Route A: skip the guard and pay from the agent's multisig wallet with one signature.
  const solo = await ledger.prepareMultisig(
    { TransactionType: 'Payment', Account: state.wallets.ops.address, Destination: attacker, Amount: drops(40) },
    2,
  )
  const soloResult = await ledger.submit(wallets.agent.sign(solo, true).tx_blob)
  record(
    'ledger',
    soloResult.ok,
    soloResult.ok ? 'Solo payment went through (unexpected!)' : `Ledger said no: ${soloResult.code}`,
    'The agent signed a payment from its own wallet without the guard. The wallet needs 2 of 2 signatures.',
    soloResult.url,
  )

  // Route B: forge a claim on Tendai's channel with the agent's own key (say Tendai colludes).
  const forged = xrpl.signPaymentChannelClaim(tendai.channelId, String(tendai.channelAmount), wallets.agent.privateKey)
  const forgedResult = await ledger.signAndSubmit(
    {
      TransactionType: 'PaymentChannelClaim',
      Account: tendai.address,
      Channel: tendai.channelId,
      Balance: drops(tendai.channelAmount),
      Amount: drops(tendai.channelAmount),
      Signature: forged.toUpperCase(),
      PublicKey: wallets.agent.publicKey,
    },
    wallets.tendai,
  )
  record(
    'ledger',
    forgedResult.ok,
    forgedResult.ok ? 'Forged claim accepted (unexpected!)' : `Ledger said no: ${forgedResult.code}`,
    `The agent signed a claim for the whole ${tendai.channelAmount} XRP channel. Only the guard's key is accepted.`,
    forgedResult.url,
  )

  const attackerAfter = await ledger.balance(attacker)
  const moved = guard.round6((attackerAfter ?? 0) - (attackerBefore ?? 0))
  record(
    'owner',
    moved === 0,
    `Money that reached the attacker: ${moved} XRP`,
    moved === 0 ? 'The AI was fooled, but the money never moved.' : 'Investigate immediately.',
  )

  store.save(state)
  return events
}

// ---------------------------------------------------------------------------------------
// Owner controls: these live outside the agent, which has no route to call them.
// ---------------------------------------------------------------------------------------
export async function setPolicy({ perJobCap, dailyCap }) {
  const state = requireState()
  const { events, record } = recorder(state)
  const next = { ...state.policy }
  if (perJobCap !== undefined) next.perJobCap = positive(perJobCap, 'perJobCap')
  if (dailyCap !== undefined) next.dailyCap = positive(dailyCap, 'dailyCap')
  const changes = [
    next.perJobCap !== state.policy.perJobCap && `per-job cap ${state.policy.perJobCap} → ${next.perJobCap} XRP`,
    next.dailyCap !== state.policy.dailyCap && `daily cap ${state.policy.dailyCap} → ${next.dailyCap} XRP`,
  ].filter(Boolean)
  record('owner', true, 'Owner updated the guard rules', changes.join(', ') || 'No change.')
  state.policy = next
  store.save(state)
  return events
}

function positive(value, name) {
  const n = Number(value)
  if (!(n > 0)) throw new Error(`${name} must be a positive number`)
  return n
}

export async function revoke() {
  const state = requireState()
  const wallets = walletsOf(state)
  const { events, record } = recorder(state)
  state.policy.paused = true
  record('owner', true, 'Owner revoked agent access', 'The guard will not sign anything until access is restored.')

  // Signed with the master key, which only the owner holds. Deletes the agent+guard signer list.
  const result = await ledger.signAndSubmit(
    { TransactionType: 'SignerListSet', Account: state.wallets.ops.address, SignerQuorum: 0 },
    wallets.ops,
  )
  record(
    'ledger',
    result.ok,
    result.ok ? 'Signer list removed on-ledger' : `Signer list removal failed: ${result.code}`,
    'Agent and guard signatures no longer move the agent wallet at all.',
    result.url,
  )
  store.save(state)
  return events
}

export async function restore() {
  const state = requireState()
  const wallets = walletsOf(state)
  const { events, record } = recorder(state)
  const result = await ledger.signAndSubmit(
    {
      TransactionType: 'SignerListSet',
      Account: state.wallets.ops.address,
      SignerQuorum: 2,
      SignerEntries: [wallets.agent, wallets.guard].map((w) => ({
        SignerEntry: { Account: w.address, SignerWeight: 1 },
      })),
    },
    wallets.ops,
  )
  if (result.ok) state.policy.paused = false
  record(
    'owner',
    result.ok,
    result.ok ? 'Owner restored agent access' : `Restore failed: ${result.code}`,
    '2-of-2 multisig is back and the guard is signing again.',
    result.url,
  )
  store.save(state)
  return events
}

export function reset() {
  store.clear()
}

// ---------------------------------------------------------------------------------------
// Read model for the dashboard.
// ---------------------------------------------------------------------------------------
export async function snapshot() {
  const state = store.load()
  if (!state) return { ready: false, agentMode: agentMode(), network: ledger.NETWORK }

  const { treasury, ops, agent, guard: guardKey, attacker } = state.wallets
  const [treasuryBalance, opsBalance, multisigActive, attackerBalance] = await Promise.all([
    ledger.balance(treasury.address),
    ledger.balance(ops.address),
    ledger.hasSignerList(ops.address),
    ledger.balance(attacker.address),
  ])
  const freelancers = await Promise.all(
    Object.values(state.freelancers).map(async (f) => {
      const [chans, walletBalance] = await Promise.all([
        ledger.channels(treasury.address, f.address),
        ledger.balance(f.address),
      ])
      const onLedger = chans.find((c) => c.channel_id === f.channelId)
      return {
        name: f.name,
        city: f.city,
        role: f.role,
        address: f.address,
        channelId: f.channelId,
        channelAmount: onLedger ? Number(xrpl.dropsToXrp(onLedger.amount)) : f.channelAmount,
        claimed: onLedger ? Number(xrpl.dropsToXrp(onLedger.balance)) : f.claimed,
        walletBalance,
        url: ledger.accountUrl(f.address),
      }
    }),
  )

  return {
    ready: true,
    agentMode: agentMode(),
    network: state.network,
    policy: state.policy,
    spentToday: guardContext(state).spentToday,
    treasury: { address: treasury.address, balance: treasuryBalance, url: ledger.accountUrl(treasury.address) },
    ops: { address: ops.address, balance: opsBalance, multisigActive, url: ledger.accountUrl(ops.address) },
    agent: { address: agent.address },
    guard: { address: guardKey.address },
    attacker: { address: attacker.address, balance: attackerBalance },
    freelancers,
    log: [...state.log].reverse(),
  }
}
