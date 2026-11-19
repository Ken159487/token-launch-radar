// Token Radar's model, radar-3: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// every pre-token protocol below the watchlist floor that the radar may rank: the early rows the
// radar exists to find. A protocol is pre-token when its index entry records no token (no market
// cap, no CoinGecko id, no symbol); the snapshot's live-token protocols are kept apart and shown
// as the market's own values, never mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures. Radar-2 priced every protocol in
// a category at one flat multiple (the category's median mcap/TVL), whatever its size. The
// market does not do that: a $5M pool and a $5B pool do not carry the same multiple of TVL.
// Radar-3 therefore fits the market's own size curve. On the snapshot's live protocols
// (exchanges excluded: a CEX is not a comparable pricing for a protocol), an ordinary
// least-squares fit of log(market cap) on log(TVL) gives log(mcap) = a + b x log(TVL), and each
// category with at least three live protocols gets an intercept shift: the median residual of
// its live names in log space, shrunk toward 0 with k=5, the same shrinkage philosophy as
// radar-2. A category with fewer than three live names gets shift 0 and is priced by the
// global fit alone. The fitted multiple for one protocol is then
// exp(a + shift) x TVL^(b-1), clamped to [0.02, 2]: the multiple now falls as TVL grows when
// b < 1, as the fit finds (b = 0.47 on this snapshot), instead of pretending size does not
// matter. No protocol name is ever special-cased: the same function scores every row.
//
//   multiple   = clamp(exp(a + shift_category) x tvl_usd^(b-1), 0.02, 2)
//   base       = tvl_usd x multiple
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x 0.5
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied    = max(1, round(base x growthMult x maturity))
//
// The multiples table the dashboard shows is a reference point, not the scoring rule: each
// category's table entry is its fitted multiple evaluated at that category's median live TVL,
// and the global entry is the fit evaluated at the global median live TVL. A row's own
// multiple is the same formula evaluated at the row's own TVL, so two protocols in one
// category carry different multiples when their TVLs differ. The dashboard states the whole
// model and recomputes every row from the same figures, so the page's code and the board's
// data are visibly the same arithmetic.
//
// Honesty note: TVL alone is a weak predictor of market cap on this snapshot (the log-log
// fit's R-squared is 0.14), so the fitted curve is a better summary of the market than a flat
// median, not a precise price. Leave-one-out validation (see validateModel) quantifies that:
// the fitted model predicts a held-out live protocol's market cap with a median absolute
// percentage error of about 85%, against about 93% for radar-2's flat multiples. The gain is
// real but modest, and the board's implied values stay estimates, never prices. Two more
// checks ride on the same fit. Walk-forward validation (see validateWalkForward) fits only
// on protocols listed before each annual cutoff and tests on the next year's listings, so no
// test protocol's own market cap ever enters its training fit: the error it reports is
// out-of-sample, not in-sample. Bootstrap rank ranges (see bootstrapRankRanges) refit on
// 200 resamples of the live comparables and re-rank the board under each, so every row
// carries the 5th-95th percentile range its rank moves across when the fit's sample moves.
// The point ranks and implied values never change: the ranges are evidence about the
// ranking's stability, not a second ranking.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The log-log fit of market cap on TVL over the snapshot's live protocols (exchanges excluded). */
export interface RegressionFit {
  /** Intercept a of log(mcap) = a + b x log(TVL). */
  intercept: number;
  /** Slope b of log(mcap) = a + b x log(TVL); the fitted multiple scales as TVL^(b-1). */
  slope: number;
  /** R-squared of the fit in log space. */
  r_squared: number;
  /** How many live protocols the fit rests on. */
  n: number;
}

/**
 * One fold of the walk-forward test: the model fitted on listings before `cutoff`, scored
 * on the listings that followed before the next cutoff (or the snapshot date, for the last
 * fold). The radar-2 figures are the same fold scored with radar-2's flat multiples, refit
 * on the same training set, so the comparison is apples-to-apples.
 */
export interface WalkForwardFold {
  /** The cutoff date (YYYY-MM-DD): training listings are strictly before it. */
  cutoff: string;
  /** Live protocols listed before the cutoff, which the fold's fit rests on. */
  train_n: number;
  /** Live protocols listed in the fold's test window. */
  test_n: number;
  /** Radar-3 median APE on the fold's test window (out-of-sample). */
  median_ape: number;
  /** Radar-3 mean APE on the fold's test window. */
  mean_ape: number;
  /** Radar-3 share of the fold's test window within 2x of the recorded market cap. */
  within_2x: number;
  /** Radar-3 share of the fold's test window within 1.5x. */
  within_1_5x: number;
  /** Radar-2 median APE on the same test window, same training set. */
  radar2_median_ape: number;
  /** Radar-2 share within 2x on the same test window, same training set. */
  radar2_within_2x: number;
}

/**
 * Walk-forward validation of the value model: an expanding-window, time-based
 * out-of-sample test. Annual folds fit the same log-log model (global fit plus category
 * shifts) on live protocols listed before a cutoff and predict the market caps of the
 * protocols listed after it, so the model is always tested on listings it could not have
 * seen. The pooled figures score every out-of-sample prediction together; the folds list
 * each window on its own. Protocols with no listing date cannot be placed in time and are
 * excluded, counted in undated_excluded.
 */
