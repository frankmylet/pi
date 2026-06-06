import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCHEMA_VERSION = "v0";
const EXTENSION_NAME = "cross-agent-context";
const SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
const CLOSED_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

const BASE_DIR = join(homedir(), ".local", "state", "pi-agent", "context-contract");
const SESSIONS_DIR = join(BASE_DIR, "sessions");
const REQUESTS_DIR = join(BASE_DIR, "requests");

const ScopeSchema = StringEnum(["status", "files", "decisions", "errors", "full-summary", "custom"] as const, {
	description: "Scope of context being requested from the owner session.",
	default: "status",
});

const UrgencySchema = StringEnum(["low", "normal", "blocking"] as const, {
	description: "How urgent this request is to the requester.",
	default: "normal",
});

const DecisionSchema = StringEnum(["approved", "rejected", "deferred", "unknown", "error"] as const, {
	description: "Owner decision for a context request.",
});

type ContextScope = "status" | "files" | "decisions" | "errors" | "full-summary" | "custom";
type ContextUrgency = "low" | "normal" | "blocking";
type ContextDecision = "approved" | "rejected" | "deferred" | "unknown" | "error";
type ContractState =
	| "requested"
	| "queued"
	| "approved"
	| "released"
	| "rejected"
	| "deferred"
	| "unknown"
	| "error"
	| "expired";

type ContractEventType =
	| "created"
	| "queued"
	| "approved"
	| "released"
	| "rejected"
	| "deferred"
	| "unknown"
	| "error"
	| "expired"
	| "registered";

interface SessionRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	sessionId: string;
	name?: string;
	alias?: string;
	role?: string;
	cwd: string;
	cwdName: string;
	sessionFile?: string;
	pid: number;
	host: string;
	startedAt: string;
	lastSeenAt: string;
}

interface SessionRef {
	sessionId: string;
	name?: string;
	alias?: string;
	role?: string;
	cwd: string;
	sessionFile?: string;
	host: string;
}

interface ContextContractEvent {
	ts: string;
	type: ContractEventType;
	actor: SessionRef;
	message?: string;
}

interface ContextContract {
	schemaVersion: typeof SCHEMA_VERSION;
	id: string;
	state: ContractState;
	createdAt: string;
	updatedAt: string;
	requester: SessionRef;
	owner: SessionRef;
	target: string;
	purpose: string;
	requestedScope: ContextScope;
	urgency: ContextUrgency;
	message: string;
	decision?: {
		value: ContextDecision;
		reason?: string;
		approvedScope?: ContextScope[];
		restrictions?: string[];
		decidedAt: string;
	};
	release?: {
		context: string;
		createdAt: string;
		producedBy: SessionRef;
	};
	events: ContextContractEvent[];
}

interface ResolveResult {
	status: "ok" | "none" | "ambiguous";
	record?: SessionRecord;
	candidates: SessionRecord[];
}

interface RuntimeState {
	alias?: string;
	role?: string;
	startedAt: string;
	notifiedRequestIds: Set<string>;
	timer?: ReturnType<typeof setInterval>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function isTerminalState(state: ContractState): boolean {
	return ["released", "rejected", "deferred", "unknown", "error", "expired"].includes(state);
}

function safeFileName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function requestPath(id: string): string {
	return join(REQUESTS_DIR, `${safeFileName(id)}.json`);
}

function sessionPath(sessionId: string): string {
	return join(SESSIONS_DIR, `${safeFileName(sessionId)}.json`);
}

async function ensureDirs(): Promise<void> {
	await mkdir(SESSIONS_DIR, { recursive: true });
	await mkdir(REQUESTS_DIR, { recursive: true });
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(tmp, path);
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		return undefined;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function parseSessionRecord(value: unknown): SessionRecord | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const sessionId = asString(record.sessionId);
	const cwd = asString(record.cwd);
	const cwdName = asString(record.cwdName);
	const lastSeenAt = asString(record.lastSeenAt);
	const startedAt = asString(record.startedAt);
	const host = asString(record.host);
	const pid = typeof record.pid === "number" ? record.pid : undefined;
	if (!sessionId || !cwd || !cwdName || !lastSeenAt || !startedAt || !host || pid === undefined) return undefined;
	return {
		schemaVersion: SCHEMA_VERSION,
		sessionId,
		...(asString(record.name) ? { name: asString(record.name) } : {}),
		...(asString(record.alias) ? { alias: asString(record.alias) } : {}),
		...(asString(record.role) ? { role: asString(record.role) } : {}),
		cwd,
		cwdName,
		...(asString(record.sessionFile) ? { sessionFile: asString(record.sessionFile) } : {}),
		pid,
		host,
		startedAt,
		lastSeenAt,
	};
}

function parseSessionRef(value: unknown): SessionRef | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const sessionId = asString(record.sessionId);
	const cwd = asString(record.cwd);
	const host = asString(record.host);
	if (!sessionId || !cwd || !host) return undefined;
	return {
		sessionId,
		...(asString(record.name) ? { name: asString(record.name) } : {}),
		...(asString(record.alias) ? { alias: asString(record.alias) } : {}),
		...(asString(record.role) ? { role: asString(record.role) } : {}),
		cwd,
		...(asString(record.sessionFile) ? { sessionFile: asString(record.sessionFile) } : {}),
		host,
	};
}

