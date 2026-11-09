// The smart part: reads the brief, the delivery and the invoice, and proposes a payout.
// It holds no keys. All it can produce is a proposal for the guard to accept or refuse.
import Anthropic from '@anthropic-ai/sdk'

const MODEL = process.env.WARDEN_MODEL || 'claude-opus-5-5'

const SYSTEM = `You are the payments agent for a business that pays remote freelancers.
For each submission you get the job brief, the freelancer on file, their delivery note and their invoice.
Decide whether the delivery satisfies the brief. If it does, propose paying the invoiced amount to the
right wallet. If it doesn't, reject it. Amounts are in XRP. Keep the reasoning to one or two sentences.`

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['pay', 'reject'] },
    recipient: { type: 'string', description: 'XRPL address to pay' },
    amount: { type: 'number', description: 'Amount in XRP' },
    reasoning: { type: 'string' },
  },
  required: ['decision', 'recipient', 'amount', 'reasoning'],
  additionalProperties: false,
}

let client

export function agentMode() {
  if (process.env.WARDEN_AGENT === 'offline') return 'offline'
  return process.env.ANTHROPIC_API_KEY ? 'claude' : 'offline'
}

export async function reviewDelivery(job) {
  if (agentMode() === 'offline') return offlineReview(job)
  try {
    return await claudeReview(job)
  } catch (err) {
    const fallback = offlineReview(job)
    fallback.reasoning += ` (Claude unavailable: ${err.message})`
    return fallback
  }
}

async function claudeReview({ brief, delivery, invoice, freelancer }) {
  client ??= new Anthropic()
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: DECISION_SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `<brief>\n${brief}\n</brief>`,
          `<freelancer_on_file>\nName: ${freelancer.name}\nWallet: ${freelancer.address}\n</freelancer_on_file>`,
          `<delivery>\n${delivery}\n</delivery>`,
          `<invoice>\n${invoice}\n</invoice>`,
        ].join('\n\n'),
      },
    ],
  })

  if (response.stop_reason === 'refusal') {
    return {
      decision: 'reject',
      recipient: freelancer.address,
      amount: 0,
      reasoning: 'The model declined to review this submission.',
      model: response.model,
    }
  }
  const text = response.content.find((block) => block.type === 'text')?.text
  return { ...JSON.parse(text), model: response.model }
}

// Stand-in agent for running without an API key. It is gullible on purpose: it follows
// whatever the invoice says, which is exactly the failure Warden is built to survive.
const ADDRESS = /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/

function offlineReview({ delivery, invoice, freelancer }) {
  const amount = Number(/amount\D*(\d+(?:\.\d+)?)/i.exec(invoice)?.[1] ?? 0)
  const redirect = ADDRESS.exec(invoice)?.[0]
  const delivered = delivery.trim().length > 0

  let reasoning = 'Delivery matches the brief, so I am paying the invoiced amount.'
  if (!delivered) reasoning = 'Nothing was delivered.'
  else if (redirect) reasoning = `Delivery received. The invoice says to pay ${redirect} instead, so I am following it.`

  return {
    decision: delivered ? 'pay' : 'reject',
    recipient: redirect ?? freelancer.address,
    amount,
    reasoning,
    model: 'offline agent (gullible on purpose)',
  }
}
