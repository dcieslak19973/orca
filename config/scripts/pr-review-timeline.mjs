// Fetches review-timeline counts for merged PRs over the backtest window and caches them as
// JSONL. The backtest itself stays offline and zero-API-call; this is the one script that
// talks to the forge, it is resumable, and the residual analysis reads only its cache.
// Usage: node config/scripts/pr-review-timeline.mjs --out <file.jsonl> [--since YYYY-MM-DD]
//        [--repo owner/name] [--page-size 50] [--max-pages 400]
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const QUERY = `query($owner:String!,$name:String!,$size:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED,first:$size,after:$after,orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{
        number createdAt mergedAt changedFiles additions deletions
        author{ login }
        reviews(first:50){ totalCount nodes{ state submittedAt author{ login } } }
        reviewThreads(first:1){ totalCount }
        comments(first:1){ totalCount }
        commits(first:1){ totalCount }
      }
    }
  }
}`

/** Collapse one PR's review nodes into the counts the residual model needs. */
export function summarizeReviews(pr) {
  const nodes = pr.reviews?.nodes ?? []
  const reviewers = new Set()
  let changesRequested = 0
  let approvals = 0
  let firstReviewAt = null
  for (const r of nodes) {
    if (r.author?.login) {
      reviewers.add(r.author.login)
    }
    if (r.state === 'CHANGES_REQUESTED') {
      changesRequested += 1
    }
    if (r.state === 'APPROVED') {
      approvals += 1
    }
    if (r.submittedAt && (firstReviewAt === null || r.submittedAt < firstReviewAt)) {
      firstReviewAt = r.submittedAt
    }
  }
  // Why 1 + changes-requested: a round is one pass over the diff, and every
  // changes-requested review forces another. Robust to calendar noise in a way hours-open
  // is not; the fetched review and thread counts let the alternates be checked.
  return {
    number: pr.number,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    author: pr.author?.login ?? null,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    commits: pr.commits?.totalCount ?? 0,
    reviews: pr.reviews?.totalCount ?? 0,
    reviewNodes: nodes.length,
    changesRequested,
    approvals,
    rounds: 1 + changesRequested,
    reviewers: [...reviewers],
    threads: pr.reviewThreads?.totalCount ?? 0,
    comments: pr.comments?.totalCount ?? 0,
    firstReviewAt,
    hoursOpen:
      pr.mergedAt && pr.createdAt
        ? (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3600_000
        : null
  }
}

function graphql({ owner, name, size, after }) {
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `size=${size}`
  ]
  if (after) {
    args.push('-F', `after=${after}`)
  }
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  const parsed = JSON.parse(raw)
  if (parsed.errors) {
    throw new Error(`GraphQL: ${parsed.errors.map((e) => e.message).join('; ')}`)
  }
  return parsed.data.repository.pullRequests
}

function main() {
  const args = process.argv.slice(2)
  const argOf = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i === -1 ? fallback : args[i + 1]
  }
  const out = argOf('--out', null)
  if (!out) {
    console.error('--out <file.jsonl> is required')
    process.exit(2)
  }
  const [owner, name] = argOf('--repo', 'stablyai/orca').split('/')
  const since = argOf('--since', '2026-04-01')
  const size = Number(argOf('--page-size', '50'))
  const maxPages = Number(argOf('--max-pages', '400'))
  const statePath = `${out}.state.json`

  let after = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).cursor : null
  let fetched = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).length : 0
  if (!existsSync(out)) {
    writeFileSync(out, '')
  }
  console.log(`${owner}/${name}: paging merged PRs created since ${since} (resume=${!!after})`)

  for (let page = 0; page < maxPages; page += 1) {
    const result = graphql({ owner, name, size, after })
    const rows = result.nodes.map(summarizeReviews)
    appendFileSync(out, rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
    fetched += rows.length
    const oldest = rows.at(-1)?.createdAt ?? ''
    after = result.pageInfo.endCursor
    writeFileSync(statePath, JSON.stringify({ cursor: after, oldest, fetched }))
    console.log(`  page ${page + 1}: ${fetched} PRs, oldest createdAt ${oldest.slice(0, 10)}`)
    if (!result.pageInfo.hasNextPage || oldest.slice(0, 10) < since) {
      console.log(`done: ${fetched} PRs cached in ${out}`)
      return
    }
  }
  console.log(`stopped at --max-pages; ${fetched} PRs cached. Re-run to resume.`)
}

if (import.meta.main) {
  main()
}
