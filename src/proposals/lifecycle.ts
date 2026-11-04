import type { Store } from "../db/store";
import type { Proposal, ProposalAction, ProposalParams, ProposalState } from "../types";

/**
 * Proposal state machine (PRD §9).
 *
 * PROPOSED ─► MANAGER_APPROVED ─► RISK_APPROVED ─► (HUMAN_APPROVED) ─► EXECUTING ─► DONE
 *     │              │                  │                  │                 │
 *     └─► REJECTED   └─► REJECTED       └─► REJECTED       └─► EXPIRED       └─► FAILED
 *
 * Emergency exits skip the Manager: PROPOSED ─► RISK_APPROVED ─► EXECUTING.
 * The Executor may send a stale proposal back to Risk (RISK_APPROVED ─► MANAGER_APPROVED, or
 * ─► PROPOSED for emergencies, both of which the Risk Officer picks up again).
 */
const TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  PROPOSED: ["MANAGER_APPROVED", "RISK_APPROVED", "REJECTED", "EXPIRED"],
  MANAGER_APPROVED: ["RISK_APPROVED", "REJECTED", "EXPIRED"],
  RISK_APPROVED: ["HUMAN_APPROVED", "EXECUTING", "REJECTED", "EXPIRED", "MANAGER_APPROVED", "PROPOSED"],
  HUMAN_APPROVED: ["EXECUTING", "EXPIRED", "MANAGER_APPROVED", "PROPOSED"],
  EXECUTING: ["DONE", "FAILED"],
  DONE: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
};

export const TERMINAL_STATES: ReadonlySet<ProposalState> = new Set(["DONE", "REJECTED", "EXPIRED", "FAILED"]);

export class IllegalTransitionError extends Error {}

export function canTransition(p: Pick<Proposal, "state" | "emergency">, to: ProposalState): boolean {
  if (!TRANSITIONS[p.state].includes(to)) return false;
  // Only emergencies may skip the Manager.
  if (p.state === "PROPOSED" && to === "RISK_APPROVED" && !p.emergency) return false;
  // A non-emergency sent back to Risk goes to MANAGER_APPROVED, an emergency to PROPOSED.
  if ((p.state === "RISK_APPROVED" || p.state === "HUMAN_APPROVED") && to === "PROPOSED" && !p.emergency) return false;
  if ((p.state === "RISK_APPROVED" || p.state === "HUMAN_APPROVED") && to === "MANAGER_APPROVED" && p.emergency) return false;
  return true;
}

export interface TransitionOpts {
  actor: string;
  note?: string;
  params?: ProposalParams;
  refPrice?: number | null;
  expiresAt?: number | null;
}

/**
 * Atomically moves a proposal to `to`. Uses a compare-and-set on the current state so two
 * workers can never both move the same proposal (e.g. double execution).
 */
export function transition(store: Store, id: number, to: ProposalState, opts: TransitionOpts): Proposal {
  return store.db.tx(() => {
    const p = store.getProposal(id);
    if (!p) throw new Error(`Proposal ${id} not found`);
    if (!canTransition(p, to)) {
      throw new IllegalTransitionError(`Proposal ${id}: ${p.state} → ${to} not allowed${p.emergency ? " (emergency)" : ""}`);
    }
    const now = store.now();
    const sets = ["state = ?", "updated_at = ?"];
    const vals: (string | number | null)[] = [to, now];
    if (opts.params) {
      sets.push("params_json = ?");
      vals.push(JSON.stringify(opts.params));
    }
    if (opts.refPrice !== undefined) {
      sets.push("ref_price = ?");
      vals.push(opts.refPrice);
    }
    if (opts.expiresAt !== undefined) {
      sets.push("expires_at = ?");
      vals.push(opts.expiresAt);
    }
    const r = store.db.run(`UPDATE proposals SET ${sets.join(", ")} WHERE id = ? AND state = ?`, [...vals, id, p.state]);
    if (r.changes !== 1) throw new IllegalTransitionError(`Proposal ${id} changed concurrently`);
    store.db.run(
      "INSERT INTO proposal_transitions (proposal_id, from_state, to_state, actor, note, ts) VALUES (?, ?, ?, ?, ?, ?)",
      [id, p.state, to, opts.actor, opts.note ?? null, now],
    );
    return store.getProposal(id)!;
  });
}

export function createProposal(
  store: Store,
  p: {
    action: ProposalAction;
    source: string;
    emergency?: boolean;
    priority?: number;
    position_id?: number | null;
    pool?: string | null;
    event_id?: number | null;
    params?: ProposalParams;
    reasoning?: string;
  },
): Proposal {
  return store.db.tx(() => {
    const id = store.insertProposal({ ...p, state: "PROPOSED" });
    store.db.run(
      "INSERT INTO proposal_transitions (proposal_id, from_state, to_state, actor, note, ts) VALUES (?, NULL, 'PROPOSED', ?, ?, ?)",
      [id, p.source, p.reasoning ?? null, store.now()],
    );
    return store.getProposal(id)!;
  });
}

/**
 * Code-generated emergency FULL_EXIT (STOP_LOSS, TOKEN_FLAGGED, severe TVL_DROP, kill switch,
 * /exitall). Idempotent per position: an existing active exit is reused.
 */
export function proposeEmergencyExit(
  store: Store,
  positionId: number,
  source: string,
  reasoning: string,
  eventId: number | null = null,
): Proposal {
  return store.db.tx(() => {
    const existing = store
      .activeProposalsForPosition(positionId)
      .find((p) => p.action === "FULL_EXIT" && p.emergency);
    if (existing) return existing;
    // Any pending non-exit proposals for the position are superseded.
    for (const p of store.activeProposalsForPosition(positionId)) {
      if (p.state !== "EXECUTING" && p.action !== "FULL_EXIT") {
        transition(store, p.id, "REJECTED", { actor: source, note: "superseded by emergency exit" });
      }
    }
    const pos = store.getPosition(positionId);
    return createProposal(store, {
      action: "FULL_EXIT",
      source,
      emergency: true,
      priority: 100,
      position_id: positionId,
      pool: pos?.pool ?? null,
      event_id: eventId,
      params: { fraction: 1 },
      reasoning,
    });
  });
}

export function transitionsOf(store: Store, id: number) {
  return store.db.all<{ from_state: string | null; to_state: string; actor: string; note: string | null; ts: number }>(
    "SELECT from_state, to_state, actor, note, ts FROM proposal_transitions WHERE proposal_id = ? ORDER BY id",
    [id],
  );
}
