// polymarket-nvidia-ceo-forecast-01 entry (Node 22, standard library only).
//
// Forecast: a random-walk quantile forecast in the shape of the house
// baseline's, but with the spread fitted to the market instead of one fixed
// sigma for every market:
//
//   q_tau(h) = clamp(x + z_tau * sigma * sqrt(h), 0, 1),  sigma = clamp(0.02 * x, 0.0001, 0.004)
//
// where x is the market's Yes price at the checkpoint and h = 1..240 is the
// minute after it. The upper tail is widened by 30% for low-priced markets
// (x < 0.05): their moves are right-skewed, because a price cannot go
// below 0 but can jump up several-fold.
//
// Why this shape (measured on the practice, not assumed):
// - The baseline's fixed sigma 0.0025 over-covers (practice 90% coverage
//   0.9496) and scores 0.363589. A global sweep puts the best fixed sigma
//   near 0.0008 (0.326921): most markets barely move, so a narrower band
//   wins at almost every quiet minute.
// - But one sigma does not fit all: the 24 markets span prices from 0.0015
//   to 0.295, and their realised move sizes grow with the price level
//   (roughly multiplicatively). A spread proportional to the price level,
//   sigma = 0.02 * x, fits every market better than any fixed sigma and
//   beats the baseline on all six practice cases.
// - Fitting sigma from each market's recent volatility instead does NOT
//   help: the estimate is dominated by rare jumps and by secular trends
//   (a market that fell hard over the last day looks volatile, but its
//   next 4 hours are usually quiet). A drift term hurts for the same
//   reason — recent trends in these markets usually retrace. So the entry
//   uses no history beyond the checkpoint price: it is robust to regime
//   change and cannot be fooled by a stale window.
// - The loss surface is flat near the chosen constants (px 0.02-0.03,
//   floor 0.0001-0.0002, cap 0.003-0.004 all score within 0.001), so the
//   formula is a structural fit, not a sharp optimum tuned to one window.
//
// Practice score (local scorer, ground truth re-fetched from Polymarket's
// public CLOB price history; the scorer reproduces the house baseline's
// published practice numbers exactly, loss 0.363589): this entry scores
// 0.286251, median error 0.61, 90% coverage ~0.93, every case valid.
//
// Output: {"forecasts":[{"id","q"}]}, q = 240 rows of 5 non-decreasing
// numbers in [0,1], 6 decimals. Deterministic: no randomness, no clock,
// no network; two runs on the same case write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** Spread per unit of price level. */
const SIGMA_PER_PRICE = 0.02;
/** Sigma floor / cap (price units per sqrt-minute). */
const SIGMA_FLOOR = 0.0001;
const SIGMA_CAP = 0.004;
/** Extra width of the upper tail for low-priced markets. */
const LOW_PRICE = 0.05;
const UPPER_SKEW = 1.3;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

function forecast(m: CaseMarket, horizon: number): number[][] {
  if (m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const x = m.prices[m.prices.length - 1] as number;
  const sigma = Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, SIGMA_PER_PRICE * x));
  const upper = x < LOW_PRICE ? UPPER_SKEW : 1;
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const rootH = Math.sqrt(h);
    const row = Z.map((z) => price6(x + z * (z > 0 ? upper : 1) * sigma * rootH));
    row.sort((a, b) => a - b);
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
