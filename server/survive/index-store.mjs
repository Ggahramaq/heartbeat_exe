import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const file = resolve('data/survive-index.json')
let state
let writeQueue = Promise.resolve()

async function load() {
  if (state) return state
  try { state = JSON.parse(await readFile(file, 'utf8')) } catch { state = { mints: {} } }
  return state
}

export async function readMintIndex(mint) {
  const data = await load()
  return data.mints[mint] ?? null
}

export async function writeMintIndex(mint, value) {
  // Several background services update this local cache. Serialize writes and
  // replace the file atomically so an interrupted write cannot leave malformed
  // JSON or discard another service's completed update.
  const persist = async () => {
    const data = await load()
    data.mints[mint] = { ...(data.mints[mint] ?? {}), ...value }
    await mkdir(resolve('data'), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(temporary, file)
  }
  const next = writeQueue.then(persist, persist)
  writeQueue = next.catch(() => {})
  return next
}
