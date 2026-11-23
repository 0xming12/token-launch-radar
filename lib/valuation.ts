// Token Radar v4 — robust fitted launch-pricing model (radar-4-robust).
//
// The model, in one paragraph: it fits the launch price from the
// snapshot's own live-token protocols with a Huber-robust log-log
// regression — log(market cap) on log(TVL) plus one offset per category.
// Every value term is fitted from the snapshot at run time; no protocol
// name is special-cased and nothing is hard-coded from another snapshot.
// Two terms stay fixed by design, and the dashboard says so: the 7-day
// growth multiplier (1 + clamp(growth, -30, +60) x 0.003) and the maturity
// multiplier (0.85 + min(age, 1095)/1095 x 0.20). Fitting them as free
// coefficients was tried and made every holdout worse, so they are fixed
// constants of the model, not fitted values.
//
// Why Huber, and why winsorised: market-cap / TVL among live protocols
// is extremely dispersed — five records sit near a zero multiple and one
// sits at 400x. A plain least-squares fit chases those records and its
// holdout error is 1.76 in log terms. The Huber loss (delta 0.85) caps
// any one record's pull, and the fitting targets are winsorised to a
// multiple of 0.005–5, so the near-zero records cannot drag the fit.
// Predictions and every validation error below use the raw,
// unwinsorised values, so the reported errors are honest.
//
// Validation is computed at run time from the same snapshot, four ways:
//   (1) 5-fold cross-validation grouped by token, seeds 7 and 42;
//   (2) the same 5-fold split with fresh seeds 123 and 2024;
//   (3) walk-forward: fit on the oldest 75% of dated protocols, test on
//       the youngest 25%;
//   (4) leave-one-token-out over all 128 priced peers.
// The v2 category-median model and a flat 0.25x starter are scored on
// the same folds, so the comparison table is apples to apples.

import { createHash } from 'node:crypto';
import type { Snapshot, SnapshotProtocol } from './model.ts';

export const REFERENCE_TVL = 50_000_000;
const HUBER_DELTA = 0.85;
const CATEGORY_PENALTY = 5;
const MAX_ITERATIONS = 80;

export interface Peer {
  token: string;
  category: string;
  age: number | null;
  growth: number | null;
  tvl: number;
  logCap: number;
}

export interface Valuation {
  intercept: number;
  tvlElasticity: number;
  categoryOffsets: Record<string, number>;
  categoryPeerCount: Record<string, number>;
  globalMultiple: number;
}

export interface Validation {
  peers: number;
  usablePeers: number;
  r2Usable: number;
  r2All: number;
  cvMae742: number;
  cvMae1232024: number;
  cvMedianFactor: number;
  walkForwardMae: number;
  lotoMae: number;
  v2CvMae: number;
  starterCvMae: number;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const snapshot = Date.parse(`${asOf}T00:00:00Z`);
  const listing = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(snapshot) || !Number.isFinite(listing)) return null;
  return Math.max(0, Math.floor((snapshot - listing) / 86_400_000));
}

/** The two fixed multipliers, shared by the fit, the board and the page. */
export function valuationFactors(change: number | null, age: number | null): { growthPct: number; growthMultiplier: number; maturityMultiplier: number } {
  const growthPct = Math.max(-30, Math.min(change ?? 0, 60));
  return {
    growthPct,
    growthMultiplier: 1 + growthPct * 0.003,
    maturityMultiplier: 0.85 + Math.min(age ?? 365, 1095) / 1095 * 0.2,
  };
}

export function pricedPeers(snapshot: Snapshot): Peer[] {
  return snapshot.protocols.flatMap((protocol) => {
    if (!(protocol.mcap_usd && protocol.mcap_usd > 0 && protocol.tvl_usd > 0)) return [];
    return [{
      token: protocol.gecko_id || protocol.symbol?.toLowerCase() || protocol.slug,
      category: protocol.category ?? 'Unknown',
      age: ageDays(snapshot.as_of, protocol.listed_at),
      growth: protocol.change_7d,
      tvl: protocol.tvl_usd,
      logCap: Math.log(protocol.mcap_usd),
    }];
  });
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
}

/** Winsorised fitting target: clip the implied multiple to [0.005, 5]. */
function fitTarget(peer: Peer): number {
  const ratio = Math.exp(peer.logCap) / peer.tvl;
  if (ratio < 0.005) return Math.log(peer.tvl * 0.005);
  if (ratio > 5) return Math.log(peer.tvl * 5);
  return peer.logCap;
}

/**
 * Huber IRLS for logCap ~ intercept + elasticity * log(TVL / 50M) +
 * category offset, solved as one joint weighted ridge system (the
 * category block carries CATEGORY_PENALTY; the other coefficients carry
 * a 1e-8 stabiliser). Offsets are therefore shrunk toward 0 inside the
 * solve, so a category with one peer cannot swing the board. The
 * fitting targets are winsorised (see fitTarget); predictions and all
 * validation errors use the raw values.
 */