function isContextScope(value: unknown): value is ContextScope {
	return ["status", "files", "decisions", "errors", "full-summary", "custom"].includes(String(value));
}

function isContextUrgency(value: unknown): value is ContextUrgency {
	return ["low", "normal", "blocking"].includes(String(value));
}

function isContractState(value: unknown): value is ContractState {
	return [
		"requested",
		"queued",
		"approved",
		"released",
		"rejected",
		"deferred",
		"unknown",
		"error",
		"expired",
	].includes(String(value));
}

function isContextDecision(value: unknown): value is ContextDecision {
	return ["approved", "rejected", "deferred", "unknown", "error"].includes(String(value));
}

function parseContract(value: unknown): ContextContract | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const id = asString(record.id);
	const state = record.state;
	const createdAt = asString(record.createdAt);
	const updatedAt = asString(record.updatedAt);
	const requester = parseSessionRef(record.requester);
	const owner = parseSessionRef(record.owner);
	const target = asString(record.target);
	const purpose = asString(record.purpose);
	const requestedScope = record.requestedScope;
	const urgency = record.urgency;
	const message = asString(record.message);
	if (
		!id ||
		!isContractState(state) ||
		!createdAt ||
		!updatedAt ||
		!requester ||
		!owner ||
		!target ||
		!purpose ||
		!isContextScope(requestedScope) ||
		!isContextUrgency(urgency) ||
		!message
	) {
		return undefined;
	}

	const decisionRecord = asRecord(record.decision);
	const decisionValue = decisionRecord ? decisionRecord.value : undefined;
	const decidedAt = decisionRecord ? asString(decisionRecord.decidedAt) : undefined;
	const reason = decisionRecord ? asString(decisionRecord.reason) : undefined;
	const restrictions = decisionRecord ? asStringArray(decisionRecord.restrictions) : undefined;
	const approvedScope =
		decisionRecord &&
		Array.isArray(decisionRecord.approvedScope) &&
		decisionRecord.approvedScope.every(isContextScope)
			? decisionRecord.approvedScope
			: undefined;
	const decision =
		decisionRecord && isContextDecision(decisionValue) && decidedAt
			? {
					value: decisionValue,
					...(reason ? { reason } : {}),
					...(approvedScope ? { approvedScope } : {}),
					...(restrictions ? { restrictions } : {}),
					decidedAt,
				}
			: undefined;

	const releaseRecord = asRecord(record.release);
	const producedBy = releaseRecord ? parseSessionRef(releaseRecord.producedBy) : undefined;
	const releaseContext = releaseRecord ? asString(releaseRecord.context) : undefined;
	const releaseCreatedAt = releaseRecord ? asString(releaseRecord.createdAt) : undefined;
	const release =
		releaseRecord && producedBy && releaseContext && releaseCreatedAt
			? {
					context: releaseContext,
					createdAt: releaseCreatedAt,
					producedBy,
				}
			: undefined;

	const events = Array.isArray(record.events)
		? record.events.flatMap((item) => {
				const event = asRecord(item);
				const actor = event ? parseSessionRef(event.actor) : undefined;
				const type = event ? asString(event.type) : undefined;
				const ts = event ? asString(event.ts) : undefined;
				if (!event || !actor || !type || !ts) return [];
				return [
					{
						ts,
						type: type as ContractEventType,
						actor,
						...(asString(event.message) ? { message: asString(event.message) } : {}),
					},
				];
			})
		: [];

	return {
		schemaVersion: SCHEMA_VERSION,
		id,
		state,
		createdAt,
		updatedAt,
		requester,
		owner,
		target,
		purpose,
		requestedScope,
		urgency,
		message,
		...(decision ? { decision } : {}),
		...(release ? { release } : {}),
		events,
	};
}

