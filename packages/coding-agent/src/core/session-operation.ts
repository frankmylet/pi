import type { ExtensionContext } from "./extensions/types.ts";
import type { SourceInfo } from "./source-info.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Core-authored identity for one accepted settled operation. */
export interface SessionOperationMetadata {
	readonly operationId: string;
	readonly origin: {
		readonly extensionPath: string;
		readonly operationName: string;
		readonly sourceInfo: SourceInfo;
	};
}

/**
 * Context created when a settled operation drains. This intentionally excludes
 * command-only session replacement and navigation methods.
 */
export interface SettledOperationContext extends ExtensionContext {
	readonly operation: SessionOperationMetadata;
	readonly signal: AbortSignal;
}

export interface SettledOperationRegistration<TInput extends JsonValue = JsonValue> {
	handler: (input: TInput, ctx: SettledOperationContext) => void | Promise<void>;
}

export interface ScheduleSettledOperationRequest<TInput extends JsonValue = JsonValue> {
	name: string;
	input: TInput;
	/** Optional extension-chosen idempotency key. Scoped to this registration and session generation. */
	dedupeKey?: string;
}

export type SessionOperationRejectionCode =
	| "invalid_request"
	| "unknown_operation"
	| "duplicate"
	| "stale_source"
	| "not_settling"
	| "aborted"
	| "disposed";

export type SessionOperationAcceptance =
	| { accepted: true; operation: SessionOperationMetadata }
	| { accepted: false; code: SessionOperationRejectionCode };