export interface WalkForwardValidation {
  /** How the numbers were produced: expanding-window annual folds on listing date. */
  method: string;
  /** The fold cutoffs (YYYY-MM-DD), in order. */
  cutoffs: string[];
  /** How many live protocols were tested out-of-sample across all folds. */
  n: number;
  /** Live protocols left out because the snapshot records no listing date for them. */
  undated_excluded: number;
  /** Radar-3 median APE, pooled over all out-of-sample predictions. */
  median_ape: number;
  /** Radar-3 mean APE, pooled. */
  mean_ape: number;
  /** Radar-3 share of out-of-sample predictions within 2x of the recorded market cap. */
  within_2x: number;
  /** Radar-3 share within 1.5x, pooled. */
  within_1_5x: number;
  /** Radar-2 (flat category median-ratio multiples) median APE, same pooled set. */
  radar2_median_ape: number;
  /** Radar-2 mean APE, same pooled set. */
  radar2_mean_ape: number;
  /** Radar-2 share within 2x, same pooled set. */
  radar2_within_2x: number;
  /** Radar-2 share within 1.5x, same pooled set. */
  radar2_within_1_5x: number;
  /** The folds, in cutoff order. */
  folds: WalkForwardFold[];
}

/**
 * Leave-one-out validation of the value model against the radar-2 baseline, both scored on
 * the same held-out live protocols (exchanges excluded). APE is the absolute percentage error
 * of the predicted market cap against the recorded one; within_2x is the share of predictions
 * inside [0.5x, 2x] of the recorded market cap.
 */
export interface ModelValidation {
  /** How the numbers were produced: leave-one-out refits of both models. */
  method: string;
  /** How many live protocols were held out, one at a time. */
  n: number;
  /** Radar-3 median APE. */
  median_ape: number;
  /** Radar-3 mean APE (heavy-tailed: a few tiny-TVL names dominate it, read it with the median). */
  mean_ape: number;
  /** Radar-3 share of predictions within 2x of the recorded market cap. */
  within_2x: number;
  /** Radar-3 share of predictions within 1.5x of the recorded market cap. */
  within_1_5x: number;
  /** Radar-2 (flat category median-ratio multiples) median APE, same held-out set. */
  radar2_median_ape: number;
  /** Radar-2 mean APE, same held-out set. */
  radar2_mean_ape: number;
  /** Radar-2 share within 2x, same held-out set. */
  radar2_within_2x: number;
  /** Radar-2 share within 1.5x, same held-out set. */
  radar2_within_1_5x: number;
  /** Walk-forward (time-based out-of-sample) validation of the same model. */
  walk_forward: WalkForwardValidation;
}

/**
 * The model's constants, as the dashboard states them and the sandbox may change them. The
 * multiples are not constants: main.ts derives them from the snapshot and fills them in before
 * scoring, so they are part of the model the dashboard shows, not a number typed in by hand.
 */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  shrink_k: number;
  /** A category needs at least this many live protocols before its own intercept shift is trusted. */
  min_live_n: number;
  multiple_min: number;
  multiple_max: number;
  /** The log-log fit of market cap on TVL, derived from the snapshot's live protocols. */
  regression: RegressionFit;
  /** Category -> log-space intercept shift, derived from the snapshot's live protocols. */
  category_shifts: Record<string, number>;
  /** How many live protocols each category's shift rests on. */
  shift_counts: Record<string, number>;
  /** Leave-one-out validation of this model against the radar-2 baseline. */
  validation: ModelValidation;
  /**
   * Category -> fitted multiple at that category's median live TVL: a reference point for the
   * dashboard's multiples table, not the scoring rule. A row's own multiple is the same
   * formula evaluated at the row's own TVL.
   */
  multiples: Record<string, number>;
  /** How many live protocols each category's reference multiple rests on. */
  multiple_counts: Record<string, number>;
  /** The fitted multiple at the global median live TVL: the table's reference fallback. */
  global_multiple: number;
  /** Radar-3 does not winsorize (the log fit tames the heavy tail instead); kept at 0 so the dashboard's shape is unchanged. */
  winsor_cap: number;
  /** How many live protocols the derivation rests on (exchanges excluded). */
  live_count: number;
}

/** The model's fixed shape; the fit, shifts and validation are filled in from the snapshot at run time. */
export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  shrink_k: 5,
  min_live_n: 3,
  multiple_min: 0.02,
  multiple_max: 2.0,
  regression: { intercept: 0, slope: 1, r_squared: 0, n: 0 },
  category_shifts: {},
  shift_counts: {},
  validation: {
    method: 'leave-one-out',
    n: 0,
    median_ape: 0,
    mean_ape: 0,
    within_2x: 0,
    within_1_5x: 0,
    radar2_median_ape: 0,
    radar2_mean_ape: 0,
    radar2_within_2x: 0,
    radar2_within_1_5x: 0,
    walk_forward: {
      method: 'walk-forward (expanding window, annual folds)',
      cutoffs: [],
      n: 0,
      undated_excluded: 0,
      median_ape: 0,
      mean_ape: 0,
      within_2x: 0,
      within_1_5x: 0,
      radar2_median_ape: 0,
      radar2_mean_ape: 0,
      radar2_within_2x: 0,
      radar2_within_1_5x: 0,
      folds: [],
    },
  },
  multiples: {},
  multiple_counts: {},
  global_multiple: 0,
  winsor_cap: 0,
  live_count: 0,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_CAP = 250;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  /** 5th percentile bootstrap rank: the rank range's lower end (rank_low <= rank). */
  rank_low: number;
  /** Median bootstrap rank across the refits. */
  rank_median: number;
  /** 95th percentile bootstrap rank: the range's upper end (rank <= rank_high). */
  rank_high: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  /** Net expected value of farming this row, in USD, rounded to cents (may be negative). */
  farm_net_usd: number;
  /** Farm, Thin or Skip, from farm_net_usd: Farm at $10 or more, Thin at $0 or more, else Skip. */
  farm_verdict: 'Farm' | 'Thin' | 'Skip';
  model: {
    multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  /** 5th percentile bootstrap rank: the rank range's lower end (rank_low <= rank). */
  rank_low: number;
  /** Median bootstrap rank across the refits. */
  rank_median: number;
  /** 95th percentile bootstrap rank: the range's upper end (rank <= rank_high). */
  rank_high: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  /** Net expected value of farming this row, in USD, rounded to cents (may be negative). */
  farm_net_usd: number;
  /** Farm, Thin or Skip, from farm_net_usd: Farm at $10 or more, Thin at $0 or more, else Skip. */
  farm_verdict: 'Farm' | 'Thin' | 'Skip';
  multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_to_tvl: number | null;
}

