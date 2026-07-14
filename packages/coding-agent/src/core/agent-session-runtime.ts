import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";
import { cloneSessionOperationMetadata, type SessionOperationMetadata } from "./session-operation.ts";
import {
	createSessionReplacementState,
	SessionReplacementBusyError,
	type SessionReplacementReason,
	type SessionReplacementState,
} from "./session-replacement.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

interface AgentSessionRuntimeState {
	session: AgentSession;
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
}

interface SessionReplacementAttempt {
	attemptId: string;
	reason: SessionReplacementReason;
	sourceSessionFile: string | undefined;
	operation?: SessionOperationMetadata;
}

interface StagedInitialPrompt {
	preflight: Promise<void>;
	completion: Promise<void>;
	activate: () => void;
	cancel: (error: unknown) => void;
}

interface CommittedSessionReplacement {
	attempt: SessionReplacementAttempt;
	destination: AgentSession;
	destinationSessionFile: string | undefined;
	activation?: StagedInitialPrompt;
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Replacement is transactional: the destination runtime is prepared before the
 * source is invalidated, and the source AgentSession is retained until rebind and
 * `withSession` kickoff complete. A failed destination is disposed and the source
 * is rebound before the original error is returned.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession, sessionStartEvent?: SessionStartEvent) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private replacementInProgress = false;
	private replacementBarrier: Promise<void> = Promise.resolve();
	private resolveReplacementBarrier?: () => void;
	private replacementCancellation?: Error;
	private replacementDestination?: AgentSession;
	private committedReplacement?: CommittedSessionReplacement;
	private _sessionReplacementState = createSessionReplacementState({ phase: "idle" });
	private readonly sessionReplacementListeners = new Set<(state: SessionReplacementState) => void>();
	private admissionTail: Promise<void> = Promise.resolve();
	private admissionOwner?: symbol;
	private readonly admissionContext = new AsyncLocalStorage<symbol>();
	private disposePromise?: Promise<void>;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(
		rebindSession?: (session: AgentSession, sessionStartEvent?: SessionStartEvent) => Promise<void>,
	): void {
		this.rebindSession = rebindSession;
	}

	get isSessionReplacementInProgress(): boolean {
		return this.replacementInProgress;
	}

	get sessionReplacementState(): SessionReplacementState {
		return this._sessionReplacementState;
	}

	subscribeSessionReplacement(listener: (state: SessionReplacementState) => void): () => void {
		this.sessionReplacementListeners.add(listener);
		return () => this.sessionReplacementListeners.delete(listener);
	}

	private setSessionReplacementState(state: SessionReplacementState): void {
		this._sessionReplacementState = createSessionReplacementState(state);
		for (const listener of this.sessionReplacementListeners) {
			try {
				listener(this._sessionReplacementState);
			} catch {
				// Observers cannot alter replacement ownership.
			}
		}
	}

	private async acquireSessionAdmission(): Promise<{ token: symbol; release: () => void }> {
		let releaseCurrent!: () => void;
		const current = new Promise<void>((resolveCurrent) => {
			releaseCurrent = resolveCurrent;
		});
		const previous = this.admissionTail;
		this.admissionTail = previous.then(() => current);
		await previous;
		const token = Symbol("session-admission");
		this.admissionOwner = token;
		let released = false;
		return {
			token,
			release: () => {
				if (released) return;
				released = true;
				if (this.admissionOwner === token) this.admissionOwner = undefined;
				releaseCurrent();
			},
		};
	}

	private hasInheritedAdmission(): boolean {
		const inherited = this.admissionContext.getStore();
		return inherited !== undefined && inherited === this.admissionOwner;
	}

	/** Atomically select the current session and initiate a non-exclusive action. */
	async startSessionOperation<T>(start: (session: AgentSession) => T): Promise<T> {
		if (this.hasInheritedAdmission()) return start(this.session);
		const admission = await this.acquireSessionAdmission();
		let result: T;
		try {
			result = this.admissionContext.run(admission.token, () => start(this.session));
		} finally {
			admission.release();
		}
		return result;
	}

	/**
	 * Start a prompt while holding admission through preflight. The caller must
	 * invoke `releaseAfterPreflight` from PromptOptions.preflightResult.
	 */
	async startPromptOperation(
		start: (session: AgentSession, releaseAfterPreflight: () => void) => Promise<void>,
	): Promise<void> {
		if (this.hasInheritedAdmission()) {
			await start(this.session, () => {});
			return;
		}
		const admission = await this.acquireSessionAdmission();
		try {
			await this.admissionContext.run(admission.token, () => start(this.session, admission.release));
		} finally {
			admission.release();
		}
	}

	/** Run an action to completion without racing session replacement. */
	async runExclusiveSessionOperation<T>(run: (session: AgentSession) => Promise<T> | T): Promise<T> {
		if (this.hasInheritedAdmission()) return run(this.session);
		const admission = await this.acquireSessionAdmission();
		try {
			return await this.admissionContext.run(admission.token, () => run(this.session));
		} finally {
			admission.release();
		}
	}

	/** Wait until the currently active replacement commits or rolls back. */
	async waitForSessionReplacement(): Promise<void> {
		while (this.replacementInProgress) {
			await this.replacementBarrier;
		}
	}

	/**
	 * Request rollback of an active replacement and abort destination work.
	 * Returns false when no replacement is active.
	 */
	requestSessionReplacementCancellation(reason = "Session replacement cancelled"): boolean {
		if (!this.replacementInProgress) return false;
		this.replacementCancellation ??= new Error(reason);
		void this.replacementDestination?.abort().catch(() => undefined);
		return true;
	}

	/** Request cancellation and wait until rollback has restored the source. */
	async cancelSessionReplacement(reason?: string): Promise<boolean> {
		if (!this.requestSessionReplacementCancellation(reason)) return false;
		await this.waitForSessionReplacement();
		return true;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
		operation?: SessionOperationMetadata,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
			...(operation ? { operation: cloneSessionOperationMetadata(operation) } : {}),
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
		operation?: SessionOperationMetadata,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
			...(operation ? { operation: cloneSessionOperationMetadata(operation) } : {}),
		});
		return { cancelled: result?.cancel === true };
	}

	private snapshot(): AgentSessionRuntimeState {
		return {
			session: this._session,
			services: this._services,
			diagnostics: this._diagnostics,
			modelFallbackMessage: this._modelFallbackMessage,
		};
	}

	private apply(result: AgentSessionRuntimeState): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private throwIfReplacementCancelled(): void {
		if (this.replacementCancellation) throw this.replacementCancellation;
	}

	private getReplacementErrorCode(error: unknown, fallback: string): string {
		if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
			return error.code;
		}
		if (error === this.replacementCancellation) return "replacement_cancelled";
		return fallback;
	}

	private async emitSessionReplacementState(session: AgentSession, state: SessionReplacementState): Promise<void> {
		try {
			await session.extensionRunner.emit({ type: "session_replacement", state });
		} catch {
			// Lifecycle telemetry must not change commit or rollback ownership.
		}
	}

	private stageInitialPrompt(destination: AgentSession, initialPrompt: string): StagedInitialPrompt {
		let resolvePreflight!: () => void;
		let rejectPreflight!: (error: unknown) => void;
		let preflightSettled = false;
		const preflight = new Promise<void>((resolve, reject) => {
			resolvePreflight = resolve;
			rejectPreflight = reject;
		});

		let resolveActivation!: () => void;
		let rejectActivation!: (error: unknown) => void;
		let activationSettled = false;
		const activationGate = new Promise<void>((resolve, reject) => {
			resolveActivation = resolve;
			rejectActivation = reject;
		});
		void activationGate.catch(() => undefined);

		const completion = destination
			.prompt(initialPrompt, {
				expandPromptTemplates: false,
				source: "extension",
				activationGate,
				preflightResult: (accepted) => {
					if (!accepted || preflightSettled) return;
					preflightSettled = true;
					resolvePreflight();
				},
			})
			.then(
				() => {
					if (!preflightSettled) {
						preflightSettled = true;
						resolvePreflight();
					}
				},
				(error: unknown) => {
					if (!preflightSettled) {
						preflightSettled = true;
						rejectPreflight(error);
					}
					throw error;
				},
			);
		void completion.catch(() => undefined);

		return {
			preflight,
			completion,
			activate: () => {
				if (activationSettled) return;
				activationSettled = true;
				resolveActivation();
			},
			cancel: (error) => {
				if (activationSettled) return;
				activationSettled = true;
				rejectActivation(error instanceof Error ? error : new Error(String(error)));
			},
		};
	}

	private async finalizeCommittedReplacement(commit: CommittedSessionReplacement): Promise<void> {
		const { attempt, activation, destination, destinationSessionFile } = commit;
		const committedState = createSessionReplacementState({
			phase: activation ? "activating" : "idle",
			attemptId: attempt.attemptId,
			reason: attempt.reason,
			sourceSessionFile: attempt.sourceSessionFile,
			destinationSessionFile,
			operation: attempt.operation,
			outcome: "committed",
		});
		this.setSessionReplacementState(committedState);
		await this.emitSessionReplacementState(destination, committedState);

		if (!activation) return;
		activation.activate();
		void activation.completion.then(
			async () => {
				if (
					this.session !== destination ||
					this._sessionReplacementState.attemptId !== attempt.attemptId ||
					this._sessionReplacementState.phase !== "activating"
				) {
					return;
				}
				const activatedState = createSessionReplacementState({
					...committedState,
					phase: "idle",
					outcome: "activated",
				});
				this.setSessionReplacementState(activatedState);
				await this.emitSessionReplacementState(destination, activatedState);
			},
			async (error: unknown) => {
				if (
					this.session !== destination ||
					this._sessionReplacementState.attemptId !== attempt.attemptId ||
					this._sessionReplacementState.phase !== "activating"
				) {
					return;
				}
				const failedState = createSessionReplacementState({
					...committedState,
					phase: "idle",
					outcome: "activation_failed",
					errorCode: this.getReplacementErrorCode(error, "activation_failed"),
				});
				this.setSessionReplacementState(failedState);
				await this.emitSessionReplacementState(destination, failedState);
			},
		);
	}

	private async runSessionReplacement<T>(
		reason: SessionReplacementReason,
		operation: SessionOperationMetadata | undefined,
		replace: (attempt: SessionReplacementAttempt) => Promise<T>,
	): Promise<T> {
		if (this.replacementInProgress) {
			throw new SessionReplacementBusyError(this._sessionReplacementState);
		}
		const isReentrant = this.hasInheritedAdmission();
		const admission = isReentrant ? undefined : await this.acquireSessionAdmission();
		if (this.replacementInProgress) {
			admission?.release();
			throw new SessionReplacementBusyError(this._sessionReplacementState);
		}
		if (!isReentrant && !this.session.isIdle) {
			admission?.release();
			throw new Error("Cannot replace the session while agent work is active");
		}

		const attempt: SessionReplacementAttempt = {
			attemptId: randomUUID(),
			reason,
			sourceSessionFile: this.session.sessionFile,
			...(operation ? { operation: cloneSessionOperationMetadata(operation) } : {}),
		};
		this.replacementInProgress = true;
		this.replacementCancellation = undefined;
		this.committedReplacement = undefined;
		this.setSessionReplacementState(
			createSessionReplacementState({
				phase: "preparing",
				attemptId: attempt.attemptId,
				reason,
				sourceSessionFile: attempt.sourceSessionFile,
				operation: attempt.operation,
			}),
		);
		this.replacementBarrier = new Promise<void>((resolveBarrier) => {
			this.resolveReplacementBarrier = resolveBarrier;
		});

		try {
			const result = await replace(attempt);
			if (!this.committedReplacement && this._sessionReplacementState.attemptId === attempt.attemptId) {
				const cancelledState = createSessionReplacementState({
					...this._sessionReplacementState,
					phase: "idle",
					outcome: "cancelled",
				});
				this.setSessionReplacementState(cancelledState);
				await this.emitSessionReplacementState(this.session, cancelledState);
			}
			return result;
		} catch (error) {
			if (!this.committedReplacement && this._sessionReplacementState.attemptId === attempt.attemptId) {
				const failedState = createSessionReplacementState({
					...this._sessionReplacementState,
					phase: "idle",
					outcome: this._sessionReplacementState.outcome ?? "failed",
					errorCode:
						this._sessionReplacementState.errorCode ?? this.getReplacementErrorCode(error, "replacement_failed"),
				});
				this.setSessionReplacementState(failedState);
				await this.emitSessionReplacementState(this.session, failedState);
			}
			throw error;
		} finally {
			const commit = this.committedReplacement;
			this.committedReplacement = undefined;
			this.replacementDestination = undefined;
			this.replacementCancellation = undefined;
			this.replacementInProgress = false;
			this.resolveReplacementBarrier?.();
			this.resolveReplacementBarrier = undefined;
			if (commit) {
				await this.finalizeCommittedReplacement(commit);
			}
			admission?.release();
		}
	}

	private async emitShutdown(
		session: AgentSession,
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
		operation?: SessionOperationMetadata,
	): Promise<void> {
		await emitSessionShutdownEvent(session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
			...(operation ? { operation: cloneSessionOperationMetadata(operation) } : {}),
		});
	}

	private async finishSessionReplacement(options: {
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		initialPrompt?: string;
	}): Promise<StagedInitialPrompt | undefined> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		this.throwIfReplacementCancelled();
		if (options.withSession) {
			await options.withSession(this.session.createReplacedSessionContext());
		}
		this.throwIfReplacementCancelled();
		if (options.initialPrompt === undefined) return undefined;

		const activation = this.stageInitialPrompt(this.session, options.initialPrompt);
		try {
			await activation.preflight;
			this.throwIfReplacementCancelled();
			return activation;
		} catch (error) {
			activation.cancel(error);
			throw error;
		}
	}

	private async applyPreparedReplacement(
		prepared: CreateAgentSessionRuntimeResult,
		options: {
			attempt: SessionReplacementAttempt;
			reason: SessionShutdownEvent["reason"];
			operation?: SessionOperationMetadata;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			initialPrompt?: string;
			prepare?: (session: AgentSession) => Promise<void>;
		},
	): Promise<void> {
		const source = this.snapshot();
		const destination = prepared.session;
		const targetSessionFile = destination.sessionFile;
		let sourceShutdown = false;
		let sourceSuspended = false;
		let destinationApplied = false;
		let activation: StagedInitialPrompt | undefined;

		try {
			if (options.prepare) await options.prepare(destination);
			this.throwIfReplacementCancelled();
			this.setSessionReplacementState(
				createSessionReplacementState({
					phase: "committing",
					attemptId: options.attempt.attemptId,
					reason: options.attempt.reason,
					sourceSessionFile: options.attempt.sourceSessionFile,
					destinationSessionFile: targetSessionFile,
					operation: options.attempt.operation,
				}),
			);
			await this.emitShutdown(source.session, options.reason, targetSessionFile, options.operation);
			sourceShutdown = true;
			this.beforeSessionInvalidate?.();
			source.session.suspendExtensionsForReplacement();
			sourceSuspended = true;
			this.throwIfReplacementCancelled();

			this.apply(prepared);
			destinationApplied = true;
			this.replacementDestination = destination;
			activation = await this.finishSessionReplacement({
				withSession: options.withSession,
				initialPrompt: options.initialPrompt,
			});
			source.session.dispose();
			this.committedReplacement = {
				attempt: options.attempt,
				destination,
				destinationSessionFile: targetSessionFile,
				activation,
			};
			return;
		} catch (error) {
			activation?.cancel(error);
			const rollbackErrors: unknown[] = [];
			const rollbackRequired = sourceShutdown || sourceSuspended || destinationApplied;
			if (rollbackRequired) {
				this.setSessionReplacementState(
					createSessionReplacementState({
						phase: "rolling_back",
						attemptId: options.attempt.attemptId,
						reason: options.attempt.reason,
						sourceSessionFile: options.attempt.sourceSessionFile,
						destinationSessionFile: targetSessionFile,
						operation: options.attempt.operation,
					}),
				);
			}
			if (destinationApplied) {
				try {
					await this.emitShutdown(destination, "rollback", source.session.sessionFile, options.operation);
				} catch (shutdownError) {
					rollbackErrors.push(shutdownError);
				}
				try {
					this.beforeSessionInvalidate?.();
				} catch (invalidateError) {
					rollbackErrors.push(invalidateError);
				}
			}
			destination.dispose();
			this.apply(source);
			if (sourceSuspended) source.session.resumeExtensionsAfterReplacement();

			if (sourceShutdown || destinationApplied) {
				try {
					await this.rebindSession?.(source.session, {
						type: "session_start",
						reason: "rollback",
						previousSessionFile: targetSessionFile,
						...(options.operation ? { operation: cloneSessionOperationMetadata(options.operation) } : {}),
					});
				} catch (rebindError) {
					rollbackErrors.push(rebindError);
				}
			}

			this.setSessionReplacementState(
				createSessionReplacementState({
					phase: "idle",
					attemptId: options.attempt.attemptId,
					reason: options.attempt.reason,
					sourceSessionFile: options.attempt.sourceSessionFile,
					destinationSessionFile: targetSessionFile,
					operation: options.attempt.operation,
					outcome: rollbackRequired ? "rolled_back" : "failed",
					errorCode: this.getReplacementErrorCode(error, "replacement_failed"),
				}),
			);

			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					"Session replacement failed and source rollback encountered additional errors",
				);
			}
			throw error;
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
		operation?: SessionOperationMetadata,
	): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement("resume", operation, async (attempt) => {
			const beforeResult = await this.emitBeforeSwitch("resume", sessionPath, operation);
			if (beforeResult.cancelled) return beforeResult;

			const previousSessionFile = this.session.sessionFile;
			const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
			const prepared = await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: {
					type: "session_start",
					reason: "resume",
					previousSessionFile,
					...(operation ? { operation: cloneSessionOperationMetadata(operation) } : {}),
				},
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			});
			await this.applyPreparedReplacement(prepared, {
				attempt,
				reason: "resume",
				operation,
				withSession: options?.withSession,
			});
			return { cancelled: false };
		});
	}

	async newSession(
		options?: {
			parentSession?: string;
			setup?: (sessionManager: SessionManager) => Promise<void>;
			initialPrompt?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
		operation?: SessionOperationMetadata,
	): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement("new", operation, async (attempt) => {
			const beforeResult = await this.emitBeforeSwitch("new", undefined, operation);
			if (beforeResult.cancelled) return beforeResult;

			const previousSessionFile = this.session.sessionFile;
			const sessionDir = this.session.sessionManager.getSessionDir();
			const sessionManager = this.session.sessionManager.isPersisted()
				? SessionManager.create(this.cwd, sessionDir)
				: SessionManager.inMemory(this.cwd);
			if (options?.parentSession) {
				sessionManager.newSession({ parentSession: options.parentSession });
			}

			const prepared = await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: {
					type: "session_start",
					reason: "new",
					previousSessionFile,
					...(operation ? { operation: cloneSessionOperationMetadata(operation) } : {}),
				},
			});
			await this.applyPreparedReplacement(prepared, {
				attempt,
				reason: "new",
				operation,
				initialPrompt: options?.initialPrompt,
				withSession: options?.withSession,
				prepare: options?.setup
					? async (session) => {
							await options.setup?.(session.sessionManager);
							session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
						}
					: undefined,
			});
			return { cancelled: false };
		});
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
		operation?: SessionOperationMetadata,
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.runSessionReplacement("fork", operation, async (attempt) => {
			const position = options?.position ?? "before";
			const beforeResult = await this.emitBeforeFork(entryId, { position }, operation);
			if (beforeResult.cancelled) return { cancelled: true };

			const selectedEntry = this.session.sessionManager.getEntry(entryId);
			if (!selectedEntry) throw new Error("Invalid entry ID for forking");

			let targetLeafId: string | null;
			let selectedText: string | undefined;
			if (position === "at") {
				targetLeafId = selectedEntry.id;
			} else {
				if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
					throw new Error("Invalid entry ID for forking");
				}
				targetLeafId = selectedEntry.parentId;
				selectedText = extractUserMessageText(selectedEntry.message.content);
			}

			const previousSessionFile = this.session.sessionFile;
			let sessionManager: SessionManager;
			if (this.session.sessionManager.isPersisted()) {
				const currentSessionFile = this.session.sessionFile;
				if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
				const sessionDir = this.session.sessionManager.getSessionDir();
				if (!targetLeafId) {
					sessionManager = SessionManager.create(this.cwd, sessionDir);
					sessionManager.newSession({ parentSession: currentSessionFile });
				} else {
					sessionManager = SessionManager.open(currentSessionFile, sessionDir);
					if (!sessionManager.createBranchedSession(targetLeafId)) {
						throw new Error("Failed to create forked session");
					}
				}
			} else {
				sessionManager = this.session.sessionManager.cloneInMemory();
				if (!targetLeafId) {
					sessionManager.newSession({ parentSession: this.session.sessionFile });
				} else {
					sessionManager.createBranchedSession(targetLeafId);
				}
			}

			const prepared = await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: {
					type: "session_start",
					reason: "fork",
					previousSessionFile,
					...(operation ? { operation: cloneSessionOperationMetadata(operation) } : {}),
				},
			});
			await this.applyPreparedReplacement(prepared, {
				attempt,
				reason: "fork",
				operation,
				withSession: options?.withSession,
			});
			return { cancelled: false, selectedText };
		});
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement("resume", undefined, async (attempt) => {
			const resolvedPath = resolvePath(inputPath);
			if (!existsSync(resolvedPath)) throw new SessionImportFileNotFoundError(resolvedPath);

			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

			const destinationPath = join(sessionDir, basename(resolvedPath));
			const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
			if (beforeResult.cancelled) return beforeResult;

			const previousSessionFile = this.session.sessionFile;
			if (resolve(destinationPath) !== resolvedPath) copyFileSync(resolvedPath, destinationPath);

			const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
			const prepared = await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			});
			await this.applyPreparedReplacement(prepared, { attempt, reason: "resume" });
			return { cancelled: false };
		});
	}

	async dispose(): Promise<void> {
		this.disposePromise ??= this.disposeOnce();
		await this.disposePromise;
	}

	private async disposeOnce(): Promise<void> {
		if (this.replacementInProgress) {
			this.requestSessionReplacementCancellation("Session replacement cancelled by shutdown");
			await this.waitForSessionReplacement();
		}
		await this.runExclusiveSessionOperation(async (session) => {
			await emitSessionShutdownEvent(session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
			this.beforeSessionInvalidate?.();
			session.dispose();
		});
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