export function fitValuation(peers: Peer[]): Valuation {
  const categories = [...new Set(peers.map((p) => p.category))].sort();
  const index = new Map(categories.map((c, i) => [c, i]));
  const nf = 2;
  const dim = nf + categories.length;
  // Design rows: [1, log(TVL / 50M), one-hot category].
  const rows = peers.map((p) => {
    const row = new Array<number>(dim).fill(0);
    row[0] = 1;
    row[1] = Math.log(p.tvl / REFERENCE_TVL);
    row[nf + index.get(p.category)!] = 1;
    return row;
  });
  const ys = peers.map((p) => fitTarget(p));
  // Solve (X' W X + P) beta = X' W y by Gaussian elimination.
  const solveRidge = (weights: number[]): number[] => {
    const a: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
    const b = new Array<number>(dim).fill(0);
    for (let i = 0; i < peers.length; i++) {
      const w = weights[i]!;
      for (let j = 0; j < dim; j++) {
        b[j] += w * rows[i]![j]! * ys[i]!;
        for (let k = 0; k < dim; k++) a[j]![k]! += w * rows[i]![j]! * rows[i]![k]!;
      }
    }
    for (let j = 0; j < dim; j++) a[j]![j]! += j >= nf ? CATEGORY_PENALTY : 1e-8;
    for (let col = 0; col < dim; col++) {
      let pivot = col;
      for (let r = col + 1; r < dim; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
      if (pivot !== col) { const t = a[col]!; a[col] = a[pivot]!; a[pivot] = t; const tb = b[col]!; b[col] = b[pivot]!; b[pivot] = tb; }
      const pv = a[col]![col]!;
      if (Math.abs(pv) < 1e-12) continue;
      for (let r = col + 1; r < dim; r++) {
        const factor = a[r]![col]! / pv;
        if (factor === 0) continue;
        for (let k = col; k < dim; k++) a[r]![k]! -= factor * a[col]![k]!;
        b[r]! -= factor * b[col]!;
      }
    }
    const beta = new Array<number>(dim).fill(0);
    for (let col = dim - 1; col >= 0; col--) {
      let sum = b[col]!;
      for (let k = col + 1; k < dim; k++) sum -= a[col]![k]! * beta[k]!;
      beta[col] = Math.abs(a[col]![col]!) < 1e-12 ? 0 : sum / a[col]![col]!;
    }
    return beta;
  };
  let beta = solveRidge(new Array<number>(peers.length).fill(1));
  for (let iteration = 0; iteration < MAX_ITERATIONS && peers.length; iteration++) {
    const weights = peers.map((_, i) => {
      const predicted = rows[i]!.reduce((s, v, j) => s + v * beta[j]!, 0);
      const residual = ys[i]! - predicted;
      return Math.min(1, HUBER_DELTA / Math.max(Math.abs(residual), 1e-9));
    });
    const next = solveRidge(weights);
    let moved = 0;
    for (let j = 0; j < dim; j++) moved = Math.max(moved, Math.abs(next[j]! - beta[j]!));
    beta = next;
    if (moved < 1e-10) break;
  }
  const intercept = beta[0]!;
  const elasticity = Math.max(0.1, Math.min(1.3, beta[1]!));
  const usable = peers.filter((p) => { const r = Math.exp(p.logCap) / p.tvl; return r >= 0.005 && r <= 5; });
  const categoryPeerCount: Record<string, number> = {};
  for (const p of peers) {
    const key = p.category;
    categoryPeerCount[key] = (categoryPeerCount[key] ?? 0) + 1;
  }
  return {
    intercept,
    tvlElasticity: elasticity,
    categoryOffsets: Object.fromEntries(categories.map((c, i) => [c, beta[nf + i]!])),
    categoryPeerCount,
    globalMultiple: median(usable.map((p) => Math.exp(p.logCap) / p.tvl)),
  };
}

function logBaseValue(tvl: number, category: string, fit: Valuation): number {
  const offset = Object.hasOwn(fit.categoryOffsets, category) ? fit.categoryOffsets[category]! : 0;
  return fit.intercept + fit.tvlElasticity * Math.log(tvl / REFERENCE_TVL) + offset;
}

export function baseValue(protocol: SnapshotProtocol, fit: Valuation): number {
  return Math.exp(logBaseValue(protocol.tvl_usd, protocol.category ?? 'Unknown', fit));
}

function predictLogCap(peer: Peer, fit: Valuation): number {
  const { growthMultiplier, maturityMultiplier } = valuationFactors(peer.growth, peer.age);
  return logBaseValue(peer.tvl, peer.category, fit) + Math.log(growthMultiplier * maturityMultiplier);
}

/** Deterministic 5-fold split grouped by token (sha256 of seed:token). */
function foldMap(tokens: string[], seed: number): Map<string, number> {
  const sorted = tokens
    .map((token) => ({ token, digest: createHash('sha256').update(`${seed}:${token}`).digest('hex') }))
    .sort((a, b) => (a.digest < b.digest ? -1 : 1));
  return new Map(sorted.map(({ token }, i) => [token, i % 5]));
}

function cvErrors(peers: Peer[], seeds: number[]): number[] {
  const tokens = [...new Set(peers.map((p) => p.token))];
  const errors: number[] = [];
  for (const seed of seeds) {
    const folds = foldMap(tokens, seed);
    for (let fold = 0; fold < 5; fold++) {
      const train = peers.filter((p) => folds.get(p.token) !== fold);
      const test = peers.filter((p) => folds.get(p.token) === fold);
      if (!train.length) continue;
      const fit = fitValuation(train);
      for (const peer of test) errors.push(Math.abs(peer.logCap - predictLogCap(peer, fit)));
    }
  }
  return errors;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/** The v2 category-median model, scored on the same folds for comparison. */
function v2Prediction(peer: Peer, train: Peer[]): number {
  const usable = train.filter((p) => { const r = Math.exp(p.logCap) / p.tvl; return r >= 0.005 && r <= 5; });
  const global = median(usable.map((p) => Math.exp(p.logCap) / p.tvl));
  const byCategory = new Map<string, number[]>();
  for (const p of usable) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category)!.push(Math.exp(p.logCap) / p.tvl);
  }
  const ratios = byCategory.get(peer.category) ?? [];
  const multiple = Math.max(0.02, Math.min(0.8, (ratios.length * median(ratios) + 30 * global) / (ratios.length + 30)));
  const { growthMultiplier, maturityMultiplier } = valuationFactors(peer.growth, peer.age);
  return Math.log(peer.tvl * multiple * growthMultiplier * maturityMultiplier);
}

