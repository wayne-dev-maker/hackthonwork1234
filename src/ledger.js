// Thin wrapper around xrpl.js: connect, fund, sign, submit, read.
import xrpl from 'xrpl'

export const NETWORK = process.env.XRPL_NETWORK || 'wss://s.altnet.rippletest.net:51233'
export const EXPLORER = process.env.XRPL_EXPLORER || 'https://testnet.xrpl.org'
export const txUrl = (hash) => `${EXPLORER}/transactions/${hash}`
export const accountUrl = (address) => `${EXPLORER}/accounts/${address}`

let client

export async function connect() {
  client ??= new xrpl.Client(NETWORK)
  if (!client.isConnected()) await client.connect()
  return client
}

export async function disconnect() {
  if (client?.isConnected()) await client.disconnect()
}

export async function fund() {
  const c = await connect()
  const { wallet } = await c.fundWallet()
  return wallet
}

// Submit a signed blob and wait for the outcome. Transactions the network refuses outright
// (tem/tef/tel codes) never reach a ledger, so those come back immediately.
export async function submit(txBlob) {
  const c = await connect()
  const hash = xrpl.hashes.hashSignedTx(txBlob)
  const { result } = await c.request({ command: 'submit', tx_blob: txBlob })
  const prelim = result.engine_result
  if (/^(tem|tef|tel)/.test(prelim)) {
    return { ok: false, code: prelim, message: result.engine_result_message, hash }
  }
  const final = await waitForValidation(c, hash)
  const code = final.meta.TransactionResult
  return { ok: code === 'tesSUCCESS', code, hash, meta: final.meta, url: txUrl(hash) }
}

async function waitForValidation(c, hash) {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      const { result } = await c.request({ command: 'tx', transaction: hash })
      if (result.validated) return result
    } catch (err) {
      if (err.data?.error !== 'txnNotFound') throw err
    }
  }
  throw new Error(`Transaction ${hash} was not validated in time`)
}

export async function signAndSubmit(tx, wallet) {
  const c = await connect()
  const prepared = await c.autofill(tx)
  return submit(wallet.sign(prepared).tx_blob)
}

// Autofill a transaction that will carry `signerCount` multisignatures (sets the higher fee).
export async function prepareMultisig(tx, signerCount) {
  const c = await connect()
  return c.autofill(tx, signerCount)
}

// XRP balance, or null if the account doesn't exist on the ledger.
export async function balance(address) {
  const c = await connect()
  try {
    return Number(await c.getXrpBalance(address))
  } catch (err) {
    if (err.data?.error === 'actNotFound') return null
    throw err
  }
}

export async function channels(source, destination) {
  const c = await connect()
  try {
    const { result } = await c.request({
      command: 'account_channels',
      account: source,
      destination_account: destination,
    })
    return result.channels
  } catch (err) {
    if (err.data?.error === 'actNotFound') return []
    throw err
  }
}

export async function hasSignerList(address) {
  const c = await connect()
  const { result } = await c.request({ command: 'account_objects', account: address, type: 'signer_list' })
  return result.account_objects.length > 0
}