/**
 * One live protocol the log-log fit rests on (mcap > 0, TVL > 0, not a CEX): the evidence
 * behind a category's fitted multiple, for the dashboard's Comparables view. Ordered by the
 * category's fitted multiple, descending, then by market cap, descending, inside the category.
 */
export interface Comparable {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  /** Every live protocol the fit rests on, for the Comparables view. */
  comparables: Comparable[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `n` into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The median of a non-empty list; NaN when empty. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The q-th percentile of an ascending list, linearly interpolated. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/**
 * Radar-2's base multiples, derived from a list of live protocols: for each category with at
 * least `min_live_n` live protocols, the median market-cap-to-TVL ratio of its live names,
 * each winsorized at the 90th percentile of the live ratios, shrunk toward the global median
 * with `shrink_k`, and clamped to [multiple_min, multiple_max]. Radar-3 no longer scores
 * with this, but the function stays: validateModel uses it as the baseline, so the
 * leave-one-out comparison is the same code the entry used to ship, not a recollection of it.
 */
export function deriveMultiples(protocols: SnapshotProtocol[]): {
  multiples: Record<string, number>;
  multiple_counts: Record<string, number>;
  global_multiple: number;
  winsor_cap: number;
  live_count: number;
} {
  const live = protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const winsorCap = percentile(ratios, 0.9);
  const winsorized = ratios.map((r) => Math.min(r, winsorCap));
  const globalMultiple = median(winsorized);
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const cat = p.category ?? 'Other';
    const list = byCategory.get(cat) ?? [];
    list.push(Math.min(p.mcap_usd! / p.tvl_usd, winsorCap));
    byCategory.set(cat, list);
  }
  const multiples: Record<string, number> = {};
  const multiple_counts: Record<string, number> = {};
  for (const [cat, catRatios] of byCategory) {
    if (catRatios.length < MODEL.min_live_n) continue;
    const catMed = median(catRatios);
    const shrunk =
      (catRatios.length * catMed + MODEL.shrink_k * globalMultiple) /
      (catRatios.length + MODEL.shrink_k);
    multiples[cat] = clamp(shrunk, MODEL.multiple_min, MODEL.multiple_max);
    multiple_counts[cat] = catRatios.length;
  }
  return {
    multiples,
    multiple_counts,
    global_multiple: globalMultiple,
    winsor_cap: winsorCap,
    live_count: live.length,
  };
}

/** The base multiple one category gets: its derived multiple, or the global median. */
export function multipleFor(category: string | null, model: ModelConstants): number {
  const cat = category ?? 'Other';
  const m = model.multiples[cat];
  return typeof m === 'number' && Number.isFinite(m) ? m : model.global_multiple;
}

/** The live protocols the log-log fit rests on: a positive market cap on a positive TVL, and
 *  not an exchange. The snapshot carries a market cap of -1 for one protocol, a data quirk,
 *  and a negative market cap is not a price; exchanges are not comparable pricing for a
 *  protocol, so the CEX category is left out of the fit entirely. */
export function liveForFit(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
}

/** Ordinary least squares for log(mcap) = a + b x log(TVL) over the given live protocols. */
export function fitLogLog(rows: SnapshotProtocol[]): RegressionFit {
  const n = rows.length;
  if (n < 2) return { intercept: 0, slope: 1, r_squared: 0, n };
  const xs = rows.map((p) => Math.log(p.tvl_usd));
  const ys = rows.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { intercept: my, slope: 0, r_squared: 0, n };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i]! - (intercept + slope * xs[i]!);
    ssRes += r * r;
  }
  return { intercept, slope, r_squared: 1 - ssRes / syy, n };
}

/**
 * Per-category intercept shifts for a fitted log-log model: the median residual (log space)
 * of the category's live protocols, shrunk toward 0 with `shrink_k`:
 * shift = (n x median_resid) / (n + shrink_k). A category with fewer than `min_live_n`
 * live protocols gets shift 0: one live protocol, however extreme, never gets to reprice a
 * whole category. Returns the shift and the live count for every category present.
 */
export function categoryShifts(
  rows: SnapshotProtocol[],
  fit: RegressionFit,
): { shifts: Record<string, number>; counts: Record<string, number> } {
  const byCategory = new Map<string, number[]>();
  for (const p of rows) {
    const cat = p.category ?? 'Other';
    const resid = Math.log(p.mcap_usd!) - (fit.intercept + fit.slope * Math.log(p.tvl_usd));
    const list = byCategory.get(cat) ?? [];
    list.push(resid);
    byCategory.set(cat, list);
  }
  const shifts: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const [cat, resids] of byCategory) {
    counts[cat] = resids.length;
    if (resids.length < MODEL.min_live_n) {
      shifts[cat] = 0;
    } else {
      const med = median(resids);
      shifts[cat] = (resids.length * med) / (resids.length + MODEL.shrink_k);
    }
  }
  return { shifts, counts };
}

