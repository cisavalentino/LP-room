import type { Strategy } from "../types";

/**
 * Paper model of a Meteora DLMM position.
 *
 * DLMM bins are constant-sum: bin i has price P_i = (1 + binStep/10_000)^i (per lamport) and
 * liquidity L_i = P_i·x + y (in Y units). Bins below the active bin hold only Y, bins above
 * hold only X, and the active bin holds a mix (modelled as 50/50 by value).
 */
export interface DlmmPositionModel {
  binStep: number;
  decimalsX: number;
  decimalsY: number;
  /** liquidity per bin in Y (UI) units, at that bin's price */
  bins: { id: number; liq: number }[];
  /** paper fee accrual (USD) not yet claimed */
  feesUnclaimedUsd: number;
  lastAccrualTs: number;
}

export function binPrice(binId: number, binStep: number, decX: number, decY: number): number {
  return Math.pow(1 + binStep / 10_000, binId) * Math.pow(10, decX - decY);
}

export function binIdFromPrice(price: number, binStep: number, decX: number, decY: number): number {
  if (!(price > 0)) throw new Error(`invalid price ${price}`);
  const lamportPrice = price / Math.pow(10, decX - decY);
  // small epsilon so a price exactly on a bin boundary maps to that bin
  return Math.floor(Math.log(lamportPrice) / Math.log(1 + binStep / 10_000) + 1e-9);
}

/** Number of bins each side of the active bin for a ±rangePct range. */
export function binsForRangePct(rangePct: number, binStep: number): number {
  return Math.max(1, Math.ceil(Math.log(1 + rangePct / 100) / Math.log(1 + binStep / 10_000)));
}

function weight(strategy: Strategy, offset: number, half: number): number {
  const d = Math.abs(offset) / Math.max(1, half);
  if (strategy === "curve") return Math.max(0.05, 1 - d); // concentrated at the active bin
  if (strategy === "bid_ask") return 0.05 + d; // concentrated at the edges
  return 1; // spot
}

/**
 * Builds a position of total value `valueY` (in Y units) around `activeBin`.
 * Returns the model and the X / Y amounts that must be deposited.
 */
export function createPosition(params: {
  valueY: number;
  activeBin: number;
  lowerBin: number;
  upperBin: number;
  binStep: number;
  decimalsX: number;
  decimalsY: number;
  strategy: Strategy;
  now: number;
}): { model: DlmmPositionModel; depositX: number; depositY: number } {
  const { valueY, activeBin, lowerBin, upperBin, binStep, decimalsX, decimalsY, strategy, now } = params;
  if (upperBin < lowerBin) throw new Error("upperBin < lowerBin");
  const half = Math.max(activeBin - lowerBin, upperBin - activeBin);
  const ws: { id: number; w: number }[] = [];
  for (let id = lowerBin; id <= upperBin; id++) ws.push({ id, w: weight(strategy, id - activeBin, half) });
  const unit: DlmmPositionModel = {
    binStep, decimalsX, decimalsY,
    bins: ws.map(({ id, w }) => ({ id, liq: w })),
    feesUnclaimedUsd: 0,
    lastAccrualTs: now,
  };
  // Scale so the deposit's market value at the active price equals valueY.
  const activePrice = binPrice(activeBin, binStep, decimalsX, decimalsY);
  const k = valueY / valueInY(unit, activeBin, activePrice);
  const model: DlmmPositionModel = { ...unit, bins: unit.bins.map((b) => ({ id: b.id, liq: b.liq * k })) };
  const { x, y } = composition(model, activeBin);
  return { model, depositX: x, depositY: y };
}

/** Token amounts held by the position when the active bin is `activeBin`. */
export function composition(model: DlmmPositionModel, activeBin: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const b of model.bins) {
    const p = binPrice(b.id, model.binStep, model.decimalsX, model.decimalsY);
    if (b.id < activeBin) y += b.liq;
    else if (b.id > activeBin) x += b.liq / p;
    else {
      y += b.liq / 2;
      x += b.liq / 2 / p;
    }
  }
  return { x, y };
}

export function inRange(model: DlmmPositionModel, activeBin: number): boolean {
  const ids = model.bins.map((b) => b.id);
  return activeBin >= Math.min(...ids) && activeBin <= Math.max(...ids);
}

/** Value of the position in Y units at pool price `price` (X in Y). */
export function valueInY(model: DlmmPositionModel, activeBin: number, price: number): number {
  const { x, y } = composition(model, activeBin);
  return x * price + y;
}

/** Removes `fraction` of liquidity from every bin; returns the removed X / Y. */
export function removeLiquidity(model: DlmmPositionModel, activeBin: number, fraction: number): {
  model: DlmmPositionModel;
  x: number;
  y: number;
} {
  const f = Math.max(0, Math.min(1, fraction));
  const { x, y } = composition(model, activeBin);
  return {
    model: { ...model, bins: model.bins.map((b) => ({ ...b, liq: b.liq * (1 - f) })) },
    x: x * f,
    y: y * f,
  };
}
