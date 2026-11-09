// Local demo state. Testnet seeds only — never put a mainnet key in here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, '.warden', 'state.json')

export function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return null
  }
}

export function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2))
}

export function clear() {
  fs.rmSync(FILE, { force: true })
}