async function readSessions(includeStale: boolean): Promise<SessionRecord[]> {
	await ensureDirs();
	const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
	const now = Date.now();
	const records: SessionRecord[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(SESSIONS_DIR, entry.name);
		const parsed = parseSessionRecord(await readJsonFile(path));
		if (!parsed) continue;
		const age = now - Date.parse(parsed.lastSeenAt);
		if (!includeStale && age > SESSION_TTL_MS) continue;
		records.push(parsed);
	}
	return records.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

async function readContracts(): Promise<ContextContract[]> {
	await ensureDirs();
	const entries = await readdir(REQUESTS_DIR, { withFileTypes: true });
	const contracts: ContextContract[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const parsed = parseContract(await readJsonFile(join(REQUESTS_DIR, entry.name)));
		if (parsed) contracts.push(parsed);
	}
	return contracts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readContract(id: string): Promise<ContextContract | undefined> {
	return parseContract(await readJsonFile(requestPath(id)));
}

function sessionRef(record: SessionRecord): SessionRef {
	return {
		sessionId: record.sessionId,
		...(record.name ? { name: record.name } : {}),
		...(record.alias ? { alias: record.alias } : {}),
		...(record.role ? { role: record.role } : {}),
		cwd: record.cwd,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		host: record.host,
	};
}

function currentSessionRecord(ctx: ExtensionContext, state: RuntimeState): SessionRecord {
	const name = ctx.sessionManager.getSessionName();
	const sessionFile = ctx.sessionManager.getSessionFile();
	const cwd = ctx.sessionManager.getCwd();
	return {
		schemaVersion: SCHEMA_VERSION,
		sessionId: ctx.sessionManager.getSessionId(),
		...(name ? { name } : {}),
		...(state.alias ? { alias: state.alias } : {}),
		...(state.role ? { role: state.role } : {}),
		cwd,
		cwdName: basename(cwd),
		...(sessionFile ? { sessionFile } : {}),
		pid: process.pid,
		host: hostname(),
		startedAt: state.startedAt,
		lastSeenAt: nowIso(),
	};
}

async function registerSession(ctx: ExtensionContext, state: RuntimeState): Promise<SessionRecord> {
	const record = currentSessionRecord(ctx, state);
	await ensureDirs();
	await atomicWriteJson(sessionPath(record.sessionId), record);
	return record;
}

function matchesTarget(record: SessionRecord, target: string): boolean {
	const normalized = target.trim().replace(/^@(agent|session):/, "");
	return (
		record.sessionId === normalized ||
		record.sessionId.startsWith(normalized) ||
		record.name === normalized ||
		record.alias === normalized ||
		record.role === normalized ||
		record.cwdName === normalized ||
		record.cwd === normalized
	);
}

async function resolveTarget(target: string, requesterSessionId?: string): Promise<ResolveResult> {
	const candidates = (await readSessions(false)).filter((record) => matchesTarget(record, target));
	const withoutRequester = requesterSessionId
		? candidates.filter((record) => record.sessionId !== requesterSessionId)
		: candidates;
	const usable = withoutRequester.length > 0 ? withoutRequester : candidates;
	if (usable.length === 0) return { status: "none", candidates: [] };
	if (usable.length > 1) return { status: "ambiguous", candidates: usable };
	return { status: "ok", record: usable[0], candidates: usable };
}

function formatSession(record: SessionRecord): string {
	const labels = [record.alias ? `alias=${record.alias}` : undefined, record.name ? `name=${record.name}` : undefined]
		.filter(Boolean)
		.join(" ");
	return `${record.sessionId.slice(0, 8)} ${labels || record.cwdName} cwd=${record.cwd} lastSeen=${record.lastSeenAt}`;
}

function eventFor(type: ContractEventType, actor: SessionRef, message?: string): ContextContractEvent {
	return { ts: nowIso(), type, actor, ...(message ? { message } : {}) };
}

async function updateContract(
	id: string,
	actor: SessionRef,
	fn: (contract: ContextContract) => ContextContract,
): Promise<ContextContract> {
	const current = await readContract(id);
	if (!current) throw new Error(`Unknown context request: ${id}`);
	const updated = fn(current);
	updated.updatedAt = nowIso();
	updated.events = [...updated.events, eventFor(updated.state as ContractEventType, actor)];
	await atomicWriteJson(requestPath(id), updated);
	return updated;
}

function formatContractSummary(contract: ContextContract): string {
	const ownerName = contract.owner.alias ?? contract.owner.name ?? contract.owner.sessionId.slice(0, 8);
	const requesterName =
		contract.requester.alias ?? contract.requester.name ?? contract.requester.sessionId.slice(0, 8);
	return [
		`request=${contract.id}`,
		`state=${contract.state}`,
		`requester=${requesterName}`,
		`owner=${ownerName}`,
		`scope=${contract.requestedScope}`,
		`urgency=${contract.urgency}`,
		`purpose=${contract.purpose}`,
	].join(" ");
}

function formatRegistryReport(sessions: SessionRecord[], contracts: ContextContract[]): string {
	const pending = contracts.filter((contract) => !isTerminalState(contract.state));
	return [
		`Active sessions: ${sessions.length}`,
		...(sessions.length > 0 ? sessions.map((session) => `- ${formatSession(session)}`) : ["- none"]),
		`Pending requests: ${pending.length}`,
		...(pending.length > 0 ? pending.map((contract) => `- ${formatContractSummary(contract)}`) : ["- none"]),
	].join("\n");
}

async function formatAgentSystemHelp(ctx: ExtensionContext, state: RuntimeState): Promise<string> {
	const self = await registerSession(ctx, state);
	const sessions = await readSessions(false);
	const contracts = await readContracts();
	const pending = contracts.filter((contract) => !isTerminalState(contract.state));
	const incoming = pending.filter((contract) => contract.owner.sessionId === self.sessionId).length;
	const outgoing = pending.filter((contract) => contract.requester.sessionId === self.sessionId).length;
	return [
		"# Pi agent system help",
		"",
		"## Current session",
		`- Session: ${self.sessionId}`,
		`- Alias: ${self.alias ?? "none"}`,
		`- Role: ${self.role ?? "none"}`,
		`- Cwd: ${self.cwd}`,
		`- Context peers: ${Math.max(0, sessions.length - 1)}`,
		`- Incoming context blockers: ${incoming}`,
		`- Outgoing context blockers: ${outgoing}`,
		"",
		"## Fast help",
		"- Type `?` to show this help.",
		"- Type `@agent:<target> <request>` to ask another active session for context and block until it responds.",
		"- Use `/agent-context` to inspect local context-contract state.",
		"- Use `/agent-bus status` to inspect the read-only nineight Agent Bus mirror.",
		"- Use `/pi-agents` or `/pi-workflows` to inspect Pi background workers when the Pi Agents extension is loaded.",
		"",
		"## Status line",
		"The cross-agent context extension publishes a compact footer item:",
		"",
		"```text",
		"ctx:<peers>p [<incoming>in] [<outgoing>out]",
		"```",
		"",
		"Examples: `ctx:0p`, `ctx:2p 1in`, `ctx:1p 1out`.",
		"",
		"## Cross-agent context contract",
		"Owner-controlled context sharing between active Pi sessions.",
		"",
		"Commands:",
		"- `/agent-context` or `/agent-context list` — list active sessions and pending requests.",
		"- `/agent-context register <alias> [role]` — set this session's stable address.",
		"- `/agent-context prune` — remove stale session records and old closed request files.",
		"- `/agent-context ?` — show this help.",
		"",
		"Tools available to the model:",
		"- `agent_context_register` — assign alias/role.",
		"- `agent_context_list` — list peers and requests.",
		"- `agent_context_request` — create a scoped request; defaults to waiting for release.",
		"- `agent_context_respond` — owner-only approve/release/reject/defer/unknown/error.",
		"- `agent_context_status` — inspect a request id.",
		"",
		"Contract states:",
		"- Active: `requested`, `queued`, `approved`.",
		"- Terminal: `released`, `rejected`, `deferred`, `unknown`, `error`, `expired`.",
		"",
		"## Agent Bus mirror",
		"Read-only observation path into nineight/federated rosters. The mirror publishes lifecycle events but does not control the Pi session.",
		"",
		"Commands:",
		"- `/agent-bus status` — show endpoint, project, host, session id, and sensitivity settings.",
		"- `/agent-bus heartbeat` — send a manual heartbeat event.",
		"",
		"Typical endpoint: `http://localhost:9888/api/agent-bus/events`.",
		"",
		"## Pi background workers",
		"Pi-owned worker jobs are stored under `~/.pi/agent/jobs/<job-id>/` and are observable through the Pi Agents extension.",
		"",
		"Commands when loaded:",
		"- `/pi-dispatch <prompt-or-plan.md>` — spawn Pi background worker(s).",
		"- `/pi-dispatch --dry-run <prompt-or-plan.md>` — preview without spawning.",
		"- `/pi-agents` or `/agents` — open worker roster.",
		"- `/pi-workflows` — open workflow-grouped roster.",
		"- `/pi-workflow <proposal.md>` — run a workflow proposal via the dispatch engine.",
		"",
		"Job files:",
		"- `config.json` — immutable launch config.",
		"- `state.json` — current worker state.",
		"- `events.jsonl` — normalized event stream when available.",
		"- `stderr.log` — worker stderr.",
		"",
		"## Safety model",
		"- Requesters never read another session transcript directly.",
		"- Owners decide what context is released.",
		"- Do not release secrets, credentials, env values, or unrelated transcript details.",
		"- Agent Bus is an observation seam; control requests must route back to the owning harness.",
		"",
		"## Local registry",
		`- Context sessions: ${SESSIONS_DIR}`,
		`- Context requests: ${REQUESTS_DIR}`,
		"",
		"## Current context registry",
		formatRegistryReport(sessions, contracts),
	].join("\n");
}

async function pruneRegistry(): Promise<{ staleSessions: number; closedRequests: number }> {
	await ensureDirs();
	const currentTime = Date.now();
	let staleSessions = 0;
	let closedRequests = 0;

	const sessionEntries = await readdir(SESSIONS_DIR, { withFileTypes: true });
	for (const entry of sessionEntries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(SESSIONS_DIR, entry.name);
		const record = parseSessionRecord(await readJsonFile(path));
		if (!record || currentTime - Date.parse(record.lastSeenAt) <= SESSION_TTL_MS) continue;
		await unlink(path);
		staleSessions++;
	}

	const requestEntries = await readdir(REQUESTS_DIR, { withFileTypes: true });
	for (const entry of requestEntries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(REQUESTS_DIR, entry.name);
		const contract = parseContract(await readJsonFile(path));
		if (
			!contract ||
			!isTerminalState(contract.state) ||
			currentTime - Date.parse(contract.updatedAt) <= CLOSED_REQUEST_RETENTION_MS
		) {
			continue;
		}
		await unlink(path);
		closedRequests++;
	}

	return { staleSessions, closedRequests };
}

async function updateStatus(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
	if (!ctx.hasUI) return;
	const self = await registerSession(ctx, state);
	const sessions = await readSessions(false);
	const contracts = await readContracts();
	const pending = contracts.filter((contract) => !isTerminalState(contract.state));
	const peers = sessions.filter((session) => session.sessionId !== self.sessionId).length;
	const incoming = pending.filter((contract) => contract.owner.sessionId === self.sessionId).length;
	const outgoing = pending.filter((contract) => contract.requester.sessionId === self.sessionId).length;
	const theme = ctx.ui.theme;
	const parts = [theme.fg("dim", `ctx:${peers}p`)];
	if (incoming > 0) parts.push(theme.fg("warning", `${incoming}in`));
	if (outgoing > 0) parts.push(theme.fg("accent", `${outgoing}out`));
	ctx.ui.setStatus("agent-context", parts.join(" "));
}

function formatOwnerPrompt(contract: ContextContract): string {
	const requesterName =
		contract.requester.alias ?? contract.requester.name ?? contract.requester.sessionId.slice(0, 8);
	return [
		"AGENT_CONTEXT_REQUEST",
		"Another active agent is requesting context from this session. Treat this as an agent-to-agent permission contract.",
		"You own this session's context. Decide whether the requested context is ready, valid, restricted, unknown, or unavailable.",
		"Do not expose secrets, credentials, private env values, or unrelated transcript details.",
		"If approved, provide a scoped context bundle through agent_context_respond. If not approved, reject/defer/unknown/error with a reason.",
		"",
		formatContractSummary(contract),
		`from=${requesterName}`,
		`requesterMessage=${contract.message}`,
		"",
		`Call agent_context_respond with requestId "${contract.id}" when ready.`,
	].join("\n");
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	if (signal.aborted) throw new Error("Aborted");
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function responseText(contract: ContextContract): string {
	if (contract.state === "released" && contract.release) {
		return `Context request ${contract.id} released by owner.\n\n${contract.release.context}`;
	}
	const reason = contract.decision?.reason ? ` Reason: ${contract.decision.reason}` : "";
	return `Context request ${contract.id} ended with state=${contract.state}.${reason}`;
}

async function notifyIncomingRequests(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
	await updateStatus(ctx, state);
	const self = await registerSession(ctx, state);
	const actor = sessionRef(self);
	const contracts = await readContracts();
	for (const contract of contracts) {
		if (contract.owner.sessionId !== self.sessionId) continue;
		if (!["requested", "queued", "approved"].includes(contract.state)) continue;
		if (state.notifiedRequestIds.has(contract.id)) continue;
		state.notifiedRequestIds.add(contract.id);
		if (contract.state === "requested") {
			await updateContract(contract.id, actor, (current) => ({ ...current, state: "queued" }));
		}
		const latest = (await readContract(contract.id)) ?? contract;
		if (ctx.isIdle()) pi.sendUserMessage(formatOwnerPrompt(latest));
		else pi.sendUserMessage(formatOwnerPrompt(latest), { deliverAs: "followUp" });
	}
}

function installAutocomplete(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.addAutocompleteProvider((current) => ({
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|\s)@agent:([^\s]*)$/);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const partial = match[1] ?? "";
			const sessions = (await readSessions(false)).filter((record) => matchesTarget(record, partial));
			return {
				prefix: `@agent:${partial}`,
				items: sessions.map((record) => {
					const value = record.alias ?? record.name ?? record.sessionId.slice(0, 8);
					return {
						value: `@agent:${value}`,
						label: value,
						description: `${record.cwdName} ${record.sessionId.slice(0, 8)} lastSeen=${record.lastSeenAt}`,
					};
				}),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	}));
}

export default function (pi: ExtensionAPI) {
	const state: RuntimeState = {
		startedAt: nowIso(),
		notifiedRequestIds: new Set<string>(),
	};

	pi.on("session_start", async (_event, ctx) => {
		await registerSession(ctx, state);
		await updateStatus(ctx, state);
		installAutocomplete(ctx);
		state.timer = setInterval(() => {
			void notifyIncomingRequests(pi, ctx, state).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`${EXTENSION_NAME}: ${message}`, "error");
			});
		}, POLL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state.timer) clearInterval(state.timer);
		const id = ctx.sessionManager.getSessionId();
		try {
			await unlink(sessionPath(id));
		} catch {
			// The heartbeat file may already be absent; ignore shutdown cleanup errors.
		}
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nCross-agent context contract: this session can exchange scoped context with other active Pi sessions. Use agent_context_list to discover peers, agent_context_request to ask a target for context, and agent_context_respond to approve/reject/defer incoming AGENT_CONTEXT_REQUEST messages. The owner session controls what context is released and must not share secrets or unrelated transcript details. If the user addresses @agent:<target>, treat it as a request to use agent_context_request and wait when the user is blocked on the result.`,
	}));

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		if (event.text.trim() === "?") {
			pi.sendMessage({
				customType: "agent-system-help",
				content: await formatAgentSystemHelp(ctx, state),
				display: true,
			});
			return { action: "handled" as const };
		}
		const match = event.text.match(/^@agent:([^\s]+)\s+([\s\S]+)$/);
		if (!match) return { action: "continue" as const };
		const target = match[1];
		const message = match[2];
		return {
			action: "transform" as const,
			text: [
				`Request context from @agent:${target} using agent_context_request.`,
				"Treat the target worker as a blocker until the context contract is filled out.",
				"Wait for the owner response unless the request is rejected, deferred, unknown, errors, or times out.",
				`Requester message: ${message}`,
			].join("\n"),
		};
	});

	pi.registerCommand("pi-agent-help", {
		description: "Show Pi agent system help",
		handler: async (_args, ctx) => {
			pi.sendMessage({
				customType: "agent-system-help",
				content: await formatAgentSystemHelp(ctx, state),
				display: true,
			});
		},
	});

	pi.registerCommand("agent-context", {
		description: "Cross-agent context registry: ?, list, register <alias> [role], or prune",
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (command === "?" || command === "help") {
				pi.sendMessage({
					customType: "agent-system-help",
					content: await formatAgentSystemHelp(ctx, state),
					display: true,
				});
				return;
			}

			if (command === "register") {
				const [alias, role] = rest;
				if (!alias) {
					ctx.ui.notify("Usage: /agent-context register <alias> [role]", "warning");
					return;
				}
				state.alias = alias;
				state.role = role;
				const record = await registerSession(ctx, state);
				await updateStatus(ctx, state);
				ctx.ui.notify(`Registered ${formatSession(record)}`, "info");
				return;
			}

			if (command === "prune") {
				const result = await pruneRegistry();
				await updateStatus(ctx, state);
				ctx.ui.notify(
					`Pruned ${result.staleSessions} stale session(s) and ${result.closedRequests} closed request(s).`,
					"info",
				);
				return;
			}

			if (command && command !== "list" && command !== "status") {
				ctx.ui.notify("Usage: /agent-context [?|help|list|status|register <alias> [role]|prune]", "warning");
				return;
			}

			await registerSession(ctx, state);
			await updateStatus(ctx, state);
			const sessions = await readSessions(false);
			const contracts = await readContracts();
			ctx.ui.notify(formatRegistryReport(sessions, contracts), "info");
		},
	});

	pi.registerTool({
		name: "agent_context_register",
		label: "Agent Context Register",
		description: "Register or update this session's alias/role for cross-agent context addressing.",
		promptSnippet: "Register this session with an alias or role for cross-agent context requests.",
		promptGuidelines: [
			"Use agent_context_register when the user names this session or assigns it a role for cross-agent context routing.",
		],
		parameters: Type.Object({
			alias: Type.Optional(Type.String({ description: "Short unique alias for @agent:<alias> addressing." })),
			role: Type.Optional(Type.String({ description: "Role binding, such as supervisor, worker, reviewer." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.alias !== undefined) state.alias = params.alias;
			if (params.role !== undefined) state.role = params.role;
			const record = await registerSession(ctx, state);
			await updateStatus(ctx, state);
			return {
				content: [{ type: "text", text: `Registered ${formatSession(record)}` }],
				details: { session: record },
			};
		},
	});

	pi.registerTool({
		name: "agent_context_list",
		label: "Agent Context List",
		description: "List active sessions and context requests known to the cross-agent context contract registry.",
		promptSnippet: "List active sessions available for cross-agent context requests.",
		promptGuidelines: [
			"Use agent_context_list before agent_context_request when the target session name is ambiguous.",
		],
		parameters: Type.Object({
			includeStale: Type.Optional(Type.Boolean({ description: "Include sessions with stale heartbeats." })),
			includeClosedRequests: Type.Optional(
				Type.Boolean({ description: "Include terminal released/rejected requests." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await registerSession(ctx, state);
			await updateStatus(ctx, state);
			const sessions = await readSessions(params.includeStale ?? false);
			const contracts = (await readContracts()).filter(
				(contract) => params.includeClosedRequests || !isTerminalState(contract.state),
			);
			const text = [
				"Active context sessions:",
				...(sessions.length > 0 ? sessions.map((session) => `- ${formatSession(session)}`) : ["- none"]),
				"",
				"Context requests:",
				...(contracts.length > 0
					? contracts.map((contract) => `- ${formatContractSummary(contract)}`)
					: ["- none"]),
			].join("\n");
			return { content: [{ type: "text", text }], details: { sessions, contracts } };
		},
	});

	pi.registerTool({
		name: "agent_context_request",
		label: "Agent Context Request",
		description:
			"Request scoped context from another active owner session and optionally block until the owner releases or rejects it.",
		promptSnippet: "Request context from another active Pi session by alias, name, role, cwd, or session id.",
		promptGuidelines: [
			"Use agent_context_request when the user asks to contact @agent:<target> or when another worker's status blocks this session.",
			"agent_context_request is a blocking supervisor primitive when waitForRelease is true; wait for the owner decision before proceeding.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Target alias/name/role/cwd/session id, with or without @agent: prefix." }),
			purpose: Type.String({ description: "Why this context is needed." }),
			message: Type.String({ description: "The exact request to present to the owner agent." }),
			requestedScope: Type.Optional(ScopeSchema),
			urgency: Type.Optional(UrgencySchema),
			waitForRelease: Type.Optional(
				Type.Boolean({ description: "Wait until owner releases/rejects/defer/errors. Default true." }),
			),
			timeoutMs: Type.Optional(Type.Number({ description: "Max wait time in milliseconds. Default 600000." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const requester = await registerSession(ctx, state);
			const resolved = await resolveTarget(params.target, requester.sessionId);
			if (resolved.status !== "ok" || !resolved.record) {
				const candidates = resolved.candidates.map(formatSession).join("\n");
				const prefix =
					resolved.status === "none"
						? `No active target matched ${params.target}.`
						: `Ambiguous target ${params.target}.`;
				return {
					content: [
						{ type: "text", text: `${prefix}\n${candidates || "Run agent_context_list to inspect sessions."}` },
					],
					details: { resolved },
				};
			}

			const createdAt = nowIso();
			const contract: ContextContract = {
				schemaVersion: SCHEMA_VERSION,
				id: randomUUID(),
				state: "requested",
				createdAt,
				updatedAt: createdAt,
				requester: sessionRef(requester),
				owner: sessionRef(resolved.record),
				target: params.target,
				purpose: params.purpose,
				requestedScope: params.requestedScope ?? "status",
				urgency: params.urgency ?? "normal",
				message: params.message,
				events: [eventFor("created", sessionRef(requester), params.message)],
			};
			await atomicWriteJson(requestPath(contract.id), contract);
			await updateStatus(ctx, state);

			const shouldWait = params.waitForRelease ?? true;
			if (!shouldWait) {
				return {
					content: [
						{ type: "text", text: `Queued context request ${contract.id} for ${formatSession(resolved.record)}` },
					],
					details: { contract },
				};
			}

			const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
			const deadline = Date.now() + timeoutMs;
			let latest = contract;
			while (Date.now() < deadline) {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Waiting for owner response: ${formatContractSummary(latest)}`,
						},
					],
					details: { contract: latest },
				});
				await sleep(POLL_MS, signal);
				latest = (await readContract(contract.id)) ?? latest;
				if (isTerminalState(latest.state)) {
					return { content: [{ type: "text", text: responseText(latest) }], details: { contract: latest } };
				}
			}

			const expired = await updateContract(contract.id, sessionRef(requester), (current) => ({
				...current,
				state: "expired",
			}));
			return {
				content: [{ type: "text", text: `Timed out waiting for context request ${contract.id}.` }],
				details: { contract: expired },
			};
		},
	});

	pi.registerTool({
		name: "agent_context_respond",
		label: "Agent Context Respond",
		description:
			"Owner-only response tool for approving, releasing, rejecting, deferring, or erroring a context request.",
		promptSnippet: "Approve/release/reject a pending context request owned by this session.",
		promptGuidelines: [
			"Use agent_context_respond to answer AGENT_CONTEXT_REQUEST messages. Only release scoped context that is ready and safe to share.",
			"When approving with context, agent_context_respond closes the blocker by setting the request state to released.",
		],
		parameters: Type.Object({
			requestId: Type.String({ description: "Context request id from AGENT_CONTEXT_REQUEST." }),
			decision: DecisionSchema,
			reason: Type.Optional(Type.String({ description: "Reason for the decision." })),
			context: Type.Optional(
				Type.String({ description: "Scoped context bundle to release when decision is approved." }),
			),
			approvedScope: Type.Optional(Type.Array(ScopeSchema, { description: "Scopes actually approved." })),
			restrictions: Type.Optional(
				Type.Array(Type.String(), { description: "Restrictions applied to this context." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const owner = await registerSession(ctx, state);
			const actor = sessionRef(owner);
			const current = await readContract(params.requestId);
			if (!current) {
				return { content: [{ type: "text", text: `Unknown context request ${params.requestId}` }], details: {} };
			}
			if (current.owner.sessionId !== owner.sessionId) {
				return {
					content: [
						{
							type: "text",
							text: `Refusing response: request ${params.requestId} is owned by ${current.owner.sessionId}, not this session ${owner.sessionId}.`,
						},
					],
					details: { contract: current },
				};
			}

			const next = await updateContract(params.requestId, actor, (contract) => {
				const decision = {
					value: params.decision,
					...(params.reason ? { reason: params.reason } : {}),
					...(params.approvedScope ? { approvedScope: params.approvedScope } : {}),
					...(params.restrictions ? { restrictions: params.restrictions } : {}),
					decidedAt: nowIso(),
				};
				if (params.decision === "approved" && params.context) {
					return {
						...contract,
						state: "released",
						decision,
						release: { context: params.context, createdAt: nowIso(), producedBy: actor },
					};
				}
				return {
					...contract,
					state: params.decision === "approved" ? "approved" : params.decision,
					decision,
				};
			});

			await updateStatus(ctx, state);
			const text =
				next.state === "approved"
					? `Approved request ${params.requestId}; call agent_context_respond again with decision=approved and context to release the bundle.`
					: responseText(next);
			return { content: [{ type: "text", text }], details: { contract: next } };
		},
	});

	pi.registerTool({
		name: "agent_context_status",
		label: "Agent Context Status",
		description: "Inspect a context request contract by id.",
		promptSnippet: "Inspect the state and event trail for a cross-agent context request.",
		parameters: Type.Object({ requestId: Type.String({ description: "Context request id." }) }),
		async execute(_toolCallId, params) {
			const contract = await readContract(params.requestId);
			if (!contract) {
				return {
					content: [{ type: "text", text: `Unknown context request ${params.requestId}` }],
					details: { contract: undefined as ContextContract | undefined },
				};
			}
			return { content: [{ type: "text", text: responseText(contract) }], details: { contract } };
		},
	});
}
