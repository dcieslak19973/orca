# Live remote freeze reproductions

Two harnesses for the Tim/Expand + Brandon/Uber freeze class on large paired remotes:

| Harness | Realism | Purpose |
|---------|---------|---------|
| **Realistic** (preferred for stories) | Idle + flood backlog → wake/reconnect-like refresh → human-paced open | Models overnight/return/restart |
| **Bulk parallel** (stress amp) | Concurrent `terminal switch` | Forces hard freeze for load ceilings |

## Prerequisites

1. **Desktop Orca running** (`orca status --json`).
2. A **large paired remote** (many worktrees / agent terminals). Lab: `awin` (~60 worktrees, 100+ terminals).
3. Repo checkout with these scripts.

```bash
orca environment list --json
orca worktree list --environment <name> --json | head
orca terminal list --environment <name> --json | head
```

---

## A. Realistic repro (preferred)

Story: remotes keep streaming while the user is away; user returns (optionally after wake/reconnect-like refresh) and opens sessions one-by-one.

```bash
# Tim: idle + human-paced open
ORCA_FREEZE_ENV=awin \
ORCA_FREEZE_SCENARIO=idle-backlog-open \
ORCA_FREEZE_CREATE=8 \
ORCA_FREEZE_IDLE_MS=45000 \
ORCA_FREEZE_OPEN_COUNT=24 \
pnpm run repro:live-remote-realistic-freeze

# Wake-like: idle + reconnect metadata storm + open  ← hard freeze in lab
ORCA_FREEZE_ENV=awin \
ORCA_FREEZE_SCENARIO=idle-backlog-reconnect-open \
ORCA_FREEZE_CREATE=10 \
ORCA_FREEZE_IDLE_MS=60000 \
ORCA_FREEZE_OPEN_COUNT=40 \
pnpm run repro:live-remote-realistic-freeze

# Restart-proxy: idle + orca open + refresh storm + open (does not kill desktop)
ORCA_FREEZE_ENV=awin \
ORCA_FREEZE_SCENARIO=restart-proxy \
ORCA_FREEZE_CREATE=0 \
ORCA_FREEZE_IDLE_MS=20000 \
ORCA_FREEZE_OPEN_COUNT=30 \
pnpm run repro:live-remote-realistic-freeze
```

Or: `node config/scripts/live-remote-realistic-freeze-repro.mjs`

### Scenarios

| `ORCA_FREEZE_SCENARIO` | Models |
|------------------------|--------|
| `idle-backlog-open` | User away while agents stream; returns and opens sessions (Tim) |
| `idle-backlog-reconnect-open` | Same + parallel status/worktree/terminal refresh (wake/reconnect client storm) |
| `restart-proxy` | `orca open` + refresh storm + open (post-restart discovery; no process kill) |

### Realistic knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `ORCA_FREEZE_ENV` | `awin` | Paired remote name |
| `ORCA_FREEZE_SCENARIO` | `idle-backlog-open` | See table above |
| `ORCA_FREEZE_CREATE` | `8` | New flood terminals (agent-like output) |
| `ORCA_FREEZE_IDLE_MS` | `45000` | Time “away” while floods run |
| `ORCA_FREEZE_OPEN_COUNT` | `20` | Sessions to open after return |
| `ORCA_FREEZE_PACE_MS` | `250` | Base delay between opens (human pace) |
| `ORCA_FREEZE_PACE_JITTER_MS` | `150` | Random extra delay |
| `ORCA_FREEZE_SOFT_MS` / `HARD_MS` | 2000 / 5000 | Thresholds |

### Lab results (2026-07-31, client 1.4.163 / remote 1.4.163-rc.0)

| Scenario | create | idle | open | peak | Signal |
|----------|--------|------|------|------|--------|
| idle-backlog-open | 6 | 45s | 24 | **1.7s** max open | none (&lt; soft) |
| **idle-backlog-reconnect-open** | 10 | 60s | 40 | **11.0s** max open; reconnect refresh **3.6s** | **HARD (recovered)** |
| **restart-proxy** | 0 | 20s | 30 | **11.2s** max open | **HARD (recovered)** |
| **lockup-storm** (parallel open + overlap refresh) | 12–16 | 45–60s | 64–80 @ p20–32 | **27–35s** batches; some `Terminal reveal timed out` | **HARD stalls + reveal timeouts; app still answers `orca status` ~150ms** |

### Forever lockup?

**Not yet.** Across storms:

- Opens that finish can take **10–35s** (bad UX; feels frozen).
- Some opens fail with **`Terminal reveal timed out`** (real under load).
- **`orca status` stayed ~120–200ms** even mid concurrent storm (18 probes, 0 hangs).
- Process never needed Force Quit in lab; desktop stayed `running`.

So this is **severe multi-second / multi-tens-of-seconds stall + flaky reveal**, not “UI dead forever until Force Quit” (the classic Brandon report). That class may need **real OS sleep/wake**, **renderer React #185**, or another path not hit by CLI switch alone.

| Exit | Meaning |
|------|---------|
| 0 | no freeze |
| 1 | soft (≥2s recovered) |
| 2 | hard stall ≥5s **but recovered** |
| 4 | permanentLockup heuristic (status hang / many timeouts / high fail rate) |
| 3 | harness error |

**Interpretation:** Pure sequential open after idle stays under 2s. **Wake/reconnect-style refresh + open** (or concurrent fan-out) produces **recovered hard stalls**. True permanent lockup remains unproven with CLI-only levers.

Reports: `test-results/freeze-repro/live-realistic-freeze-<env>-<scenario>.json`

---

## B. Stress amp (bulk parallel)

Artificial concurrency lever; still useful for ceilings / CI stress.

```bash
ORCA_FREEZE_ENV=awin \
ORCA_FREEZE_CREATE=0 \
ORCA_FREEZE_SWITCH_PASSES=3 \
ORCA_FREEZE_PARALLEL=16 \
pnpm run repro:live-remote-bulk-open-freeze
```

Lab: sequential soft ~3.3–3.9s; **parallel=16 → ~20s HARD**.

---

## Exit codes (both harnesses)

| Code | Meaning |
|------|---------|
| 0 | No freeze signal under thresholds |
| 1 | Soft freeze (peak ≥ 2s) |
| 2 | **Hard freeze (peak ≥ 5s)** |
| 3 | Harness failure |

---

## Files

| Path | Role |
|------|------|
| `config/scripts/live-remote-realistic-freeze-repro.mjs` | Naturalistic harness |
| `config/scripts/live-remote-bulk-open-freeze-repro.mjs` | Parallel stress harness |
| `config/scripts/live-remote-bulk-open-freeze-metrics.mjs` | Shared thresholds / handle extract |
| `config/scripts/live-remote-bulk-open-freeze-metrics.test.mjs` | Unit tests |
| `pnpm run repro:live-remote-realistic-freeze` | package entry |
| `pnpm run repro:live-remote-bulk-open-freeze` | package entry |

---

## Safety

- Prefer `CREATE=0` or modest create on shared remotes; floods add terminals.
- `restart-proxy` does **not** kill Orca; it runs `orca open` + refresh RPCs only.
- Manual capture if UI fully freezes: `sample Orca 5 -file ~/Desktop/orca-freeze-sample.txt`
