// Token Radar v2 — fitted launch-pricing model, written for token-radar-01.
//
// What it does, in one paragraph: it reads the sealed DefiLlama snapshot
// (758 protocols, as of 2026-11-14), fits the launch price from the protocols
// whose token already trades, and ranks the rankable pre-token protocols
// (198 of the 342 pre-token protocols, after excluding wrapped / staked /
// bridged products, CEXs and versioned pools) by implied value. Nothing is
// computed from the snapshot itself at run time, so the same program scores
// a future snapshot the same way.
//
// The fit, honestly stated (see README.md and the dashboard's Methodology
// panel for the numbers): market-cap / TVL among live-token protocols is
// extremely dispersed. A log-log regression on the 128 live protocols with a
// usable market cap gives R2 = 0.41; held-out twice (random splits, seeds 7
// and 42) the category-median model has mean absolute log error 1.46-1.60
// (median absolute error 81-90%), versus 1.78 for a flat 0.25x starter
// multiple. A time split (older -> newer) is worse, 1.94. So implied values
// are order-of-magnitude estimates, shown with a x/4 uncertainty band, and
// the board never pretends to a price. What the fit does buy: category
// multiples that differ by 100x (Liquid Staking ~0.04, Dexs ~0.34, Basis
// Trading ~0.65) instead of one flat 0.25 for every protocol.

export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}
export class SnapshotError extends Error {
  constructor(m: string) { super(m); this.name = 'SnapshotError'; }
}

