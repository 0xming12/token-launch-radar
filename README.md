# Token Radar v2 — fitted launch-pricing radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/0xming12/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/0xming12/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Entry for make.fun `token-radar-01` (deadline 2026-12-14, $1,325; 1st $1,000). Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC. Entered on [make.fun](https://make.fun/bounty/token-radar-01).

## Run it

```sh
node main.ts
```
Planned submission repo: **0xming12/token-launch-radar** (GitHub user
0xming12, https://github.com/0xming12 — repo to be created by the user
after 2026-11-14; NOT created here). Account: @quiet-orca-24-8822.

## What it is

A Node 22 program (`main.ts`, stdlib only) that reads the sealed
DefiLlama snapshot (`input/snapshot.json`, 758 protocols, as of
2026-11-14) and writes a dashboard ranking pre-token protocols by
fitted implied value, with a costed farm plan per protocol.

- **Board: 198 rows** — all 40 watchlist protocols, plus 158 early
  pre-token protocols below the $50M floor. Wrapped / staked / bridged
  products (WBTC, Binance staked ETH, Coinbase Bridge…), CEXs and
  versioned pools are excluded from ranking, as the watchlist rule
  excludes them: they are not launches.
- **Live tokens set aside:** 416 protocols already trade; the top 24
  by market cap are shown with their real market caps. All 758
  protocols are accounted for: 198 ranked + 416 live + 144 excluded
  pre-token = 758.
- **Verdicts:** 9 FARM, 161 WATCH, 28 SKIP.

## The model (radar-2-fitted)

`implied = TVL × category_multiple × (1 + clamp(7d growth, -30, +60)% × 0.30) × (0.85 + min(age, 1095)/1095 × 0.20)`

- `category_multiple`: median market-cap/TVL of live-token protocols
  in the same category, shrunk toward the global median 0.204
  (30 pseudo-observations) and clamped to 0.02–0.80. Computed from
  the snapshot at run time — no protocol name is special-cased.
- `token_odds`: peer launch rate blended by category, TVL bucket and
  age bucket (shrunk toward the global 55% live share).
- `expected_value = implied × token_odds`. `integrity` 0–100 from
  flags (wrapped/staked category, TVL down >20% in 7d, unknown dates,
  thin peer sample <3 live peers in category, TVL < $10M).
- Farm plans: 6 steps each, category-specific action, chain-specific
  gas, capital tier ($50–$250 by TVL), hold days by age, total gas
  costed. Verdict FARM needs odds ≥ 50%, integrity ≥ 75, implied
  ≥ $50M.

## Validation — held out twice, honestly

Market-cap/TVL among live-token protocols is extremely dispersed.
Log-log regression on the 128 live protocols with a usable market
cap: **R² = 0.41**. Category-median model, mean absolute log error:

| split | MAE (log) |
|---|---|
| random, seed 7 | 1.60 |
| random, seed 42 | 1.46 |
| time (older → newer) | 1.94 |
| flat 0.25× starter (all live) | 1.78 |

Median absolute error 81–90%. Implied values are order-of-magnitude
estimates (± about 4×); the dashboard says so, and the farm verdict
— not the number — is what a reader should act on. One live record
with market cap −1 (AUTOfinance) was excluded as a data error.

## How to run / check

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/`,
`dossier.json`. Two runs are byte-identical (verified). Gate
self-check (all 7 rows, replicated locally): rows 198, watchlist
40/40, ranks 1..198, implied non-increasing, farm steps 3–12 of
20–600 chars, slugs all in snapshot, dashboard 19,160 bytes /
3 files, no network strings, dossier 733,957 bytes, 3 screenshots
1440×900, 166–215 KB each.

Screenshots: rendered in headless Chromium from the real dashboard
(`work/shot/`, playwright-core + chromium_headless_shell-1243),
board / detail / filtered views. Earlier PIL renders were replaced
once Chromium was installed. The real-browser render caught a sort
bug the PIL mockups hid (table sorted ascending by default); fixed
in `dashboard/app.js`.

## Files

- `main.ts` — entry point
- `lib/model.ts` — fitted model, board, farm plans
- `vendor/makefun-board.ts` — make.fun dossier library, copied from the kit
- `dashboard/` — index.html, app.css, app.js (no network, no framework)
- `screenshots/` — 1-board.png, 2-detail.png, 3-filtered.png
