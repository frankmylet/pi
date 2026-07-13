import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionOperationMetadata } from "../src/core/session-operation.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory, persisted = true) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const controls = { failNextCreation: false };
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			if (controls.failNextCreation) {
				controls.failNextCreation = false;
				throw new Error("destination creation failed");
			}
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: persisted ? SessionManager.create(tempDir) : SessionManager.inMemory(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux, controls };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("threads settled-operation metadata through command-driven session replacement", async () => {
		const events: RecordedSessionEvent[] = [];
		let commandOperationId: string | undefined;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.registerCommand("replace", {
				handler: async (_args, ctx) => {
					commandOperationId = ctx.operation?.operationId;
					await ctx.newSession();
				},
			});
			pi.registerSettledOperation("replace", {
				handler: () => ({ type: "invoke_command", command: "replace" }),
			});
			pi.on("agent_settled", () => {
				pi.scheduleSettledOperation({ name: "replace", input: null });
			});
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});
		await runtimeHost.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => runtimeHost.session.waitForIdle(),
				newSession: (options, operation) => runtimeHost.newSession(options, operation),
				fork: async (entryId, options, operation) => {
					const result = await runtimeHost.fork(entryId, options, operation);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await runtimeHost.session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionPath, options, operation) =>
					runtimeHost.switchSession(sessionPath, options, operation),
				reload: () => runtimeHost.session.reload(),
			},
		});
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		await runtimeHost.session.bindExtensions({});

		expect(commandOperationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(events).toHaveLength(3);
		const operations = events.map((event) => event.operation);
		expect(operations.every((operation) => operation?.operationId === commandOperationId)).toBe(true);
		expect(operations.every((operation) => Object.isFrozen(operation))).toBe(true);
		expect(operations[0]).not.toBe(operations[1]);
		expect(operations[1]).not.toBe(operations[2]);
		expect(operations[0]?.origin.operationName).toBe("replace");
		expect(events.map((event) => event.type)).toEqual(["session_before_switch", "session_shutdown", "session_start"]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("keeps the source usable when destination creation fails", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost, controls } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
		});
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		const sourceServices = runtimeHost.services;
		const sourceDiagnostics = runtimeHost.diagnostics;
		controls.failNextCreation = true;

		await expect(runtimeHost.newSession()).rejects.toThrow("destination creation failed");

		expect(runtimeHost.session).toBe(source);
		expect(runtimeHost.services).toBe(sourceServices);
		expect(runtimeHost.diagnostics).toBe(sourceDiagnostics);
		expect(events).toEqual([]);
		expect(() => source.extensionRunner.createContext()).not.toThrow();
		await expect(source.prompt("still usable")).resolves.toBeUndefined();
	});

	it("keeps the source unchanged when destination setup fails", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
		});
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		const sourceMessages = [...source.messages];
		const sourceLeaf = source.sessionManager.getLeafId();

		await expect(
			runtimeHost.newSession({
				setup: async () => {
					throw new Error("destination setup failed");
				},
			}),
		).rejects.toThrow("destination setup failed");

		expect(runtimeHost.session).toBe(source);
		expect(source.messages).toEqual(sourceMessages);
		expect(source.sessionManager.getLeafId()).toBe(sourceLeaf);
		expect(events).toEqual([]);
		expect(() => source.extensionRunner.createContext()).not.toThrow();
	});

	it("rolls back a destination whose rebind fails after session_start", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		events.length = 0;
		runtimeHost.setRebindSession(async (session, event) => {
			await session.bindExtensions({}, event);
			if (session !== source) throw new Error("destination rebind failed");
		});
		const operation = createSessionOperationMetadata("operation-id", "/extension.ts", "replace", {
			path: "/extension.ts",
			source: "/extension.ts",
			scope: "temporary",
			origin: "top-level",
		});

		await expect(runtimeHost.newSession(undefined, operation)).rejects.toThrow("destination rebind failed");

		expect(runtimeHost.session).toBe(source);
		expect(events.map((event) => `${event.type}:${"reason" in event ? event.reason : ""}`)).toEqual([
			"session_before_switch:new",
			"session_shutdown:new",
			"session_start:new",
			"session_shutdown:rollback",
			"session_start:rollback",
		]);
		const propagatedOperations = events.map((event) => event.operation);
		expect(propagatedOperations.every((value) => value?.operationId === operation.operationId)).toBe(true);
		expect(propagatedOperations.every((value) => Object.isFrozen(value))).toBe(true);
		expect(new Set(propagatedOperations).size).toBe(propagatedOperations.length);
		expect(() => source.extensionRunner.createContext()).not.toThrow();
		await expect(source.prompt("still usable")).resolves.toBeUndefined();
	});

	it("suspends captured source APIs and restores them after withSession failure", async () => {
		const apis: ExtensionAPI[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			apis.push(pi);
		});
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		runtimeHost.setRebindSession((session, event) => session.bindExtensions({}, event));

		await expect(
			runtimeHost.newSession({
				withSession: async () => {
					expect(() => apis[0].getCommands()).toThrow(/suspended/);
					throw new Error("kickoff failed");
				},
			}),
		).rejects.toThrow("kickoff failed");

		expect(runtimeHost.session).toBe(source);
		expect(() => apis[0].getCommands()).not.toThrow();
		await expect(source.prompt("still usable")).resolves.toBeUndefined();
	});

	it("permanently invalidates the retained source only after successful kickoff", async () => {
		const apis: ExtensionAPI[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			apis.push(pi);
		});
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		runtimeHost.setRebindSession((session, event) => session.bindExtensions({}, event));

		await runtimeHost.newSession({
			withSession: async () => {
				expect(runtimeHost.session).not.toBe(source);
				expect(() => apis[0].getCommands()).toThrow(/suspended/);
			},
		});

		expect(runtimeHost.session).not.toBe(source);
		expect(() => apis[0].getCommands()).toThrow(/stale/);
	});

	it("atomically admits a concurrent prompt only after replacement commits", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("hello");
		runtimeHost.setRebindSession((session, event) => session.bindExtensions({}, event));
		let enterKickoff!: () => void;
		const kickoffEntered = new Promise<void>((resolve) => {
			enterKickoff = resolve;
		});
		let finishKickoff!: () => void;
		const kickoffGate = new Promise<void>((resolve) => {
			finishKickoff = resolve;
		});
		const replacement = runtimeHost.newSession({
			withSession: async () => {
				enterKickoff();
				await kickoffGate;
			},
		});
		await kickoffEntered;

		let admittedSession: typeof runtimeHost.session | undefined;
		let admitted = false;
		const concurrentPrompt = runtimeHost
			.startSessionOperation((session) => {
				admittedSession = session;
				return session.prompt("concurrent");
			})
			.then(() => {
				admitted = true;
			});
		await Promise.resolve();
		expect(admitted).toBe(false);

		finishKickoff();
		await replacement;
		await concurrentPrompt;
		expect(admittedSession).toBe(runtimeHost.session);
		expect(admitted).toBe(true);
	});

	it("delays reload until replacement commits and targets the destination", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("hello");
		runtimeHost.setRebindSession((session, event) => session.bindExtensions({}, event));
		let enterKickoff!: () => void;
		const kickoffEntered = new Promise<void>((resolve) => {
			enterKickoff = resolve;
		});
		let finishKickoff!: () => void;
		const kickoffGate = new Promise<void>((resolve) => {
			finishKickoff = resolve;
		});
		const replacement = runtimeHost.newSession({
			withSession: async () => {
				enterKickoff();
				await kickoffGate;
			},
		});
		await kickoffEntered;

		let reloadSession: typeof runtimeHost.session | undefined;
		const reload = runtimeHost.runExclusiveSessionOperation(async (session) => {
			reloadSession = session;
			await session.reload();
		});
		await Promise.resolve();
		expect(reloadSession).toBeUndefined();

		finishKickoff();
		await replacement;
		await reload;
		expect(reloadSession).toBe(runtimeHost.session);
	});

	it("rejects non-reentrant replacement while an admitted prompt is active", async () => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {});
		let finishResponse!: () => void;
		const responseGate = new Promise<void>((resolve) => {
			finishResponse = resolve;
		});
		faux.setResponses([
			async () => {
				await responseGate;
				return fauxAssistantMessage("done");
			},
		]);
		let preflightComplete!: () => void;
		const preflight = new Promise<void>((resolve) => {
			preflightComplete = resolve;
		});
		const prompt = runtimeHost.startPromptOperation((session, releaseAfterPreflight) =>
			session.prompt("active", {
				preflightResult: () => {
					releaseAfterPreflight();
					preflightComplete();
				},
			}),
		);
		await preflight;

		await expect(runtimeHost.newSession()).rejects.toThrow("Cannot replace the session while agent work is active");
		expect(runtimeHost.isSessionReplacementInProgress).toBe(false);

		finishResponse();
		await prompt;
	});

	it("aborts destination kickoff and restores the source when replacement is cancelled", async () => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		runtimeHost.setRebindSession((session, event) => session.bindExtensions({}, event));
		let kickoffEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			kickoffEntered = resolve;
		});
		faux.setResponses([
			(_context, options) =>
				new Promise<never>((_resolve, reject) => {
					kickoffEntered();
					const signal = options?.signal;
					if (signal?.aborted) {
						reject(new Error("kickoff aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("kickoff aborted")), { once: true });
				}),
		]);
		const replacement = runtimeHost.newSession({
			withSession: (ctx) => ctx.sendUserMessage("kickoff"),
		});
		await entered;
		const cancellation = runtimeHost.cancelSessionReplacement("cancel test replacement");

		await expect(replacement).rejects.toThrow("cancel test replacement");
		await expect(cancellation).resolves.toBe(true);
		expect(runtimeHost.session).toBe(source);
		expect(() => source.extensionRunner.createContext()).not.toThrow();
		faux.setResponses([fauxAssistantMessage("after rollback")]);
		await expect(source.prompt("still usable")).resolves.toBeUndefined();
	});

	it("rolls back an active replacement before shutdown disposes the source", async () => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		runtimeHost.setRebindSession((session, event) => session.bindExtensions({}, event));
		let kickoffEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			kickoffEntered = resolve;
		});
		faux.setResponses([
			(_context, options) =>
				new Promise<never>((_resolve, reject) => {
					kickoffEntered();
					options?.signal?.addEventListener("abort", () => reject(new Error("kickoff aborted")), { once: true });
				}),
		]);
		const replacement = runtimeHost.newSession({
			withSession: (ctx) => ctx.sendUserMessage("kickoff"),
		});
		await entered;
		const shutdown = runtimeHost.dispose();

		await expect(replacement).rejects.toThrow("Session replacement cancelled by shutdown");
		await expect(shutdown).resolves.toBeUndefined();
		expect(runtimeHost.session).toBe(source);
		expect(() => source.extensionRunner.createContext().cwd).toThrow(/stale/);
		await expect(runtimeHost.dispose()).resolves.toBeUndefined();
	});

	it("allows an extension command to replace its session through reentrant prompt admission", async () => {
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.registerCommand("replace", {
				handler: async (_args, ctx) => {
					await ctx.newSession();
				},
			});
		});
		const source = runtimeHost.session;
		const bindSession = (session: typeof runtimeHost.session, event?: SessionStartEvent) =>
			session.bindExtensions(
				{
					commandContextActions: {
						waitForIdle: () => session.waitForIdle(),
						newSession: (options, operation) => runtimeHost.newSession(options, operation),
						fork: async (entryId, options, operation) => {
							const result = await runtimeHost.fork(entryId, options, operation);
							return { cancelled: result.cancelled };
						},
						navigateTree: async (targetId, options) => {
							const result = await session.navigateTree(targetId, options);
							return { cancelled: result.cancelled };
						},
						switchSession: (sessionPath, options, operation) =>
							runtimeHost.switchSession(sessionPath, options, operation),
						reload: () => session.reload(),
					},
				},
				event,
			);
		runtimeHost.setRebindSession(bindSession);
		await bindSession(source);

		await expect(
			runtimeHost.startPromptOperation((session, releaseAfterPreflight) =>
				session.prompt("/replace", { preflightResult: releaseAfterPreflight }),
			),
		).resolves.toBeUndefined();

		expect(runtimeHost.session).not.toBe(source);
		expect(() => source.extensionRunner.createContext().cwd).toThrow(/stale/);
	});

	it("does not mutate an in-memory source manager when fork activation fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {}, false);
		await runtimeHost.session.prompt("hello");
		const source = runtimeHost.session;
		const sourceEntries = structuredClone(source.sessionManager.getEntries());
		const sourceLeaf = source.sessionManager.getLeafId();
		const sourceId = source.sessionManager.getSessionId();
		const userMessage = source.getUserMessagesForForking()[0];
		runtimeHost.setRebindSession(async (session, event) => {
			await session.bindExtensions({}, event);
			if (session !== source) throw new Error("fork activation failed");
		});

		await expect(runtimeHost.fork(userMessage.entryId, { position: "at" })).rejects.toThrow("fork activation failed");

		expect(runtimeHost.session).toBe(source);
		expect(source.sessionManager.getSessionId()).toBe(sourceId);
		expect(source.sessionManager.getLeafId()).toBe(sourceLeaf);
		expect(source.sessionManager.getEntries()).toEqual(sourceEntries);
		await expect(source.prompt("still usable")).resolves.toBeUndefined();
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