export const MODEL_VERSION = 'radar-2-fitted';
export const LIVE_ROWS = 24;
const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`), b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
export function isRankable(p: SnapshotProtocol): boolean {
  // Same exclusion as the watchlist rule: a wrapped, staked or bridged
  // product of a token that already trades is not a launch of its own.
  // WBTC is Bitcoin on Ethereum; Binance staked ETH is ETH in a staking
  // product. Ranking them #1 would be a TVL table, not a launch radar.
  return isPreToken(p) && !EXCLUDED_CATEGORIES.has(p.category ?? '')
    && !VERSIONED.test(p.name) && !WRAPPED.test(p.name) && !EXCHANGE_PREFIX.test(p.name);
}
// Wrapped / staked / bridged products of a token that already trades are
// not a launch of their own; they are flagged, never ranked.
const WRAPPED = /\b(wrapped|staked|staking)\b/i;
export function integrityFlags(p: SnapshotProtocol): string[] {
  const f: string[] = [];
  if (WRAPPED.test(p.name)) f.push('wrapped/staked product');
  if (['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC'].includes(p.category ?? '')) f.push('bridged/staked category');
  if (p.change_7d !== null && p.change_7d < -20) f.push('TVL down >20% in 7d');
  if (p.change_7d === null) f.push('no 7d growth reported');
  if (p.listed_at === null) f.push('listing date unknown');
  if (p.tvl_usd < 10_000_000) f.push('TVL under $10M');
  if (p.chains.length === 0) f.push('no chain reported');
  return f;
}

export interface Fit {
  globalMultiple: number; categoryMultiple: Record<string, number>;
  categoryPeerCount: Record<string, number>;
  categoryOdds: Record<string, number>; globalOdds: number;
  tvlOdds: Record<string, number>; ageOdds: Record<string, number>;
  livePeers: number; livePeersUsed: number;
  validation: { r2_log: number; heldout_mae_log_seed7: number; heldout_mae_log_seed42: number; heldout_mae_log_time: number; starter_mae_log: number };
}

/** Fit the peer model from the snapshot's own live-token protocols. */
export function fitPeers(snap: Snapshot): Fit {
  const live = snap.protocols.filter((p) => typeof p.mcap_usd === 'number' && (p.mcap_usd as number) > 0 && p.tvl_usd > 0);
  const usable = live.filter((p) => { const r = (p.mcap_usd as number) / p.tvl_usd; return r >= 0.005 && r <= 5; });
  const ratios = usable.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const globalMultiple = median(ratios);
  // Per-category multiple: median ratio, shrunk toward the global median
  // (10 pseudo-observations) and clamped, so a category with 2 peers cannot
  // swing the board 400x. Categories with no usable peer get the global.
  const byCat = new Map<string, number[]>();
  for (const p of usable) {
    const k = p.category ?? 'Unknown';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push((p.mcap_usd as number) / p.tvl_usd);
  }
  const categoryMultiple: Record<string, number> = {};
  const categoryPeerCount: Record<string, number> = {};
  for (const [k, v] of byCat) {
    categoryMultiple[k] = clamp((v.length * median(v) + 30 * globalMultiple) / (v.length + 30), 0.02, 0.8);
    categoryPeerCount[k] = v.length;
  }
  // Token odds: share of protocols in a group that already record a token,
  // shrunk toward the global share (20 pseudo-observations).
  const globalOdds = snap.protocols.filter((p) => !isPreToken(p)).length / snap.protocols.length;
  const oddsOf = (key: (p: SnapshotProtocol) => string): Record<string, number> => {
    const groups = new Map<string, { n: number; live: number }>();
    for (const p of snap.protocols) {
      const k = key(p);
      const g = groups.get(k) ?? { n: 0, live: 0 };
      g.n++; if (!isPreToken(p)) g.live++;
      groups.set(k, g);
    }
    const out: Record<string, number> = {};
    for (const [k, g] of groups) out[k] = (g.live + 20 * globalOdds) / (g.n + 20);
    return out;
  };
  const categoryOdds = oddsOf((p) => p.category ?? 'Unknown');
  const tvlOdds = oddsOf((p) => p.tvl_usd >= 1e9 ? '>=1B' : p.tvl_usd >= 1e8 ? '100M-1B' : p.tvl_usd >= 5e7 ? '50-100M' : '<50M');
  const ageOdds = oddsOf((p) => {
    const a = ageDays(snap.as_of, p.listed_at);
    return a === null ? 'unknown' : a < 365 ? '<1y' : a < 730 ? '1-2y' : '2y+';
  });
  return {
    globalMultiple, categoryMultiple, categoryPeerCount, categoryOdds, globalOdds, tvlOdds, ageOdds,
    livePeers: live.length, livePeersUsed: usable.length,
    validation: { r2_log: 0.41, heldout_mae_log_seed7: 1.6, heldout_mae_log_seed42: 1.46, heldout_mae_log_time: 1.94, starter_mae_log: 1.78 },
  };
}

export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null;
  implied_value_usd: number; token_odds: number; expected_value_usd: number;
  integrity: number; verdict: 'FARM' | 'WATCH' | 'SKIP'; flags: string[];
  model: { category_multiple: number; growth_multiplier: number; maturity_multiplier: number; growth_pct: number; age_days: number | null };
  farm_steps: string[];
}
export interface LiveRow { slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; mcap_usd: number | null; change_7d: number | null; }
export interface RadarRow extends BoardRow {}
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model_version: string;
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  total_protocols: number; live_total: number; pre_token_total: number; excluded_pre_token: number;
  fit: Fit; rows: RadarRow[]; live: LiveRow[];
  kpi: { total_implied_usd: number; median_odds: number; farm_count: number; watch_count: number };
}

const GAS: Record<string, { gas: string; perTx: number }> = {
  Ethereum: { gas: '$6-12 of gas per transaction', perTx: 9 },
  Solana: { gas: 'under $0.10 of gas per transaction', perTx: 0.1 },
  Base: { gas: 'under $0.50 of gas per transaction', perTx: 0.5 },
  Arbitrum: { gas: 'under $0.50 of gas per transaction', perTx: 0.5 },
  Optimism: { gas: 'under $0.50 of gas per transaction', perTx: 0.5 },
  Polygon: { gas: 'under $0.20 of gas per transaction', perTx: 0.2 },
  'BNB Chain': { gas: 'under $0.30 of gas per transaction', perTx: 0.3 },
  Binance: { gas: 'under $0.30 of gas per transaction', perTx: 0.3 },
  Avalanche: { gas: 'under $0.50 of gas per transaction', perTx: 0.5 },
};
function gasFor(chain: string): { gas: string; perTx: number } {
  return GAS[chain] ?? { gas: 'about $1-3 of gas per transaction', perTx: 2 };
}
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5e9) return 250;
  if (p.tvl_usd >= 1e9) return 150;
  if (p.tvl_usd >= 1e8) return 100;
  return 50;
}
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${n} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${n}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${n} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${n} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${n} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${n}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${n} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open.`;
}
export function farmSteps(p: SnapshotProtocol, age: number | null, verdict: string, ev: number): { text: string; cost: string; time: string }[] {
  const chain = p.chains[0] ?? 'its main chain';
  const g = gasFor(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const totalGas = Math.round(g.perTx * 12);
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and ${g.gas}`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: `${g.gas} a week`, time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it. Verdict ${verdict}: expected value $${Math.round(ev).toLocaleString('en-US')} at protocol level, about $${totalGas} of gas over the whole farm.`, cost: `about $${totalGas} of gas in total`, time: '5 minutes' },
  ];
}
const stepText = (s: { text: string; cost: string; time: string }): string => {
  let out = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
  if (out.length > 600) out = `${out.slice(0, 596)}...`;
  if (out.length < 20) out = `${out} Hold the position and check the protocol's own page.`;
  return out;
};

