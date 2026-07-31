# Live remote bulk-open freeze repro

Isolated recipe for the Tim/Expand + Brandon/Uber class freezes:

> **“just opening my remote sessions again”** on a large Remote Server / multi-session remote fleet.

Hard freeze was hit in-lab by concurrent bulk `orca terminal switch` against a large paired remote.

## Prerequisites

1. **Desktop Orca running** and reachable (`orca status --json`).
2. A **paired remote environment** with a large fleet (many worktrees / terminals).  
   Example used in lab: `awin` (~60 worktrees, ~100+ terminals).
3. From an **orca repo checkout** (this branch), Node available for the harness script.

Check remotes:

```bash
orca environment list --json
orca worktree list --environment <name> --json | head
orca terminal list --environment <name> --json | head
```

## Quick start (hard freeze recipe)

From the repo root:

```bash
# HARD freeze amplification (proven 2026-07-31 on awin)
ORCA_FREEZE_ENV=awin \
ORCA_FREEZE_CREATE=0 \
ORCA_FREEZE_SWITCH_PASSES=3 \
ORCA_FREEZE_PARALLEL=16 \
pnpm run repro:live-remote-bulk-open-freeze
```

Or directly:

```bash
ORCA_FREEZE_ENV=<your-remote> \
ORCA_FREEZE_CREATE=0 \
ORCA_FREEZE_SWITCH_PASSES=3 \
ORCA_FREEZE_PARALLEL=16 \
node config/scripts/live-remote-bulk-open-freeze-repro.mjs
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No freeze signal under thresholds |
| 1 | Soft freeze (peak ≥ 2s) |
| 2 | **Hard freeze (peak ≥ 5s)** |
| 3 | Harness failure |

### Outputs

- `test-results/freeze-repro/live-bulk-open-freeze-<env>.json` — machine-readable report
- `test-results/freeze-repro/live-bulk-open-freeze-<env>-peak-<ts>.json` — stamped copy
- `test-results/freeze-repro/orca-sample-*.txt` — `sample Orca` when freeze trips (macOS)

## Env knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `ORCA_FREEZE_ENV` | `awin` | `orca environment` name |
| `ORCA_FREEZE_CREATE` | `6` | New flood terminals to spawn on remote worktrees |
| `ORCA_FREEZE_SWITCH_PASSES` | `3` | Full passes over switch targets |
| `ORCA_FREEZE_PARALLEL` | `1` | Concurrent `terminal switch` batch size (**raise to 16 for hard freeze**) |
| `ORCA_FREEZE_MAX_SWITCH_TARGETS` | `0` | Cap targets; **0 = no cap (all live terminals)** |
| `ORCA_FREEZE_SOFT_MS` | `2000` | Soft threshold (ms) |
| `ORCA_FREEZE_HARD_MS` | `5000` | Hard threshold (ms) |
| `ORCA_FREEZE_PRE_FLOOD_MS` | `3000` | Wait after creates for backlog to build |
| `ORCA_FREEZE_CREATE_WT_SPAN` | `16` | How many worktrees to spread creates across |

## Softer / control runs

```bash
# Soft freeze (sequential / modest load) — often ~3–4s on large fleets
ORCA_FREEZE_ENV=awin ORCA_FREEZE_CREATE=0 ORCA_FREEZE_SWITCH_PASSES=2 ORCA_FREEZE_PARALLEL=1 \
  pnpm run repro:live-remote-bulk-open-freeze

# Control: smaller remote should stay snappy
ORCA_FREEZE_ENV=ubuntu-jinjing ORCA_FREEZE_CREATE=0 ORCA_FREEZE_SWITCH_PASSES=2 ORCA_FREEZE_PARALLEL=1 \
  pnpm run repro:live-remote-bulk-open-freeze
```

## What it measures

- Lists live terminals on the remote environment.
- Optionally creates continuous flood terminals (`node` writing ~2KB frames every 8ms).
- Bulk-opens sessions via concurrent `orca terminal switch --environment <env>`.
- Peak latency = max(individual switch ms, concurrent batch wall ms).
- Soft ≥ 2s, hard ≥ 5s.

This matches the trusted Slack trigger (burst open remote sessions under large multi-session load). CLI switch latency is a **proxy** for UI freeze on the same bulk-open path.

## Lab result (2026-07-31)

| Run | Env | Terminals | parallel | peak | Signal |
|-----|-----|-----------|----------|------|--------|
| sequential | awin | ~100 | 1 | 3.3–3.9s | soft |
| **parallel bulk-open** | **awin** | **111** | **16** | **~20.2s** | **HARD** |
| control | ubuntu-jinjing | few | 1 | ~0.2s | none |

Client: Orca 1.4.163. Remote serve: 1.4.163-rc.0.

## Files

| Path | Role |
|------|------|
| `config/scripts/live-remote-bulk-open-freeze-repro.mjs` | Main harness |
| `config/scripts/live-remote-bulk-open-freeze-metrics.mjs` | Thresholds / handle extract |
| `config/scripts/live-remote-bulk-open-freeze-metrics.test.mjs` | Unit tests |
| `pnpm run repro:live-remote-bulk-open-freeze` | package.json entry |

Optional e2e (isolated Electron; may need working e2e store hydrate):

- `tests/e2e/remote-session-bulk-open-freeze-repro.spec.ts`
- `tests/e2e/ssh-docker-bulk-open-freeze-repro.spec.ts`

## Manual capture if the UI fully freezes

```bash
sample Orca 5 -file ~/Desktop/orca-freeze-sample.txt
# Help → Report Crash
```

## Safety

- Prefer **read + switch** (`CREATE=0`) on shared remotes.
- Creates add flood terminals; clean up later if needed (`orca terminal list/stop` on that environment).
- Do not point this at production-critical remotes without coordination.
