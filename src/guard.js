// The guard is deliberately dumb: no model, no prompt, nothing to persuade.
// It holds the only key that can sign payment-channel claims and the second key on the
// agent's multisig wallet, and it uses them only when every rule below passes.
import xrpl from 'xrpl'

export const round6 = (n) => Math.round(n * 1e6) / 1e6

export function evaluate(proposal, { policy, freelancers, spentToday }) {
  const reasons = []
  const payee = freelancers[proposal.recipient]
  const amount = Number(proposal.amount)

  if (policy.paused) reasons.push('Agent access has been revoked by the owner')
  if (!payee) reasons.push(`${proposal.recipient} is not on the approved payee list`)
  if (!(amount > 0)) reasons.push('Amount must be a positive number')
  if (amount > policy.perJobCap) {
    reasons.push(`${amount} XRP is over the per-job cap of ${policy.perJobCap} XRP`)
  }
  if (round6(spentToday + amount) > policy.dailyCap) {
    reasons.push(`Would break the daily cap (${spentToday} of ${policy.dailyCap} XRP already paid today)`)
  }
  if (payee && round6(payee.claimed + amount) > payee.channelAmount) {
    reasons.push(`Only ${round6(payee.channelAmount - payee.claimed)} XRP left in ${payee.name}'s channel`)
  }

  return { approved: reasons.length === 0, reasons }
}

// Channel claims are cumulative: the signature authorises the payee to have received
// `cumulativeXrp` in total from the channel, never more.
export function signClaim(channelId, cumulativeXrp, guardWallet) {
  return xrpl.signPaymentChannelClaim(channelId, String(cumulativeXrp), guardWallet.privateKey)
}

export function cosign(preparedTx, guardWallet) {
  return guardWallet.sign(preparedTx, true).tx_blob
}
