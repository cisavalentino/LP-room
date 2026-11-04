/**
 * Transaction plans. In paper mode the Executor builds an abstract plan of the instructions it
 * *would* send (program, kind, token movements) and inspects + simulates that. Nothing here can
 * be signed or sent.
 */

/** Account labels: `wallet:<mint>`, `position:<address>`, `pool:<pool>:<mint>`, `route:jupiter`. */
export interface Transfer {
  mint: string;
  amount: number;
  from: string;
  to: string;
}

export interface PlannedInstruction {
  programId: string;
  kind: string;
  transfers: Transfer[];
}

export interface TxPlan {
  instructions: PlannedInstruction[];
  /** Network fees in SOL (base + priority) for all transactions in the plan. */
  feesSol: number;
  priorityFeeLamports: number;
  computeUnitLimit: number;
}

export interface InspectionContext {
  allowlist: ReadonlySet<string>;
  /** The pool this proposal is about (transfers to its accounts are allowed). */
  pool: string | null;
  /** Our position addresses (transfers to them are allowed). */
  positions: ReadonlySet<string>;
  jupiterProgram: string;
}

/**
 * Step 3: every program must be on the allowlist; token transfers only to our own accounts or
 * to the pool — the Jupiter route account only from a Jupiter instruction. Returns violations.
 */
export function inspectPlan(plan: TxPlan, ctx: InspectionContext): string[] {
  const v: string[] = [];
  if (!plan.instructions.length) v.push("EMPTY_PLAN");
  plan.instructions.forEach((ix, i) => {
    if (!ctx.allowlist.has(ix.programId)) v.push(`ix${i}: program ${ix.programId} not allowlisted`);
    for (const t of ix.transfers) {
      if (!(t.amount >= 0) || !Number.isFinite(t.amount)) v.push(`ix${i}: invalid amount ${t.amount}`);
      const to = t.to;
      const ok =
        to.startsWith("wallet:") ||
        (to.startsWith("position:") && ctx.positions.has(to.slice("position:".length))) ||
        (ctx.pool !== null && to.startsWith(`pool:${ctx.pool}:`)) ||
        (to === "route:jupiter" && ix.programId === ctx.jupiterProgram);
      if (!ok) v.push(`ix${i}: transfer of ${t.mint} to foreign account ${to}`);
    }
  });
  return v;
}

/** Net wallet balance change per mint implied by a plan (excluding network fees). */
export function walletDeltas(plan: TxPlan): Map<string, number> {
  const d = new Map<string, number>();
  for (const ix of plan.instructions) {
    for (const t of ix.transfers) {
      if (t.from.startsWith("wallet:")) d.set(t.mint, (d.get(t.mint) ?? 0) - t.amount);
      if (t.to.startsWith("wallet:")) d.set(t.mint, (d.get(t.mint) ?? 0) + t.amount);
    }
  }
  return d;
}
