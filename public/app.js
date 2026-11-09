const $ = (id) => document.getElementById(id)
let state = null
let presets = {}
let seen = new Set()

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

async function busy(text, fn) {
  $('busy-text').textContent = text
  $('busy').hidden = false
  document.querySelectorAll('button').forEach((b) => (b.disabled = true))
  try {
    await fn()
  } catch (err) {
    toast(err.message)
  } finally {
    $('busy').hidden = true
    document.querySelectorAll('button').forEach((b) => (b.disabled = false))
    await refresh()
  }
}

function toast(message) {
  $('toast').textContent = message
  $('toast').hidden = false
  setTimeout(() => ($('toast').hidden = true), 6000)
}

const xrp = (n) => (n === null || n === undefined ? '–' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 })} XRP`)
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

async function refresh() {
  state = await api('/api/state')
  $('agent-pill').textContent = state.agentMode === 'claude' ? 'Agent: Claude' : 'Agent: offline (gullible)'
  $('setup').hidden = state.ready
  $('app').hidden = !state.ready
  $('reset-btn').hidden = !state.ready
  if (!state.ready) return

  $('treasury-balance').textContent = xrp(state.treasury.balance)
  $('treasury-link').textContent = short(state.treasury.address)
  $('treasury-link').href = state.treasury.url

  const f = state.freelancers[0]
  $('f-name').textContent = f.name
  $('f-claimed').textContent = f.claimed
  $('f-amount').textContent = f.channelAmount
  $('f-bar').style.width = `${Math.min(100, (f.claimed / f.channelAmount) * 100)}%`
  $('f-link').textContent = `${f.city} · ${short(f.address)}`
  $('f-link').href = f.url

  $('r-job').textContent = xrp(state.policy.perJobCap)
  $('r-day').textContent = xrp(state.policy.dailyCap)
  $('r-spent').textContent = xrp(state.spentToday)
  if (document.activeElement !== $('cap-job')) $('cap-job').value = state.policy.perJobCap
  if (document.activeElement !== $('cap-day')) $('cap-day').value = state.policy.dailyCap

  const revoked = state.policy.paused
  $('access-status').textContent = revoked ? 'Revoked' : 'Agent active'
  $('access-status').style.color = revoked ? 'var(--bad)' : 'var(--ok)'
  $('multisig-status').textContent = state.ops.multisigActive
    ? 'Agent wallet: 2-of-2 multisig (agent + guard)'
    : 'Agent wallet: signer list removed'
  $('revoke-btn').textContent = revoked ? 'Restore access' : 'Revoke agent'
  $('revoke-btn').className = revoked ? 'secondary' : 'danger'

  renderLog(state.log)
  fillInvoiceIfAttack()
}

function renderLog(log) {
  const ol = $('log')
  ol.replaceChildren()
  if (!log.length) {
    ol.innerHTML = '<li><span class="empty">Nothing yet.</span></li>'
    return
  }
  const firstRender = seen.size === 0
  for (const e of log) {
    const li = document.createElement('li')
    const key = e.at + e.title
    if (!firstRender && !seen.has(key)) li.className = 'fresh'
    seen.add(key)

    const mark = document.createElement('span')
    mark.className = `mark ${e.ok === true ? 'ok' : e.ok === false ? 'bad' : 'info'}`
    mark.textContent = e.ok === true ? '✔' : e.ok === false ? '✖' : '•'
    const tag = document.createElement('i')
    tag.className = `tag ${e.layer}`
    tag.textContent = e.layer
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = e.title
    li.append(mark, tag, title)

    if (e.detail || e.url) {
      const detail = document.createElement('span')
      detail.className = 'detail'
      detail.textContent = e.detail ? `${e.detail} ` : ''
      if (e.url) {
        const a = document.createElement('a')
        a.href = e.url
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = 'View on explorer ↗'
        detail.append(a)
      }
      li.append(detail)
    }
    ol.append(li)
  }
}

function applyPreset(key) {
  const p = presets[key]
  $('brief').value = p.brief
  $('delivery').value = p.delivery
  $('invoice').value = p.invoice
  fillInvoiceIfAttack()
}

// The poisoned invoice needs the attacker's address, which only exists after setup.
function fillInvoiceIfAttack() {
  if (!state?.attacker) return
  $('invoice').value = $('invoice').value.replace('{{ATTACKER}}', state.attacker.address)
}

$('setup-btn').onclick = () =>
  busy('Funding testnet accounts and opening the channel…', async () => {
    $('setup-status').textContent = 'Talking to the XRPL testnet faucet. About 30 seconds.'
    await api('/api/setup', {})
  })

$('reset-btn').onclick = () => {
  if (confirm('Forget these testnet accounts and start over?')) busy('Resetting…', () => api('/api/reset', {}))
}

$('job-form').onsubmit = (e) => {
  e.preventDefault()
  busy('Agent reviewing, guard checking, ledger settling…', () =>
    api('/api/jobs', {
      freelancer: state.freelancers[0].address,
      brief: $('brief').value,
      delivery: $('delivery').value,
      invoice: $('invoice').value,
    }),
  )
}

$('attack-btn').onclick = () => busy('Attacking every layer…', () => api('/api/attack', {}))

$('policy-form').onsubmit = (e) => {
  e.preventDefault()
  busy('Updating guard rules…', () =>
    api('/api/policy', { perJobCap: Number($('cap-job').value), dailyCap: Number($('cap-day').value) }),
  )
}

$('revoke-btn').onclick = () =>
  state.policy.paused
    ? busy('Restoring the multisig on-ledger…', () => api('/api/restore', {}))
    : busy('Revoking: removing the signer list on-ledger…', () => api('/api/revoke', {}))

$('preset').onchange = (e) => applyPreset(e.target.value)

async function init() {
  presets = await api('/api/presets')
  $('preset').innerHTML = Object.entries(presets)
    .map(([k, p]) => `<option value="${k}">${p.label}</option>`)
    .join('')
  applyPreset('logo')
  await refresh()
}

init().catch((err) => toast(err.message))
