import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../src/guard.js'

const TENDAI = 'rTendaiXXXXXXXXXXXXXXXXXXXXXXXXX'
const ATTACKER = 'rAttackerXXXXXXXXXXXXXXXXXXXXXXX'

const context = (overrides = {}) => ({
  policy: { perJobCap: 5, dailyCap: 15, paused: false, ...overrides.policy },
  freelancers: {
    [TENDAI]: { name: 'Tendai', channelAmount: 50, claimed: 0, ...overrides.tendai },
  },
  spentToday: overrides.spentToday ?? 0,
})

test('approves a payment inside every rule', () => {
  assert.deepEqual(evaluate({ recipient: TENDAI, amount: 4 }, context()), { approved: true, reasons: [] })
})

test('refuses a payee that is not on the approved list', () => {
  const v = evaluate({ recipient: ATTACKER, amount: 4 }, context())
  assert.equal(v.approved, false)
  assert.match(v.reasons.join(), /not on the approved payee list/)
})

test('refuses anything over the per-job cap', () => {
  const v = evaluate({ recipient: TENDAI, amount: 8 }, context())
  assert.equal(v.approved, false)
  assert.match(v.reasons.join(), /per-job cap/)
})

test('refuses once the daily cap would be broken', () => {
  const v = evaluate({ recipient: TENDAI, amount: 5 }, context({ spentToday: 12 }))
  assert.equal(v.approved, false)
  assert.match(v.reasons.join(), /daily cap/)
})

test('refuses more than is left in the channel', () => {
  const v = evaluate({ recipient: TENDAI, amount: 5 }, context({ tendai: { claimed: 48 } }))
  assert.equal(v.approved, false)
  assert.match(v.reasons.join(), /left in Tendai's channel/)
})

test('refuses everything when the owner has revoked access', () => {
  const v = evaluate({ recipient: TENDAI, amount: 1 }, context({ policy: { paused: true } }))
  assert.equal(v.approved, false)
  assert.match(v.reasons.join(), /revoked/)
})

test('refuses zero, negative and non-numeric amounts', () => {
  for (const amount of [0, -3, 'lots', NaN]) {
    assert.equal(evaluate({ recipient: TENDAI, amount }, context()).approved, false)
  }
})

test('the pitch attack trips every rule it can', () => {
  const v = evaluate({ recipient: ATTACKER, amount: 40 }, context())
  assert.equal(v.approved, false)
  assert.equal(v.reasons.length, 3) // unknown payee, over per-job cap, over daily cap
})
