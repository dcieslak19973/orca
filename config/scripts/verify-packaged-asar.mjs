#!/usr/bin/env node
// Why: a packed app.asar can carry correct offsets but wrong bytes (observed on
// Windows: package.json's slot held the previous entry's tail). Electron then
// fails to parse package.json and the browser process exits 1 before any app
// code runs — silent unless EnableEmbeddedAsarIntegrityValidation is on. Verify
// the archive against the header hashes electron-builder recorded at pack time.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { argv, exit } from 'node:process'
import asar from '@electron/asar'

const archivePath = argv[2]
if (!archivePath || !existsSync(archivePath)) {
  console.error(`[verify-asar] archive not found: ${archivePath ?? '<missing argument>'}`)
  exit(2)
}

const { header } = asar.getRawHeader(archivePath)

/** Flatten the header tree into content entries (skips directories, links, and unpacked files). */
// Why: @electron/asar resolves lookups with the host path API, so entry paths
// must use native separators — forward slashes miss on Windows.
function collectEntries(node, prefix = '') {
  const entries = []
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? join(prefix, name) : name
    if (value.files) {
      entries.push(...collectEntries(value, path))
    } else if (value.offset !== undefined && !value.unpacked) {
      entries.push({ path, size: value.size, integrity: value.integrity })
    }
  }
  return entries
}

const entries = collectEntries(header)
const mismatched = []
let checked = 0

for (const entry of entries) {
  if (!entry.integrity?.hash) {
    continue
  }
  const actual = createHash(entry.integrity.algorithm === 'SHA256' ? 'sha256' : 'sha256')
    .update(asar.extractFile(archivePath, entry.path))
    .digest('hex')
  checked += 1
  if (actual !== entry.integrity.hash) {
    mismatched.push({ path: entry.path, expected: entry.integrity.hash, actual })
  }
}

// Why: the failure mode that motivated this script is specifically an unusable
// entrypoint, so assert it directly rather than trusting hash coverage alone.
let entrypointError = null
try {
  const manifest = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf-8'))
  if (!manifest.main) {
    entrypointError = 'package.json has no "main" field'
  } else {
    // Why: "main" is a POSIX-ish spec path ("./out/main/index.js"); asar lookups need native separators.
    const mainEntry = join(...manifest.main.split('/').filter((part) => part && part !== '.'))
    if (!asar.statFile(archivePath, mainEntry)) {
      entrypointError = `package.json main "${manifest.main}" is missing from the archive`
    }
  }
} catch (error) {
  entrypointError = `package.json is unreadable: ${error.message}`
}

if (mismatched.length > 0 || entrypointError) {
  console.error(`[verify-asar] FAILED for ${archivePath}`)
  if (entrypointError) {
    console.error(`[verify-asar] entrypoint: ${entrypointError}`)
  }
  for (const { path, expected, actual } of mismatched.slice(0, 20)) {
    console.error(
      `[verify-asar] content mismatch: ${path}\n  expected ${expected}\n  actual   ${actual}`
    )
  }
  if (mismatched.length > 20) {
    console.error(`[verify-asar] ...and ${mismatched.length - 20} more`)
  }
  exit(1)
}

console.log(
  `[verify-asar] OK — ${checked} entries match their recorded hashes; entrypoint resolves`
)
