import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const output = resolve('server/survive/generated-build-info.mjs')
const timestamp = Date.now()

await mkdir(dirname(output), { recursive: true })
await writeFile(output, [
  '// Generated once by scripts/generate-build-info.mjs. Do not edit manually.',
  `export const SURVIVE_DEPLOYED_AT = ${timestamp}`,
  '',
].join('\n'))
