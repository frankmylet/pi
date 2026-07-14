import { cloneSessionOperationMetadata, type SessionOperationMetadata } from "./session-operation.ts";

export type SessionReplacementPhase = "idle" | "preparing" | "committing" | "activating" | "rolling_back";

export type SessionReplacementReason = "new" | "resume" | "fork";

export type SessionReplacementOutcome =
	| "cancelled"
	| "committed"
	| "activated"
	| "activation_failed"
	| "failed"
	| "rolled_back";

/** Immutable lifecycle snapshot for the latest session-replacement attempt. */
export interface SessionReplacementState {
	readonly phase: SessionReplacementPhase;
	readonly attemptId?: string;
	readonly reason?: SessionReplacementReason;
	readonly sourceSessionFile?: string;
	readonly destinationSessionFile?: string;
	readonly operation?: SessionOperationMetadata;
	readonly outcome?: SessionReplacementOutcome;
	readonly errorCode?: string;
}

/** Detach and freeze a replacement-state snapshot before exposing it. */
export function createSessionReplacementState(
	state: Omit<SessionReplacementState, "operation"> & { operation?: SessionOperationMetadata },
): SessionReplacementState {
	return Object.freeze({
		...state,
		...(state.operation ? { operation: cloneSessionOperationMetadata(state.operation) } : {}),
	});
}

/** Typed refusal returned when a second replacement reaches an active replacement transaction. */
export class SessionReplacementBusyError extends Error {
	readonly code = "replacement_busy" as const;
	readonly state: SessionReplacementState;

	constructor(state: SessionReplacementState) {
		super(`Session replacement is busy (${state.phase})`);
		this.name = "SessionReplacementBusyError";
		this.state = createSessionReplacementState(state);
	}
}
