import { describe, expect, it } from 'vitest'
import { extractRevertTargets, identifyMergedPR } from './forge-merge-subject'

describe('identifyMergedPR', () => {
  it('identifies GitHub squash subjects', () => {
    expect(identifyMergedPR('fix(terminal): repaint (#12345)')).toEqual({
      number: 12345,
      forge: 'github'
    })
  })

  it('identifies GitHub merge-commit subjects', () => {
    expect(identifyMergedPR('Merge pull request #77 from org/branch')).toEqual({
      number: 77,
      forge: 'github'
    })
  })

  it('identifies Bitbucket merge subjects and does not misread them as GitHub', () => {
    expect(identifyMergedPR('Merged in feature/x (pull request #88)')).toEqual({
      number: 88,
      forge: 'bitbucket'
    })
  })

  it('identifies GitLab squash subjects with a trailing MR reference', () => {
    expect(identifyMergedPR('Resolve login bug (!42)')).toEqual({ number: 42, forge: 'gitlab' })
  })

  it('identifies GitLab merge commits via the see-merge-request body trailer', () => {
    expect(
      identifyMergedPR(
        "Merge branch 'fix' into 'main'",
        'Fix it\n\nSee merge request group/proj!907'
      )
    ).toEqual({ number: 907, forge: 'gitlab' })
  })

  it('returns null for unattributable merges', () => {
    expect(identifyMergedPR("Merge branch 'develop'")).toEqual({ number: null, forge: null })
    expect(identifyMergedPR('plain commit with no reference')).toEqual({
      number: null,
      forge: null
    })
  })
})

describe('extractRevertTargets', () => {
  it('extracts targets quoted inside GitHub revert subjects', () => {
    expect(extractRevertTargets('Revert "feat: x (#123)" (#200)')).toEqual({
      targets: [123],
      quotedTitle: 'feat: x (#123)'
    })
  })

  it('extracts unquoted targets, excluding the revert PR itself', () => {
    expect(extractRevertTargets('Revert #12658: show PR status (#12825)')).toEqual({
      targets: [12658],
      quotedTitle: null
    })
  })

  it('extracts multiple targets from one revert', () => {
    expect(
      extractRevertTargets('Revert terminal changes from #10692 and #10794 (#11338)').targets
    ).toEqual([10692, 10794])
  })

  it('extracts GitLab revert targets from the body trailer', () => {
    expect(
      extractRevertTargets('Revert "Resolve login bug"', 'This reverts merge request !456')
    ).toEqual({ targets: [456], quotedTitle: 'Resolve login bug' })
  })

  it('extracts GitHub revert targets from the PR-UI body trailer', () => {
    expect(extractRevertTargets('Revert "feat: x" (#456)', 'Reverts stablyai/orca#123')).toEqual({
      targets: [123],
      quotedTitle: 'feat: x'
    })
  })

  it('returns the quoted title alone when no number is recoverable', () => {
    expect(extractRevertTargets('Revert "Improve startup timing"')).toEqual({
      targets: [],
      quotedTitle: 'Improve startup timing'
    })
  })

  it('returns nothing for non-revert subjects', () => {
    expect(extractRevertTargets('fix(a): b (#9)')).toEqual({ targets: [], quotedTitle: null })
  })
})