/** One protocol's fitted multiple: exp(a + shift) x TVL^(b-1), clamped to [multiple_min, multiple_max]. */
export function fittedMultiple(
  tvlUsd: number,
  shift: number,
  fit: RegressionFit,
  model: ModelConstants,
): number {
  const raw = Math.exp(fit.intercept + shift) * Math.pow(tvlUsd, fit.slope - 1);
  return clamp(raw, model.multiple_min, model.multiple_max);
}

/**
 * Radar-3's derivation from the snapshot's own live protocols (exchanges excluded): the
 * log-log fit, the per-category intercept shifts, and the reference multiples for the
 * dashboard's table (each category's fitted multiple at its median live TVL; the global
 * entry is the fit at the global median live TVL). The reference multiples are display
 * values only: scoring evaluates the same formula at each protocol's own TVL.
 */
export function deriveRegression(protocols: SnapshotProtocol[]): {
  regression: RegressionFit;
  category_shifts: Record<string, number>;
  shift_counts: Record<string, number>;
  multiples: Record<string, number>;
  multiple_counts: Record<string, number>;
  global_multiple: number;
  live_count: number;
} {
  const live = liveForFit(protocols);
  const regression = fitLogLog(live);
  const { shifts, counts } = categoryShifts(live, regression);
  const tvlsByCategory = new Map<string, number[]>();
  for (const p of live) {
    const cat = p.category ?? 'Other';
    const list = tvlsByCategory.get(cat) ?? [];
    list.push(p.tvl_usd);
    tvlsByCategory.set(cat, list);
  }
  const multiples: Record<string, number> = {};
  const multiple_counts: Record<string, number> = {};
  for (const [cat, tvls] of tvlsByCategory) {
    multiples[cat] = fittedMultiple(median(tvls), shifts[cat] ?? 0, regression, MODEL);
    multiple_counts[cat] = tvls.length;
  }
  const globalMultiple = fittedMultiple(
    median(live.map((p) => p.tvl_usd)),
    0,
    regression,
    MODEL,
  );
  return {
    regression,
    category_shifts: shifts,
    shift_counts: counts,
    multiples,
    multiple_counts,
    global_multiple: globalMultiple,
    live_count: live.length,
  };
}

/** The fitted multiple one protocol gets: its category's shift, evaluated at its own TVL. */
export function multipleForProtocol(
  category: string | null,
  tvlUsd: number,
  model: ModelConstants,
): number {
  const cat = category ?? 'Other';
  const shift = model.category_shifts[cat] ?? 0;
  return fittedMultiple(tvlUsd, shift, model.regression, model);
}

/** Error summaries for a set of predicted market caps against the recorded ones. */
function apeSummary(
  pairs: { actual: number; predicted: number }[],
): { median_ape: number; mean_ape: number; within_2x: number; within_1_5x: number } {
  const n = pairs.length;
  if (n === 0) return { median_ape: 0, mean_ape: 0, within_2x: 0, within_1_5x: 0 };
  const apes = pairs.map(({ actual, predicted }) => Math.abs(predicted - actual) / actual);
  const within = (factor: number): number =>
    pairs.filter(
      ({ actual, predicted }) => predicted >= actual / factor && predicted <= actual * factor,
    ).length / n;
  return {
    median_ape: median(apes),
    mean_ape: apes.reduce((s, v) => s + v, 0) / n,
    within_2x: within(2),
    within_1_5x: within(1.5),
  };
}

/**
 * Leave-one-out validation of the value model: for each live protocol (exchanges excluded),
 * refit the model without it -- the global log-log fit plus the category shifts from the rest --
 * and predict its market cap from its TVL alone, with no growth or maturity multiplier (those
 * price a pre-token protocol's future, not a live token's recorded market cap). The same
 * held-out set is scored with radar-2's flat category median-ratio multiples, refit without
 * the held-out protocol the same way, so the improvement is apples-to-apples. The fitted
 * curve is a better summary of the market than a flat median, but the errors stay large:
 * TVL alone explains only a small share of market cap, and the median error is the honest
 * headline -- the mean is dominated by a few tiny-TVL names with outsized market caps.
 */
export function validateModel(protocols: SnapshotProtocol[]): ModelValidation {
  const live = liveForFit(protocols);
  const pairs3: { actual: number; predicted: number }[] = [];
  const pairs2: { actual: number; predicted: number }[] = [];
  for (const held of live) {
    const rest = live.filter((p) => p !== held);
    const fit = fitLogLog(rest);
    const { shifts } = categoryShifts(rest, fit);
    const shift = shifts[held.category ?? 'Other'] ?? 0;
    pairs3.push({
      actual: held.mcap_usd!,
      predicted:
        held.tvl_usd *
        fittedMultiple(held.tvl_usd, shift, fit, MODEL),
    });
    const base2 = deriveMultiples(rest);
    const mult2 = base2.multiples[held.category ?? 'Other'] ?? base2.global_multiple;
    pairs2.push({ actual: held.mcap_usd!, predicted: held.tvl_usd * mult2 });
  }
  const s3 = apeSummary(pairs3);
  const s2 = apeSummary(pairs2);
  return {
    method: 'leave-one-out',
    n: live.length,
    median_ape: s3.median_ape,
    mean_ape: s3.mean_ape,
    within_2x: s3.within_2x,
    within_1_5x: s3.within_1_5x,
    radar2_median_ape: s2.median_ape,
    radar2_mean_ape: s2.mean_ape,
    radar2_within_2x: s2.within_2x,
    radar2_within_1_5x: s2.within_1_5x,
    walk_forward: validateWalkForward(protocols),
  };
}