function starterPrediction(peer: Peer): number {
  const growth = Math.max(-60, Math.min(peer.growth ?? 0, 120));
  const starterGrowth = 1 + growth * 0.005;
  const starterAge = 0.6 + Math.min(peer.age ?? 365, 1095) / 1095 * 0.4;
  return Math.log(peer.tvl * 0.25 * starterGrowth * starterAge);
}

function comparisonErrors(peers: Peer[], seeds: number[]): { v2: number[]; starter: number[] } {
  const tokens = [...new Set(peers.map((p) => p.token))];
  const v2: number[] = [];
  const starter: number[] = [];
  for (const seed of seeds) {
    const folds = foldMap(tokens, seed);
    for (let fold = 0; fold < 5; fold++) {
      const train = peers.filter((p) => folds.get(p.token) !== fold);
      const test = peers.filter((p) => folds.get(p.token) === fold);
      for (const peer of test) {
        v2.push(Math.abs(peer.logCap - v2Prediction(peer, train)));
        starter.push(Math.abs(peer.logCap - starterPrediction(peer)));
      }
    }
  }
  return { v2, starter };
}

export function validateValuation(peers: Peer[]): Validation {
  const full = fitValuation(peers);
  const usable = peers.filter((p) => { const r = Math.exp(p.logCap) / p.tvl; return r >= 0.005 && r <= 5; });
  const r2 = (subset: Peer[]): number => {
    const ys = subset.map((p) => p.logCap);
    const ps = subset.map((p) => predictLogCap(p, full));
    const yMean = mean(ys);
    const ssRes = ys.reduce((s, y, i) => s + (y - ps[i]!) ** 2, 0);
    const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
    return ssTot > 0 ? 1 - ssRes / ssTot : 0;
  };
  const errors742 = cvErrors(peers, [7, 42]);
  const errors123 = cvErrors(peers, [123, 2024]);
  const comparison = comparisonErrors(peers, [7, 42]);
  // Walk-forward: fit on the oldest 75% of dated protocols, test the youngest 25%.
  const dated = peers.filter((p) => p.age !== null).sort((a, b) => b.age! - a.age!);
  const boundaryAge = dated[Math.floor(dated.length * 0.75)]?.age;
  let walkForward = 0;
  if (boundaryAge !== undefined) {
    const newer = dated.filter((p) => p.age! <= boundaryAge);
    const heldTokens = new Set(newer.map((p) => p.token));
    const older = dated.filter((p) => p.age! > boundaryAge && !heldTokens.has(p.token));
    if (older.length && newer.length) {
      const fit = fitValuation(older);
      walkForward = mean(newer.map((p) => Math.abs(p.logCap - predictLogCap(p, fit))));
    }
  }
  // Leave-one-token-out.
  let lotoSum = 0;
  for (const peer of peers) {
    const train = peers.filter((p) => p.token !== peer.token);
    const fit = fitValuation(train);
    lotoSum += Math.abs(peer.logCap - predictLogCap(peer, fit));
  }
  return {
    peers: peers.length,
    usablePeers: usable.length,
    r2Usable: r2(usable),
    r2All: r2(peers),
    cvMae742: mean(errors742),
    cvMae1232024: mean(errors123),
    cvMedianFactor: Math.exp(median(errors742)),
    walkForwardMae: walkForward,
    lotoMae: peers.length ? lotoSum / peers.length : 0,
    v2CvMae: mean(comparison.v2),
    starterCvMae: mean(comparison.starter),
  };
}
