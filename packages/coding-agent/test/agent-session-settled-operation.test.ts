import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionOperationAcceptance, SettledOperationContext } from "../src/index.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

describe("settled operations", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("drains once after every settled handler and the public settled event", async () => {
		const order: string[] = [];
		const acceptances: SessionOperationAcceptance[] = [];
		let operationContext: SettledOperationContext | undefined;
		let rejectedMetadataMutations = 0;
		let rejectedContextMutation = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerSettledOperation<{ value: string }>("record", {
						handler: (input, ctx) => {
							order.push(`operation:${input.value}`);
							operationContext = ctx;
							try {
								Object.defineProperty(ctx, "operation", { value: { operationId: "spoofed" } });
							} catch {
								rejectedContextMutation = true;
							}
						},
					});
					pi.on("agent_settled", () => {
						order.push("handler:first");
						const acceptance = pi.scheduleSettledOperation({
							name: "record",
							input: { value: "ok" },
							dedupeKey: "turn",
						});
						acceptances.push(
							acceptance,
							pi.scheduleSettledOperation({ name: "record", input: { value: "duplicate" }, dedupeKey: "turn" }),
						);
						if (!acceptance.accepted) return;
						for (const mutate of [
							() => Object.defineProperty(acceptance.operation, "operationId", { value: "spoofed" }),
							() => Object.defineProperty(acceptance.operation.origin, "operationName", { value: "spoofed" }),
							() => Object.defineProperty(acceptance.operation.origin.sourceInfo, "path", { value: "spoofed" }),
						]) {
							try {
								mutate();
							} catch {
								rejectedMetadataMutations++;
							}
						}
					});
				},
				(pi) => {
					pi.on("agent_settled", () => {
						order.push("handler:second");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") order.push("public");
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");

		expect(order).toEqual(["handler:first", "handler:second", "public", "operation:ok"]);
		expect(acceptances[0]).toMatchObject({ accepted: true });
		expect(acceptances[1]).toEqual({ accepted: false, code: "duplicate" });
		if (!acceptances[0].accepted) throw new Error("operation was not accepted");
		expect(acceptances[0].operation.operationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(operationContext?.operation).toEqual(acceptances[0].operation);
		expect(operationContext?.operation).not.toBe(acceptances[0].operation);
		expect(Object.isFrozen(acceptances[0].operation)).toBe(true);
		expect(Object.isFrozen(acceptances[0].operation.origin)).toBe(true);
		expect(Object.isFrozen(acceptances[0].operation.origin.sourceInfo)).toBe(true);
		expect(rejectedMetadataMutations).toBe(3);
		expect(rejectedContextMutation).toBe(true);
		expect(operationContext?.operation.origin.operationName).toBe("record");
		expect(operationContext?.operation.origin.extensionPath).toMatch(/^<inline:\d+>$/);
		expect("newSession" in (operationContext ?? {})).toBe(false);
		expect(getUserTexts(harness)).toEqual(["hello"]);
	});

	it("retains dedupe keys through terminal execution for the extension generation", async () => {
		const acceptances: SessionOperationAcceptance[] = [];
		let operationRuns = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerSettledOperation("record", {
						handler: () => {
							operationRuns++;
						},
					});
					pi.on("agent_settled", () => {
						acceptances.push(
							pi.scheduleSettledOperation({ name: "record", input: null, dedupeKey: "generation-key" }),
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(acceptances.map((acceptance) => acceptance.accepted)).toEqual([true, false]);
		expect(acceptances[1]).toEqual({ accepted: false, code: "duplicate" });
		expect(operationRuns).toBe(1);
	});

	it("cancels stale work when a later settled handler admits a newer prompt", async () => {
		let settledCount = 0;
		let operationRuns = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerSettledOperation("record", {
						handler: () => {
							operationRuns++;
						},
					});
					pi.on("agent_settled", () => {
						settledCount++;
						if (settledCount === 1) {
							expect(pi.scheduleSettledOperation({ name: "record", input: null }).accepted).toBe(true);
						}
					});
				},
				(pi) => {
					pi.on("agent_settled", () => {
						if (settledCount === 1) pi.sendUserMessage("newer prompt");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("original");
		await harness.session.waitForIdle();

		expect(operationRuns).toBe(0);
		expect(getUserTexts(harness)).toEqual(["original", "newer prompt"]);
	});

	it("cancels queued work when the source run is aborted before settlement", async () => {
		let operationRuns = 0;
		let acceptance: SessionOperationAcceptance | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerSettledOperation("record", {
						handler: () => {
							operationRuns++;
						},
					});
					pi.on("agent_end", (_event, ctx) => {
						acceptance = pi.scheduleSettledOperation({ name: "record", input: null });
						ctx.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");

		expect(acceptance?.accepted).toBe(true);
		expect(operationRuns).toBe(0);
	});

	it("rejects scheduling from a source while its extension generation reloads", async () => {
		let acceptance: SessionOperationAcceptance | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerSettledOperation("record", { handler: () => {} });
					pi.on("session_shutdown", () => {
						acceptance = pi.scheduleSettledOperation({ name: "record", input: null, dedupeKey: "reload" });
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.reload();

		expect(acceptance).toEqual({ accepted: false, code: "stale_source" });
	});

	it.each(["reload", "dispose", "stale"] as const)("cancels queued work on %s", async (action) => {
		let operationRuns = 0;
		let sideEffect: Promise<void> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerSettledOperation("record", {
						handler: () => {
							operationRuns++;
						},
					});
					pi.on("agent_settled", () => {
						pi.scheduleSettledOperation({ name: "record", input: null });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			if (action === "reload") sideEffect = harness.session.reload();
			if (action === "dispose") harness.session.dispose();
			if (action === "stale") harness.sessionManager.appendCustomEntry("test-stale-source");
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");
		await sideEffect;

		expect(operationRuns).toBe(0);
	});

	it("keeps disposal terminal when it races an active faux-provider response", async () => {
		let releaseResponse = () => {};
		const responseReleased = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let markResponseStarted = () => {};
		const responseStarted = new Promise<void>((resolve) => {
			markResponseStarted = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				markResponseStarted();
				await responseReleased;
				return fauxAssistantMessage("late response");
			},
		]);

		const prompt = harness.session.prompt("hello");
		await responseStarted;
		expect(harness.session.isStreaming).toBe(true);

		harness.session.dispose();
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		releaseResponse();
		await prompt;

		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		await expect(harness.session.prompt("must not restart")).rejects.toThrow("Agent session is disposed");
	});

	it("aborts the signal for an in-flight operation on dispose", async () => {
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const operationStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let signalAborted = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerSettledOperation("wait", {
						handler: async (_input, ctx) => {
							started();
							await released;
							signalAborted = ctx.signal.aborted;
						},
					});
					pi.on("agent_settled", () => {
						pi.scheduleSettledOperation({ name: "wait", input: null });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		const prompt = harness.session.prompt("hello");
		await operationStarted;
		harness.session.dispose();
		release();
		await prompt;

		expect(signalAborted).toBe(true);
	});
});