/**
 * Walk-forward validation of the value model: an expanding-window, time-based
 * out-of-sample test on listing date. The folds cut at the 1st of January of 2023, 2024
 * and 2025: the earliest training set, the listings of 2021-2022, is still large enough
 * to fit a two-parameter curve, and every dated protocol listed from 2023 onward is tested
 * exactly once, in the fold right after its listing year. Each fold refits the same log-log
 * model (global fit plus category shifts) on its training set only, then predicts the test
 * window's market caps from TVL alone, with no growth or maturity multiplier (those price
 * a pre-token protocol's future, not a live token's recorded market cap). The same windows
 * are scored with radar-2's flat multiples, refit on the same training sets. The pooled
 * figures are the honest out-of-sample headline; the folds show whether the error is stable
 * across years or drifting. Protocols with no listing date cannot be placed in time and are
 * excluded from every fold; their count is reported in undated_excluded.
 */
export function validateWalkForward(protocols: SnapshotProtocol[]): WalkForwardValidation {
  const live = liveForFit(protocols);
  const dated = live.filter((p) => p.listed_at !== null);
  const cutoffs = ['2023-01-01', '2024-01-01', '2025-01-01'];
  const pooled3: { actual: number; predicted: number }[] = [];
  const pooled2: { actual: number; predicted: number }[] = [];
  const folds: WalkForwardFold[] = [];
  for (let i = 0; i < cutoffs.length; i++) {
    const cutoff = cutoffs[i]!;
    const next = cutoffs[i + 1] ?? null;
    const train = dated.filter((p) => p.listed_at! < cutoff);
    const test = dated.filter(
      (p) => p.listed_at! >= cutoff && (next === null || p.listed_at! < next),
    );
    if (train.length < 2 || test.length === 0) continue;
    const fit = fitLogLog(train);
    const { shifts } = categoryShifts(train, fit);
    const base2 = deriveMultiples(train);
    const pairs3 = test.map((p) => ({
      actual: p.mcap_usd!,
      predicted:
        p.tvl_usd * fittedMultiple(p.tvl_usd, shifts[p.category ?? 'Other'] ?? 0, fit, MODEL),
    }));
    const pairs2 = test.map((p) => ({
      actual: p.mcap_usd!,
      predicted:
        p.tvl_usd * (base2.multiples[p.category ?? 'Other'] ?? base2.global_multiple),
    }));
    const s3 = apeSummary(pairs3);
    const s2 = apeSummary(pairs2);
    folds.push({
      cutoff,
      train_n: train.length,
      test_n: test.length,
      median_ape: s3.median_ape,
      mean_ape: s3.mean_ape,
      within_2x: s3.within_2x,
      within_1_5x: s3.within_1_5x,
      radar2_median_ape: s2.median_ape,
      radar2_within_2x: s2.within_2x,
    });
    pooled3.push(...pairs3);
    pooled2.push(...pairs2);
  }
  const s3 = apeSummary(pooled3);
  const s2 = apeSummary(pooled2);
  return {
    method: 'walk-forward (expanding window, annual folds)',
    cutoffs: folds.map((f) => f.cutoff),
    n: pooled3.length,
    undated_excluded: live.length - dated.length,
    median_ape: s3.median_ape,
    mean_ape: s3.mean_ape,
    within_2x: s3.within_2x,
    within_1_5x: s3.within_1_5x,
    radar2_median_ape: s2.median_ape,
    radar2_mean_ape: s2.mean_ape,
    radar2_within_2x: s2.within_2x,
    radar2_within_1_5x: s2.within_1_5x,
    folds,
  };
}

/** How many bootstrap refits the rank ranges rest on. */
export const BOOTSTRAP_REFITS = 200;

/**
 * Fixed seed for the bootstrap resampler: the same snapshot always rebuilds to the same
 * board, so the dossier's byte comparison holds.
 */
export const BOOTSTRAP_SEED = 20261119;

/** A small deterministic PRNG (mulberry32), so bootstrap resamples are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One row's bootstrap rank range. */
export interface RankRange {
  rank_low: number;
  rank_median: number;
  rank_high: number;
}

/**
 * Bootstrap rank ranges: refit the log-log model on BOOTSTRAP_REFITS resamples (drawn with
 * replacement, same size) of the live comparables, reprice every scored row under each
 * refit with that refit's multiple (the row's own growth and maturity multipliers do not
 * depend on the fit, so they carry over unchanged), and re-rank the board the same way
 * buildBoard ranks it (implied value descending, slug ascending on a tie). The range is
 * the 5th-95th percentile of the row's ranks across the refits, with the median rank
 * alongside. The point rank and implied value are never touched: the range is additional
 * evidence about how much the ranking moves when the fit's sample moves. The 5th-95th
 * range is widened just enough to include the point rank when it falls outside it, so
 * rank_low <= rank <= rank_high always holds.
 */