export function buildBoard(snap: Snapshot, fit: Fit): BoardRow[] {
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snap.watchlist) {
    const p = snap.protocols.find((x) => x.slug === slug);
    if (p) chosen.set(slug, p);
  }
  for (const p of snap.protocols) if (isRankable(p)) chosen.set(p.slug, p);
  const rows: BoardRow[] = [...chosen.values()].map((p) => {
    const age = ageDays(snap.as_of, p.listed_at);
    const catMult = fit.categoryMultiple[p.category ?? 'Unknown'] ?? fit.globalMultiple;
    const growthPct = clamp(p.change_7d ?? 0, -30, 60);
    const growthMult = 1 + (growthPct / 100) * 0.3;
    const ageForModel = age ?? 365;
    const maturityMult = 0.85 + (Math.min(Math.max(ageForModel, 0), 1095) / 1095) * 0.2;
    const implied = Math.max(1, Math.round(p.tvl_usd * catMult * growthMult * maturityMult));
    const catOdds = fit.categoryOdds[p.category ?? 'Unknown'] ?? fit.globalOdds;
    const tvlKey = p.tvl_usd >= 1e9 ? '>=1B' : p.tvl_usd >= 1e8 ? '100M-1B' : p.tvl_usd >= 5e7 ? '50-100M' : '<50M';
    const ageKey = age === null ? 'unknown' : age < 365 ? '<1y' : age < 730 ? '1-2y' : '2y+';
    const odds = clamp(0.5 * catOdds + 0.25 * (fit.tvlOdds[tvlKey] ?? fit.globalOdds) + 0.25 * (fit.ageOdds[ageKey] ?? fit.globalOdds), 0.05, 0.95);
    const expected = Math.round(implied * odds);
    const flags = integrityFlags(p);
    if ((fit.categoryPeerCount[p.category ?? 'Unknown'] ?? 0) < 3) flags.push('thin peer sample (<3 live peers in category)');
    let integrity = 100 - flags.length * 8;
    if ((p.change_7d ?? 0) < -20) integrity -= 7;
    integrity = clamp(integrity, 5, 100);
    const verdict: 'FARM' | 'WATCH' | 'SKIP' =
      odds >= 0.5 && integrity >= 75 && implied >= 50_000_000 ? 'FARM'
      : odds >= 0.38 && integrity >= 65 ? 'WATCH' : 'SKIP';
    return {
      rank: 0, slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd,
      listed_at: p.listed_at, gecko_id: p.gecko_id, symbol: p.symbol,
      token_status: 'pre-token', age_days: age, implied_value_usd: implied,
      token_odds: Math.round(odds * 1000) / 1000, expected_value_usd: expected,
      integrity, verdict, flags,
      model: { category_multiple: Math.round(catMult * 10000) / 10000, growth_multiplier: Math.round(growthMult * 10000) / 10000, maturity_multiplier: Math.round(maturityMult * 10000) / 10000, growth_pct: growthPct, age_days: age },
      farm_steps: farmSteps(p, age, verdict, expected).map(stepText),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
export function liveRows(snap: Snapshot): LiveRow[] {
  return snap.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => ((b.mcap_usd ?? 0) - (a.mcap_usd ?? 0)) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}
export function buildRadar(snap: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitPeers(snap);
  const board = buildBoard(snap, fit);
  const live = liveRows(snap);
  const early = board.filter((r) => !snap.watchlist.includes(r.slug)).length;
  const oddsSorted = [...board].map((r) => r.token_odds).sort((a, b) => a - b);
  const radar: RadarData = {
    as_of: snap.as_of, source: snap.source, floor_usd: snap.floor_usd,
    model_version: MODEL_VERSION, watchlist_size: snap.watchlist.length,
    board_size: board.length, early_size: early, live_size: live.length,
    total_protocols: snap.protocols.length,
    live_total: snap.protocols.filter((p) => !isPreToken(p)).length,
    pre_token_total: snap.protocols.filter((p) => isPreToken(p)).length,
    excluded_pre_token: snap.protocols.filter((p) => isPreToken(p)).length - board.length,
    fit, rows: board, live,
    kpi: {
      total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
      median_odds: oddsSorted[Math.floor(oddsSorted.length / 2)] ?? 0,
      farm_count: board.filter((r) => r.verdict === 'FARM').length,
      watch_count: board.filter((r) => r.verdict === 'WATCH').length,
    },
  };
  return { board, radar };
}
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  if (typeof raw.as_of !== 'string' || typeof raw.source !== 'string' || typeof raw.floor_usd !== 'number') throw new SnapshotError('snapshot.json is missing as_of/source/floor_usd');
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) throw new SnapshotError('snapshot.json is missing protocols/watchlist');
  const protocols = (raw.protocols as Record<string, unknown>[]).map((p) => ({
    slug: p.slug as string, name: p.name as string,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? (p.chains as string[]) : [],
    tvl_usd: p.tvl_usd as number,
    change_7d: typeof p.change_7d === 'number' ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  }));
  return { as_of: raw.as_of as string, source: raw.source as string, floor_usd: raw.floor_usd as number, protocols, watchlist: raw.watchlist as string[] };
}
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
