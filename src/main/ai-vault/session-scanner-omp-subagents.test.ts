import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OMP_SESSION_ARTIFACT_DIR_PATTERN,
  countOmpSubagentTranscripts,
  partitionOmpSubagentTranscriptPaths
} from './session-scanner-omp-subagents'

const SESSION_STEM = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeWorkspaceDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-omp-subagents-'))
  tempRoots.push(root)
  return root
}

describe('OMP_SESSION_ARTIFACT_DIR_PATTERN', () => {
  it('matches session artifact dir names and nothing else in the layout', () => {
    expect(OMP_SESSION_ARTIFACT_DIR_PATTERN.test(SESSION_STEM)).toBe(true)
    // Workspace directories are slug-hashes; task children are label-named.
    expect(
      OMP_SESSION_ARTIFACT_DIR_PATTERN.test('home-app-85dfa2f063812c58976deb581167a634a4')
    ).toBe(false)
    expect(OMP_SESSION_ARTIFACT_DIR_PATTERN.test('AuthAndPreflight')).toBe(false)
    expect(OMP_SESSION_ARTIFACT_DIR_PATTERN.test('local')).toBe(false)
  })
})

describe('countOmpSubagentTranscripts', () => {
  it('counts only direct-child transcripts of the artifact dir', async () => {
    const workspace = await makeWorkspaceDir()
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const artifactDir = join(workspace, SESSION_STEM)
    await mkdir(join(artifactDir, 'local'), { recursive: true })
    await writeFile(parentPath, '')
    await writeFile(join(artifactDir, 'AuthAndPreflight.jsonl'), '')
    await writeFile(join(artifactDir, 'BitbucketDcApi.jsonl'), '')
    // Artifacts are not transcripts; nested files belong to their own parents.
    await writeFile(join(artifactDir, 'notes.md'), '')
    await writeFile(join(artifactDir, 'local', 'plan.jsonl'), '')

    await expect(countOmpSubagentTranscripts(parentPath)).resolves.toBe(2)
  })

  it('returns 0 when the session never delegated (no artifact dir)', async () => {
    const workspace = await makeWorkspaceDir()
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    await writeFile(parentPath, '')

    await expect(countOmpSubagentTranscripts(parentPath)).resolves.toBe(0)
  })
})

describe('partitionOmpSubagentTranscriptPaths', () => {
  it('drops artifact-dir transcripts from candidates and counts them per parent', () => {
    const workspace = `/home/user/.omp/agent/sessions/home-app-85dfa2f0`
    const parent = `${workspace}/${SESSION_STEM}.jsonl`
    const sibling = `${workspace}/2026-05-02T09-00-00-000Z_dddddddd-eeee-4fff-8aaa-111111111111.jsonl`
    const partition = partitionOmpSubagentTranscriptPaths([
      parent,
      `${workspace}/${SESSION_STEM}/AuthAndPreflight.jsonl`,
      `${workspace}/${SESSION_STEM}/BitbucketDcApi.jsonl`,
      // A grandchild attributes to its own parent, not the top-level session —
      // and never surfaces as a candidate.
      `${workspace}/${SESSION_STEM}/AuthAndPreflight/Nested.jsonl`,
      sibling
    ])

    expect(partition.sessionFilePaths).toEqual([parent, sibling])
    expect(partition.subagentTranscriptCounts.get(parent)).toBe(2)
    expect(partition.subagentTranscriptCounts.size).toBe(1)
  })

  it('handles Windows separators', () => {
    const workspace = `C:\\Users\\u\\.omp\\agent\\sessions\\home-app-85dfa2f0`
    const parent = `${workspace}\\${SESSION_STEM}.jsonl`
    const partition = partitionOmpSubagentTranscriptPaths([
      parent,
      `${workspace}\\${SESSION_STEM}\\AuthAndPreflight.jsonl`
    ])

    expect(partition.sessionFilePaths).toEqual([parent])
    expect(partition.subagentTranscriptCounts.get(parent)).toBe(1)
  })
})