export function bootstrapRankRanges(
  protocols: SnapshotProtocol[],
  scored: { p: SnapshotProtocol; implied: number; growthMult: number; maturityMult: number }[],
): Map<string, RankRange> {
  const live = liveForFit(protocols);
  const n = scored.length;
  const ranks: number[][] = scored.map(() => []);
  const rng = mulberry32(BOOTSTRAP_SEED);
  for (let b = 0; b < BOOTSTRAP_REFITS; b++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < live.length; i++) sample.push(live[Math.floor(rng() * live.length)]!);
    const fit = fitLogLog(sample);
    const { shifts } = categoryShifts(sample, fit);
    const impliedB = scored.map((s) => {
      const shift = shifts[s.p.category ?? 'Other'] ?? 0;
      const mult = fittedMultiple(s.p.tvl_usd, shift, fit, MODEL);
      return Math.max(1, Math.round(s.p.tvl_usd * mult * s.growthMult * s.maturityMult));
    });
    const order = scored
      .map((_, i) => i)
      .sort(
        (a, c) =>
          impliedB[c]! - impliedB[a]! ||
          (scored[a]!.p.slug < scored[c]!.p.slug ? -1 : scored[a]!.p.slug > scored[c]!.p.slug ? 1 : 0),
      );
    for (let r = 0; r < n; r++) ranks[order[r]!]!.push(r + 1);
  }
  const out = new Map<string, RankRange>();
  for (let i = 0; i < n; i++) {
    const rs = [...ranks[i]!].sort((a, b) => a - b);
    const pointRank = i + 1;
    out.set(scored[i]!.p.slug, {
      rank_low: Math.min(Math.round(percentile(rs, 0.05)), pointRank),
      rank_median: Math.round(percentile(rs, 0.5)),
      rank_high: Math.max(Math.round(percentile(rs, 0.95)), pointRank),
    });
  }
  return out;
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): {
  implied: number;
  multiple: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const multiple = multipleForProtocol(protocol.category, protocol.tvl_usd, model);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) *
      model.maturity_range;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, multiple, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor, by TVL, up to the
  // cap. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_CAP);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, multiple, growthPct, growthMult, maturityMult, age } = impliedValue(
      p,
      snapshot.as_of,
      model,
    );
    return { p, implied, multiple, growthPct, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // The rank ranges ride on the scored rows, at full precision: a refit only reprices the
  // multiple, so the growth and maturity multipliers carry over unchanged. The point ranks
  // and implied values above are untouched; the ranges are additional evidence.
  const ranges = bootstrapRankRanges(snapshot.protocols, scored);
  return scored.map((s, i) => {
    const net = farmNet(s.p, s.age, s.implied);
    return {
    rank: i + 1,
    rank_low: ranges.get(s.p.slug)!.rank_low,
    rank_median: ranges.get(s.p.slug)!.rank_median,
    rank_high: ranges.get(s.p.slug)!.rank_high,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    farm_net_usd: net.net_usd,
    farm_verdict: net.verdict,
    model: {
      multiple: round4(s.multiple),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.implied).map(stepText),
    };
  });
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** What one transaction costs on a chain, in the words a farmer can budget with. */
function gasFor(chain: string): { first: string; weekly: string; setup: string } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { first: 'about $5 of gas for the first transaction', weekly: 'about $3 of gas a week', setup: '8' };
  if (c === 'solana') return { first: 'a few cents of gas for the first transaction', weekly: 'a few cents of gas a week', setup: '1' };
  if (c === 'binance' || c === 'bsc') return { first: 'under $0.50 of gas for the first transaction', weekly: 'under $0.50 of gas a week', setup: '1' };
  if (
    c === 'base' ||
    c === 'arbitrum' ||
    c === 'optimism' ||
    c === 'zksync era' ||
    c === 'linea' ||
    c === 'blast' ||
    c === 'scroll' ||
    c === 'mantle' ||
    c === 'mode' ||
    c === 'polygon' ||
    c === 'monad' ||
    c === 'berachain' ||
    c === 'sonic'
  ) {
    return { first: 'under $1 of gas for the first transaction', weekly: 'under $1 of gas a week', setup: '2' };
  }
  return { first: 'about $2 of gas for the first transaction', weekly: 'about $2 of gas a week', setup: '4' };
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('leveraged farm'))
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('yield'))
    return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and let it compound.`;
  if (c.includes('bridge') || c.includes('canonical'))
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('restak') || c.includes('staking'))
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return `Deposit $${capital} of USDC as margin on ${chain} through ${name} and open one small hedge.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${chain} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('basis'))
    return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the position open.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('cedefi'))
    return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
  if (c.includes('chain'))
    return `Bridge $${capital} of USDC to ${chain} and use ${name}'s own app once a week.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly qualifying action, by category: the habit that keeps a wallet counted. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return 'Make one qualifying action each week, such as a deposit, a borrow or a repayment.';
  if (c.includes('dex') || c.includes('leveraged farm'))
    return 'Make one qualifying action each week, such as a swap, adding liquidity or a vote.';
  if (c.includes('yield'))
    return 'Make one qualifying action each week, such as a deposit, a harvest or a vault move.';
  if (c.includes('bridge'))
    return 'Make one qualifying action each week, such as a bridge or a swap on the destination chain.';
  if (c.includes('restak') || c.includes('staking'))
    return 'Make one qualifying action each week, such as a stake, a restake or a claim.';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return 'Make one qualifying action each week, such as a small trade or a margin top-up.';
  if (c.includes('prediction'))
    return 'Make one qualifying action each week, such as a new market position.';
  if (c.includes('curator') || c.includes('allocator') || c.includes('basis'))
    return 'Make one qualifying action each week, such as a vault deposit or a rebalance.';
  if (c.includes('rwa') || c.includes('stable'))
    return 'Make one qualifying action each week, such as a mint, a deposit or a transfer.';
  if (c.includes('insurance'))
    return 'Make one qualifying action each week, such as a cover purchase or a claim check.';
  return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
}

/** A short dollar figure for the plan's last step, so the plan names the model's own number. */
function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

/** The wallet a chain needs, in the words a farmer can set up. */
function walletFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'Ethereum wallet (MetaMask or Rabby) on Ethereum';
  if (c === 'solana') return 'Solana wallet (Phantom or Solflare) on Solana';
  if (c === 'bitcoin') return 'Bitcoin wallet on Bitcoin';
  return `wallet on ${chain}`;
}

/** The two cheapest chains to start on, by gas setup cost, earliest first on a tie. */
function cheapestTwo(chains: string[]): { first: string; second: string | null } {
  const ranked = chains
    .map((c, i) => ({ c, i, setup: Number(gasFor(c).setup) }))
    .sort((a, b) => a.setup - b.setup || a.i - b.i);
  return { first: ranked[0]?.c ?? 'its main chain', second: ranked.length > 1 ? ranked[1]!.c : null };
}

/**
 * The sequencing step: which chain to start on and in what order to expand. A multi-chain
 * protocol starts on its cheapest chain by gas and expands to the next-cheapest after a week
 * of activity; a single-chain protocol has no chain order, so the step sequences the actions.
 */
function sequenceFor(p: SnapshotProtocol): FarmStep {
  const chains = p.chains;
  const chain = chainOf(p);
  if (chains.length <= 1) {
    return {
      text: `Start on ${chain}: it is the protocol's only chain, so sequence by action instead of by chain - open the position first, then do the weekly action, and keep every step in the one wallet from step 1.`,
      cost: gasFor(chain).weekly,
      time: '10 minutes a week',
    };
  }
  const { first, second } = cheapestTwo(chains);
  const cheapGas = gasFor(first);
  // gasFor's first-transaction phrase already contains "of gas", so strip it here:
  // "gas costs a few cents for the first transaction", never "gas there is a few cents of gas".
  const costPhrase = cheapGas.first.replace(' of gas for the first transaction', '');
  return {
    text: `Start on ${first}, where gas costs ${costPhrase} for the first transaction — the cheapest of the ${chains.length} chains this protocol runs on — then expand to ${second} after a week of activity, and leave the pricier chains until the farm is running.`,
    cost: cheapGas.first,
    time: '15 minutes to set up',
  };
}

