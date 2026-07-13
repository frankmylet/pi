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
		readonly sourceInfo: Readonly<SourceInfo>;
	};
}

/** Create a detached, deeply immutable metadata snapshot. */
export function createSessionOperationMetadata(
	operationId: string,
	extensionPath: string,
	operationName: string,
	sourceInfo: SourceInfo,
): SessionOperationMetadata {
	return Object.freeze({
		operationId,
		origin: Object.freeze({
			extensionPath,
			operationName,
			sourceInfo: Object.freeze({ ...sourceInfo }),
		}),
	});
}

/** Detach immutable metadata before exposing it at another trust boundary. */
export function cloneSessionOperationMetadata(metadata: SessionOperationMetadata): SessionOperationMetadata {
	return createSessionOperationMetadata(
		metadata.operationId,
		metadata.origin.extensionPath,
		metadata.origin.operationName,
		metadata.origin.sourceInfo,
	);
}

/**
 * Context created when a settled operation drains. This intentionally excludes
 * command-only session replacement and navigation methods.
 */
export interface SettledOperationContext extends ExtensionContext {
	readonly operation: SessionOperationMetadata;
	readonly signal: AbortSignal;
}

/** Declarative command invocation requested by a settled-operation handler. */
export interface SettledOperationCommandInvocation {
	readonly type: "invoke_command";
	/** Registration name of a command owned by the same extension. */
	readonly command: string;
	/** Raw command arguments, without a slash-command prefix. */
	readonly args?: string;
}

export type SettledOperationResult = SettledOperationCommandInvocation;

export type SettledOperationHandler<TInput extends JsonValue = JsonValue> = (
	input: TInput,
	ctx: SettledOperationContext,
) =>
	| void
	| SettledOperationResult
	// biome-ignore lint/suspicious/noConfusingVoidType: async handlers may return no result
	| Promise<void | SettledOperationResult>;

export interface SettledOperationRegistration<TInput extends JsonValue = JsonValue> {
	handler: SettledOperationHandler<TInput>;
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
	| { readonly accepted: true; readonly operation: SessionOperationMetadata }
	| { readonly accepted: false; readonly code: SessionOperationRejectionCode };
