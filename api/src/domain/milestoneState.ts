/** The single state enum used by every route, job, UI action and payment operation. */
export enum MilestoneState {
  DRAFT = "DRAFT",
  PROPOSED = "PROPOSED",
  LOCKED = "LOCKED",
  FUNDED = "FUNDED",
  VERIFYING = "VERIFYING",
  FAILED = "FAILED",
  REVIEW = "REVIEW",
  DISPUTE = "DISPUTE",
  CAPTURE_PENDING = "CAPTURE_PENDING",
  CAPTURED = "CAPTURED",
  CAPTURE_FAILED = "CAPTURE_FAILED",
  AUTH_EXPIRED = "AUTH_EXPIRED",
  VOID_PENDING = "VOID_PENDING",
  VOIDED = "VOIDED",
}
const S = MilestoneState;

export type Actor = "client" | "freelancer" | "admin" | "system" | "payment" | "verification" | "job";

export type TransitionCtx = {
  /** a finished run with every automated check passed exists */
  hasPassingRun?: boolean;
  /** a previous finished run failed (decides where a run error returns to) */
  hadFailingRun?: boolean;
  /** an authorization that can still be voided exists */
  liveAuth?: boolean;
};

type Rule = {
  from: MilestoneState[];
  to: MilestoneState | ((from: MilestoneState, ctx: TransitionCtx) => MilestoneState);
  actors: Actor[];
};

export const RULES = {
  PROPOSAL_READY: { from: [S.DRAFT, S.PROPOSED], to: S.PROPOSED, actors: ["system"] },
  CRITERION_EDITED: { from: [S.PROPOSED], to: S.PROPOSED, actors: ["client", "freelancer"] },
  LOCK: { from: [S.PROPOSED], to: S.LOCKED, actors: ["client", "freelancer"] },
  AUTHORIZED: {
    from: [S.LOCKED, S.AUTH_EXPIRED, S.CAPTURE_FAILED],
    to: (from, ctx) =>
      from === S.LOCKED ? S.FUNDED
      : from === S.CAPTURE_FAILED ? S.CAPTURE_PENDING
      : ctx.hasPassingRun ? S.REVIEW : S.FUNDED,
    actors: ["payment"],
  },
  SUBMIT: { from: [S.FUNDED, S.FAILED], to: S.VERIFYING, actors: ["freelancer"] },
  RUN_FAILED: { from: [S.VERIFYING], to: S.FAILED, actors: ["verification"] },
  RUN_PASSED: { from: [S.VERIFYING], to: S.REVIEW, actors: ["verification"] },
  RUN_ERROR: { from: [S.VERIFYING], to: (_f, ctx) => (ctx.hadFailingRun ? S.FAILED : S.FUNDED), actors: ["verification"] },
  ACCEPT: { from: [S.REVIEW], to: S.CAPTURE_PENDING, actors: ["client"] },
  REJECT: { from: [S.REVIEW], to: S.DISPUTE, actors: ["client"] },
  RESOLVE_FOR_FREELANCER: { from: [S.DISPUTE], to: S.CAPTURE_PENDING, actors: ["admin"] },
  RESOLVE_FOR_CLIENT: { from: [S.DISPUTE], to: S.VOID_PENDING, actors: ["admin"] },
  CANCEL: { from: [S.FUNDED, S.FAILED], to: S.VOID_PENDING, actors: ["client"] },
  DEADLINE_PASSED: { from: [S.FUNDED, S.FAILED], to: S.VOID_PENDING, actors: ["job"] },
  AUTH_EXPIRED: { from: [S.FUNDED, S.FAILED, S.REVIEW, S.DISPUTE], to: S.AUTH_EXPIRED, actors: ["payment"] },
  CAPTURE_COMPLETED: { from: [S.CAPTURE_PENDING], to: S.CAPTURED, actors: ["payment"] },
  CAPTURE_DECLINED: { from: [S.CAPTURE_PENDING], to: S.CAPTURE_FAILED, actors: ["payment"] },
  ADMIN_CLOSE: {
    from: [S.CAPTURE_FAILED, S.AUTH_EXPIRED],
    to: (_f, ctx) => (ctx.liveAuth ? S.VOID_PENDING : S.VOIDED),
    actors: ["admin"],
  },
  VOID_CONFIRMED: { from: [S.VOID_PENDING], to: S.VOIDED, actors: ["payment"] },
} satisfies Record<string, Rule>;

export type MilestoneEvent = keyof typeof RULES;

export function resolveTarget(event: MilestoneEvent, from: MilestoneState, ctx: TransitionCtx): MilestoneState {
  const rule: Rule = RULES[event];
  return typeof rule.to === "function" ? rule.to(from, ctx) : rule.to;
}