/**
 * The one risk the row's own figures point at, picked in order of relevance: an extreme
 * inflow first (a 7-day jump of 50% or more can follow a short incentive), then a sharply
 * falling TVL, then a very young protocol, then a TVL so large the points are shared
 * thin, then a mature protocol with a high implied value, and finally the steady case,
 * where the risk is the points terms changing.
 */
function riskFor(
  p: SnapshotProtocol,
  age: number | null,
  implied: number,
  capital: number,
  hold: number,
): FarmStep {
  const growth = p.change_7d;
  if (growth !== null && growth >= 50) {
    return {
      text: `TVL jumped ${growth.toFixed(1)}% in 7 days: inflows that fast often follow a short incentive, so confirm the points terms before adding more capital.`,
      cost: 'nothing to add until the terms are confirmed',
      time: '15 minutes to check',
    };
  }
  if (growth !== null && growth <= -10) {
    return {
      text: `TVL fell ${Math.abs(growth).toFixed(1)}% in the last 7 days: find out why before adding capital - start at the smallest tier and add nothing until the TVL steadies.`,
      cost: 'start with $50 only',
      time: '15 minutes to check, then wait a week',
    };
  }
  if (age !== null && age < 180) {
    return {
      text: `Listed only ${age} days ago: a new protocol can change its points terms, so hold longer and re-check the terms each month before adding capital.`,
      cost: `the $${capital} stays in for ${hold} days`,
      time: `${hold} days`,
    };
  }
  if (p.tvl_usd >= 1_000_000_000) {
    return {
      text: `TVL is ${fmtUsd(p.tvl_usd)}: that size draws many farmers, so expect the points to be shared thin - keep the position at the smallest tier that still qualifies.`,
      cost: 'start with $50 only',
      time: '10 minutes to check the points page',
    };
  }
  if (age !== null && age >= 365 && implied >= 10_000_000) {
    return {
      text: `Running ${age} days with ${fmtUsd(implied)} of implied value: the protocol is mature, so expect a slow farm rather than a surprise - size it as a long hold, not a quick flip.`,
      cost: `the $${capital} stays in for ${hold} days`,
      time: `${hold} days`,
    };
  }
  const move =
    growth === null
      ? 'no 7-day change on record'
      : `7-day change ${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`;
  return {
    text: `The snapshot shows no sharp move - TVL ${fmtUsd(p.tvl_usd)} and ${move}: the main risk is the points terms changing, so keep the position at the $${capital} tier and re-check the points page each month before adding more.`,
    cost: `the $${capital} stays in the position`,
    time: '10 minutes a month',
  };
}

/**
 * The gas a chain charges, in USD, as numbers: the same table gasFor states in words.
 * The setup figure is the one-off gas the farm plan's fourth step already states ("about $8
 * of gas" on Ethereum); the weekly figure is the plan's weekly gas. "Under $1" is read as $1
 * and "a few cents" as $0.05, the top of each stated range, so the net is never flattered.
 */
function gasUsdFor(chain: string): { setup: number; weekly: number } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { setup: 8, weekly: 3 };
  if (c === 'solana') return { setup: 1, weekly: 0.05 };
  if (c === 'binance' || c === 'bsc') return { setup: 1, weekly: 0.5 };
  if (
    c === 'base' ||
    c === 'arbitrum' ||
    c === 'optimism' ||
    c === 'zksync era' ||
    c === 'linea' ||
    c === 'blast' ||
    c === 'scroll' ||
    c === 'mantle' ||
    c === 'mode' ||
    c === 'polygon' ||
    c === 'monad' ||
    c === 'berachain' ||
    c === 'sonic'
  ) {
    return { setup: 2, weekly: 1 };
  }
  return { setup: 4, weekly: 2 };
}

/** A signed dollar figure with cents, for the netting sentence in the last farm step. */
function fmtSignedUsd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

/** The farm verdict: Farm is clearly worth farming, Thin is marginal, Skip is not worth it. */
export type FarmVerdict = 'Farm' | 'Thin' | 'Skip';

/**
 * Farm-plan netting: the net expected value of farming one row, and its verdict.
 * Formula: net = (deposit / TVL) x implied value - gas.
 * - deposit is the farm plan's own capitalFor tier ($50 below $100M TVL, $100 below $1B,
 *   $150 below $5B, $250 at $5B or more), so the stake scales with protocol size.
 * - implied value is the model's own number for the row.
 * - gas is the setup gas the plan states for the cheapest chain plus the weekly gas over
 *   the hold, weeks = ceil(holdDays / 7): a 30-day hold pays 5 weeks, 45 days 7, 60 days 9.
 * Assumptions, stated plainly: the airdrop is shared pro-rata by deposit, so a $150 deposit
 * in a $2.75B protocol earns 150 / 2,750,000,000 of the implied value; the airdrop is paid in
 * full at the implied value; gas is charged at the plan's stated upper bounds; the farm earns
 * no yield, no points multiplier and no price move, and the deposit itself is returned.
 * That pro-rata share is why the biggest protocols net the least: implied value grows with
 * the square root of TVL (the log-log slope is 0.472), so the share per dollar falls as TVL
 * rises, while the deposit tier only doubles from $50 to $250 across the whole board.
 * Verdicts, from the net distribution on the 2026-11-14 snapshot (median $2.72, 75th
 * percentile $9.35, 90th $16.32, range -$27.38 to $42.90): net of $10 or more is Farm, about
 * the top quarter of rows; $0 to $10 is Thin, a gain but under a fifth of the smallest $50
 * deposit, easily wiped out by one extra transaction; below $0 is Skip, the farm costs more
 * than the share is worth. Fully deterministic: same snapshot, same net and verdict.
 */
export function farmNet(
  p: SnapshotProtocol,
  age: number | null,
  implied: number,
): { net_usd: number; verdict: FarmVerdict; deposit_usd: number; gross_usd: number; gas_usd: number } {
  const deposit = capitalFor(p);
  const gas = gasUsdFor(cheapestTwo(p.chains).first);
  const weeks = Math.ceil(holdDaysFor(age) / 7);
  const gasUsd = gas.setup + gas.weekly * weeks;
  const gross = (deposit / p.tvl_usd) * implied;
  const net = Math.round((gross - gasUsd) * 100) / 100;
  const verdict: FarmVerdict = net >= 10 ? 'Farm' : net >= 0 ? 'Thin' : 'Skip';
  return {
    net_usd: net,
    verdict,
    deposit_usd: deposit,
    gross_usd: Math.round(gross * 100) / 100,
    gas_usd: Math.round(gasUsd * 100) / 100,
  };
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, 7-day change, age, implied value), never from a
 * hand-written list of names. The dashboard's page generates the same eight steps from the same
 * fields, so the plan the board carries and the plan the page shows are one plan.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number): FarmStep[] {
  // One chain order per row: the cheapest chain by gas setup cost starts the farm (ties keep
  // list order), so steps 1, 2 and 4 all agree on the same start chain and second chain.
  const { first: startChain, second: secondChain } = cheapestTwo(p.chains);
  const chain = startChain;
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const net = farmNet(p, age, implied);
  const where = secondChain !== null ? `${startChain} and ${secondChain}` : chain;
  return [
    {
      text: `Use a fresh ${walletFor(chain)} that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: gas.first,
      time: '5 minutes',
    },
    sequenceFor(p),
    riskFor(p, age, implied, capital, hold),
    {
      text: actionFor(p, capital, where),
      cost: `$${capital} of capital and about $${gas.setup} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyFor(p),
      cost: gas.weekly,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `The model puts ${p.name} at ${fmtUsd(implied)} of implied value. A $${net.deposit_usd} farm here nets ${fmtSignedUsd(net.net_usd)} after gas (expected share ${fmtSignedUsd(net.gross_usd)} minus ${fmtSignedUsd(net.gas_usd)} gas), so the verdict is ${net.verdict}: re-check the board each month and unwind if TVL halves or the points page goes quiet.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_to_tvl:
        p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    rank_low: row.rank_low,
    rank_median: row.rank_median,
    rank_high: row.rank_high,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    farm_net_usd: row.farm_net_usd,
    farm_verdict: row.farm_verdict,
    multiple: row.model.multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    watchlist: watchlist.has(row.slug),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants,
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  // The comparables: every live protocol the fit rests on, categories ordered by their fitted
  // multiple (a category with too few live names falls back to the global multiple), then by
  // market cap inside the category, so the dashboard can group them in that order.
  const multOf = (cat: string | null): number =>
    model.multiples[cat ?? 'Other'] ?? model.global_multiple;
  const comparables: Comparable[] = liveForFit(snapshot.protocols)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
    }))
    .sort((a, b) => {
      const dm = multOf(b.category) - multOf(a.category);
      if (dm !== 0) return dm;
      const dc = (a.category ?? 'Other') < (b.category ?? 'Other') ? -1 : (a.category ?? 'Other') > (b.category ?? 'Other') ? 1 : 0;
      if (dc !== 0) return dc;
      return b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
    });
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => radarRow(r, watchlist)),
    live,
    comparables,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!Number.isFinite(r.model.multiple) || r.model.multiple <= 0) return `${r.slug} has multiple ${r.model.multiple}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
