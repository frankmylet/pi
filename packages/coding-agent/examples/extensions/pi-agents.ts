/**
 * Pi Agents extension
 *
 * Adds Pi-native background dispatch and a minimal Agent View for jobs started
 * through this extension. This is the Pi-owned counterpart to claude-dispatch:
 * workers run as `pi --mode json` subprocesses, write state to
 * `~/.pi/agent/jobs/<id>/state.json`, and can target ChatGPT/Codex models such
 * as `openai-codex/gpt-5.5` without consuming Claude Code quota.
 *
 * Usage:
 *   /pi-dispatch fix the failing checkout test
 *   /pi-dispatch --provider=openai-codex --model=gpt-5.5 --thinking=high add tests
 *   /pi-dispatch --cwd ../other-repo --name auth-scout --tools=read,grep,find,ls inspect auth flows
 *   /pi-dispatch --isolation=worktree implement the small docs patch
 *   /pi-dispatch --dry-run ./dispatch-proposal.md
 *   /pi-agents
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { parseDocument } from "yaml";

type JobStateName = "queued" | "running" | "blocked" | "done" | "failed" | "stopped";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type IsolationMode = "none" | "worktree";

type AgentViewMode = "agents" | "workflows";

type AgentViewScreen =
	| { kind: "agents"; selected: number }
	| {
			kind: "agentDetail";
			jobId: string;
			parent: AgentViewMode;
			parentWorkflowKey?: string;
			parentWorkflowSelected?: number;
	  }
	| { kind: "workflows"; selected: number }
	| { kind: "workflowDetail"; workflowKey: string; selected: number };

type AgentViewAction =
	| { kind: "close" }
	| { kind: "switch"; jobId: string }
	| { kind: "prompt"; jobId: string; mode: "prompt" | "steer" | "follow_up" }
	| { kind: "abort"; jobId: string }
	| { kind: "stop"; jobId: string }
	| { kind: "refresh" };

interface WorkflowGroup {
	key: string;
	label: string;
	jobs: PiJobState[];
	updatedAt: string;
	sourcePath?: string;
	targetProject?: string;
}

interface ParsedArgs {
	dryRun: boolean;
	noConfirm: boolean;
	follow: boolean;
	cwd?: string;
	name?: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	tools?: string[];
	isolation: IsolationMode;
	piBin: string;
	extensions: string[];
	agentBus: boolean;
	agentBusUrl?: string;
	agentBusProject?: string;
	prompt: string;
}

interface DispatchWorker {
	name?: string;
	cwd: string;
	seedPrompt: string;
	tags: string[];
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	tools?: string[];
	isolation: IsolationMode;
	extensions: string[];
	agentBus: boolean;
	agentBusUrl?: string;
	agentBusProject?: string;
	piBin: string;
	targetProject?: string;
}

interface DispatchPlan {
	source: "prompt" | "proposal";
	sourcePath?: string;
	targetProject?: string;
	workers: DispatchWorker[];
}

interface PiJobState {
	schemaVersion: 1;
	id: string;
	shortId: string;
	source: "pi-dispatch";
	state: JobStateName;
	name: string;
	prompt: string;
	cwd: string;
	originCwd: string;
	originSessionFile?: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	tools?: string[];
	isolation: IsolationMode;
	worktreePath?: string;
	worktreeBranch?: string;
	runnerPid?: number;
	workerPid?: number;
	sessionId?: string;
	sessionFile?: string;
	summary?: string;
	lastText?: string;
	error?: string;
	exitCode?: number;
	costUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	tags: string[];
	targetProject?: string;
	workflowRunId?: string;
	workflowName?: string;
	workflowSource?: "prompt" | "proposal";
	workflowSourcePath?: string;
	jobDir: string;
	eventsPath: string;
	stderrPath: string;
	controlPath?: string;
}

interface RunnerConfig {
	jobId: string;
	statePath: string;
	eventsPath: string;
	stderrPath: string;
	controlPath: string;
	piBin: string;
	cwd: string;
	prompt: string;
	name: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	tools?: string[];
	extensions: string[];
	agentBus: boolean;
	agentBusUrl?: string;
	agentBusProject?: string;
	agentBusHost: string;
}

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_THINKING: ThinkingLevel = "high";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const AGENT_BUS_EXTENSION = resolve(dirname(new URL(import.meta.url).pathname), "agent-bus-mirror.ts");

export default function piAgentsExtension(pi: ExtensionAPI) {
	pi.registerCommand("pi-dispatch", {
		description: "Spawn Pi background worker(s), defaulting to openai-codex/gpt-5.5",
		getArgumentCompletions: (prefix) => {
			const flags = [
				"--dry-run",
				"--no-confirm",
				"--follow",
				"--cwd=",
				"--name=",
				"--provider=openai-codex",
				"--model=gpt-5.5",
				"--thinking=high",
				"--tools=read,bash,edit,write",
				"--isolation=worktree",
				"--no-agent-bus",
				"--agent-bus-url=",
			];
			const filtered = flags.filter((flag) => flag.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((flag) => ({ value: flag, label: flag })) : null;
		},
		handler: async (args, ctx) => {
			await handlePiDispatch(pi, args, ctx);
		},
	});

	pi.registerCommand("dispatch-pi", {
		description: "Alias for /pi-dispatch",
		handler: async (args, ctx) => {
			await handlePiDispatch(pi, args, ctx);
		},
	});

	pi.registerCommand("pi-agents", {
		description: "Open Pi Agent View for /pi-dispatch jobs",
		handler: async (_args, ctx) => {
			await openAgentView(ctx, "agents");
		},
	});

	pi.registerCommand("agents", {
		description: "Open Pi Agent View for /pi-dispatch jobs",
		handler: async (_args, ctx) => {
			await openAgentView(ctx, "agents");
		},
	});

	pi.registerCommand("pi-workflows", {
		description: "Open Pi Workflows View for proposal/fleet runs",
		handler: async (_args, ctx) => {
			await openAgentView(ctx, "workflows");
		},
	});

	pi.registerCommand("pi-workflow", {
		description: "Run a Pi workflow proposal with the /pi-dispatch engine",
		handler: async (args, ctx) => {
			await handlePiDispatch(pi, args, ctx);
		},
	});
}

async function handlePiDispatch(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(args);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	if (!parsed.prompt) {
		ctx.ui.notify("Usage: /pi-dispatch [--model gpt-5.5] [--thinking high] <prompt-or-plan.md>", "error");
		return;
	}

	let plan: DispatchPlan;
	try {
		plan = await buildDispatchPlan(parsed, ctx.cwd);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	const preview = formatPlanSummary(plan, parsed.dryRun);
	if (parsed.dryRun) {
		pi.sendMessage({
			customType: "pi-dispatch",
			content: preview,
			display: true,
			details: { dryRun: true, plan },
		});
		ctx.ui.notify(`Dry run: ${plan.workers.length} Pi worker(s)`, "info");
		return;
	}

	if (!parsed.noConfirm) {
		if (!ctx.hasUI) {
			ctx.ui.notify("/pi-dispatch requires --no-confirm when UI is unavailable", "error");
			return;
		}
		const confirmed = await ctx.ui.confirm("Dispatch Pi background worker(s)?", preview);
		if (!confirmed) {
			ctx.ui.notify("Pi dispatch cancelled", "info");
			return;
		}
	}

	const started: PiJobState[] = [];
	const workflowRunId = randomUUID();
	const workflowName = workflowNameForPlan(plan);
	for (const worker of plan.workers) {
		try {
			await access(worker.cwd);
			const state = await spawnPiWorker(
				pi,
				worker,
				plan,
				ctx.cwd,
				ctx.sessionManager.getSessionFile(),
				workflowRunId,
				workflowName,
			);
			started.push(state);
		} catch (error) {
			ctx.ui.notify(
				`Pi dispatch failed for ${worker.name ?? worker.cwd}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			break;
		}
	}

	const report = formatDispatchReport(started, plan.workers.length);
	pi.appendEntry("pi-dispatch", {
		createdAt: new Date().toISOString(),
		plan,
		jobs: started.map((job) => ({ id: job.id, shortId: job.shortId, state: job.state, cwd: job.cwd })),
	});
	pi.sendMessage({ customType: "pi-dispatch", content: report, display: true, details: { plan, jobs: started } });
	ctx.ui.notify(`Dispatched ${started.length}/${plan.workers.length} Pi worker(s)`, "info");

	if (parsed.follow && started.length > 0) {
		await openAgentView(ctx);
	}
}

async function buildDispatchPlan(args: ParsedArgs, commandCwd: string): Promise<DispatchPlan> {
	const maybePath = stripAtPrefix(args.prompt.trim());
	const proposalPath = resolve(commandCwd, maybePath);
	if (await isReadableFile(proposalPath)) {
		return parseProposalFile(proposalPath, args, commandCwd);
	}

	const cwd = resolve(commandCwd, args.cwd ?? ".");
	return {
		source: "prompt",
		workers: [
			{
				name: args.name ?? slugify(args.prompt).slice(0, 48),
				cwd,
				seedPrompt: args.prompt,
				tags: [],
				provider: args.provider,
				model: args.model,
				thinking: args.thinking,
				tools: args.tools,
				isolation: args.isolation,
				extensions: args.extensions,
				agentBus: args.agentBus,
				agentBusUrl: args.agentBusUrl,
				agentBusProject: args.agentBusProject,
				piBin: args.piBin,
			},
		],
	};
}

async function parseProposalFile(path: string, args: ParsedArgs, commandCwd: string): Promise<DispatchPlan> {
	const content = await readFile(path, "utf8");
	const frontmatter = extractFrontmatter(content);
	if (!frontmatter) throw new Error(`No YAML frontmatter found in ${path}`);

	const parsed = parseDocument(frontmatter).toJS() as unknown;
	const root = asRecord(parsed);
	const proposal = asRecord(root?.dispatch_proposal);
	if (!proposal) throw new Error(`No dispatch_proposal object found in ${path}`);

	const workersValue = proposal.workers;
	if (!Array.isArray(workersValue)) throw new Error(`dispatch_proposal.workers must be an array in ${path}`);

	const targetProject = optionalString(proposal.target_project);
	const proposalDir = dirname(path);
	const workers = workersValue.map((workerValue, index) => {
		const worker = asRecord(workerValue);
		if (!worker) throw new Error(`dispatch_proposal.workers[${index}] must be an object`);

		const seedPrompt = optionalString(worker.seed_prompt) ?? optionalString(worker.prompt);
		if (!seedPrompt) throw new Error(`dispatch_proposal.workers[${index}].seed_prompt is required`);

		const workerCwd = optionalString(worker.cwd) ?? args.cwd ?? commandCwd;
		const thinking = parseThinking(optionalString(worker.thinking)) ?? args.thinking;
		const isolation = parseIsolation(optionalString(worker.isolation)) ?? args.isolation;
		const tools = stringArray(worker.tools).length > 0 ? stringArray(worker.tools) : args.tools;
		const extensions = [...args.extensions, ...stringArray(worker.extensions), ...stringArray(worker.extension)].map(
			(ext) => resolveMaybeRelative(proposalDir, ext),
		);
		return {
			name: optionalString(worker.name) ?? args.name ?? slugify(seedPrompt).slice(0, 48),
			cwd: resolveMaybeRelative(proposalDir, workerCwd),
			seedPrompt,
			tags: stringArray(worker.tags),
			provider: optionalString(worker.provider) ?? args.provider,
			model: optionalString(worker.model) ?? args.model,
			thinking,
			tools,
			isolation,
			extensions,
			agentBus: optionalBoolean(worker.agent_bus) ?? args.agentBus,
			agentBusUrl: optionalString(worker.agent_bus_url) ?? args.agentBusUrl,
			agentBusProject: optionalString(worker.agent_bus_project) ?? args.agentBusProject ?? targetProject,
			piBin: optionalString(worker.pi_bin) ?? args.piBin,
			targetProject,
		} satisfies DispatchWorker;
	});

	return { source: "proposal", sourcePath: path, targetProject, workers };
}

async function spawnPiWorker(
	pi: ExtensionAPI,
	worker: DispatchWorker,
	plan: DispatchPlan,
	originCwd: string,
	originSessionFile: string | undefined,
	workflowRunId: string,
	workflowName: string,
): Promise<PiJobState> {
	const jobId = randomUUID();
	const shortId = jobId.slice(0, 8);
	const jobDir = join(getJobsRoot(), shortId);
	await mkdir(jobDir, { recursive: true });

	let cwd = worker.cwd;
	let worktreePath: string | undefined;
	let worktreeBranch: string | undefined;
	if (worker.isolation === "worktree") {
		const worktree = await createWorktree(pi, worker.cwd, worker.name ?? shortId, shortId);
		cwd = worktree.path;
		worktreePath = worktree.path;
		worktreeBranch = worktree.branch;
	}

	const now = new Date().toISOString();
	const statePath = join(jobDir, "state.json");
	const eventsPath = join(jobDir, "events.jsonl");
	const stderrPath = join(jobDir, "stderr.log");
	const controlPath = join(jobDir, "control.jsonl");
	const runnerPath = join(jobDir, "runner.mjs");
	const configPath = join(jobDir, "config.json");
	const name = worker.name ?? `pi-${shortId}`;
	const seedPrompt = buildSeedPrompt(worker, plan, originCwd, originSessionFile);
	const extensions = resolveExtensions(worker);

	const initialState: PiJobState = {
		schemaVersion: 1,
		id: jobId,
		shortId,
		source: "pi-dispatch",
		state: "queued",
		name,
		prompt: worker.seedPrompt,
		cwd,
		originCwd,
		originSessionFile,
		provider: worker.provider,
		model: worker.model,
		thinking: worker.thinking,
		tools: worker.tools,
		isolation: worker.isolation,
		worktreePath,
		worktreeBranch,
		summary: "queued",
		createdAt: now,
		updatedAt: now,
		tags: worker.tags,
		targetProject: worker.targetProject,
		workflowRunId,
		workflowName,
		workflowSource: plan.source,
		workflowSourcePath: plan.sourcePath,
		jobDir,
		eventsPath,
		stderrPath,
		controlPath,
	};
	await writeJson(statePath, initialState);
	await writeFile(runnerPath, runnerSource(), "utf8");

	const config: RunnerConfig = {
		jobId,
		statePath,
		eventsPath,
		stderrPath,
		controlPath,
		piBin: worker.piBin,
		cwd,
		prompt: seedPrompt,
		name,
		provider: worker.provider,
		model: worker.model,
		thinking: worker.thinking,
		tools: worker.tools,
		extensions,
		agentBus: worker.agentBus,
		agentBusUrl: worker.agentBusUrl,
		agentBusProject: worker.agentBusProject ?? plan.targetProject ?? basename(worker.cwd),
		agentBusHost: hostname(),
	};
	await writeJson(configPath, config);

	const child = spawn(process.execPath, [runnerPath, configPath], {
		cwd,
		detached: true,
		stdio: "ignore",
		env: { ...process.env },
	});
	child.unref();

	const nextState = { ...initialState, state: "running" as const, runnerPid: child.pid, summary: "starting pi" };
	await writeJson(statePath, nextState);
	return nextState;
}

async function createWorktree(
	pi: ExtensionAPI,
	cwd: string,
	name: string,
	shortId: string,
): Promise<{ path: string; branch: string }> {
	const rootResult = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
	if (rootResult.code !== 0) throw new Error(`Cannot create worktree outside a git repo: ${rootResult.stderr.trim()}`);
	const root = rootResult.stdout.trim();
	const slug = `${slugify(name).slice(0, 40)}-${shortId}`;
	const path = join(root, ".claude", "worktrees", slug);
	const branch = `pi/${slug}`;
	const result = await pi.exec("git", ["-C", root, "worktree", "add", "-b", branch, path, "HEAD"], {
		timeout: 60_000,
	});
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`git worktree add failed: ${detail}`);
	}
	return { path, branch };
}

function resolveExtensions(worker: DispatchWorker): string[] {
	const extensions = [...worker.extensions];
	if (worker.agentBus) extensions.push(AGENT_BUS_EXTENSION);
	return Array.from(new Set(extensions.map((ext) => resolveMaybeRelative(worker.cwd, ext))));
}

async function openAgentView(ctx: ExtensionCommandContext, initialMode: AgentViewMode = "agents"): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/pi-agents requires interactive UI", "error");
		return;
	}

	let jobs = await readJobStates();
	let workflows = groupWorkflows(jobs);
	const action = await ctx.ui.custom<AgentViewAction | null>((tui, theme, _keybindings, done) => {
		let screen: AgentViewScreen =
			initialMode === "workflows" ? { kind: "workflows", selected: 0 } : { kind: "agents", selected: 0 };
		let loading = false;

		const refresh = async () => {
			loading = true;
			tui.requestRender();
			jobs = await readJobStates();
			workflows = groupWorkflows(jobs);
			clampScreenSelection();
			loading = false;
			tui.requestRender();
		};

		const clampScreenSelection = () => {
			if (screen.kind === "agents") screen.selected = clampIndex(screen.selected, jobs.length);
			if (screen.kind === "workflows") screen.selected = clampIndex(screen.selected, workflows.length);
			if (screen.kind === "workflowDetail") {
				const wfKey = screen.workflowKey;
				const workflow = workflows.find((item) => item.key === wfKey);
				screen.selected = clampIndex(screen.selected, workflow?.jobs.length ?? 0);
			}
		};

		const selectedJob = (): PiJobState | undefined => {
			if (screen.kind === "agents") return jobs[screen.selected];
			if (screen.kind === "agentDetail") {
				const jid = screen.jobId;
				return jobs.find((job) => job.id === jid);
			}
			if (screen.kind === "workflowDetail") {
				const wfKey = screen.workflowKey;
				const workflow = workflows.find((item) => item.key === wfKey);
				return workflow?.jobs[screen.selected];
			}
			return undefined;
		};

		const goBack = (): boolean => {
			if (screen.kind === "agentDetail") {
				if (screen.parentWorkflowKey) {
					screen = {
						kind: "workflowDetail",
						workflowKey: screen.parentWorkflowKey,
						selected: screen.parentWorkflowSelected ?? 0,
					};
				} else {
					screen =
						screen.parent === "workflows" ? { kind: "workflows", selected: 0 } : { kind: "agents", selected: 0 };
				}
				clampScreenSelection();
				return true;
			}
			if (screen.kind === "workflowDetail") {
				const wfKey = screen.workflowKey;
				screen = { kind: "workflows", selected: workflows.findIndex((item) => item.key === wfKey) };
				clampScreenSelection();
				return true;
			}
			return false;
		};

		return {
			render(width: number): string[] {
				currentRenderJobs = jobs;
				currentRenderWorkflows = workflows;
				const lines: string[] = [];
				const counts = summarizeJobs(jobs);
				const tab = screen.kind === "workflows" || screen.kind === "workflowDetail" ? "workflows" : "agents";
				lines.push(
					fitLine(
						`${theme.bold(tab === "agents" ? "Pi Agents" : "Pi Workflows")}  ${counts.total} jobs  ${counts.running} running  ${counts.blocked} blocked  ${counts.done} done  ${workflows.length} workflows`,
						width,
					),
				);
				lines.push(
					fitLine(
						theme.fg(
							"dim",
							"tab switch  ↑↓ select  enter drill  ← back  p prompt  t steer  f follow-up  a abort  o open  s stop  r refresh  q close",
						),
						width,
					),
				);
				if (loading) lines.push(fitLine(theme.fg("warning", "refreshing..."), width));
				if (screen.kind === "agents") return renderAgentList(lines, width, screen.selected, theme);
				if (screen.kind === "agentDetail") return renderAgentDetail(lines, width, screen.jobId, theme);
				if (screen.kind === "workflows") return renderWorkflowList(lines, width, screen.selected, theme);
				return renderWorkflowDetail(lines, width, screen.workflowKey, screen.selected, theme);
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.tab)) {
					screen =
						screen.kind === "workflows" || screen.kind === "workflowDetail"
							? { kind: "agents", selected: 0 }
							: { kind: "workflows", selected: 0 };
					clampScreenSelection();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) {
					if (goBack()) tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.up)) {
					if (screen.kind === "agents" || screen.kind === "workflows" || screen.kind === "workflowDetail")
						screen.selected = Math.max(0, screen.selected - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (screen.kind === "agents")
						screen.selected = Math.min(Math.max(0, jobs.length - 1), screen.selected + 1);
					if (screen.kind === "workflows")
						screen.selected = Math.min(Math.max(0, workflows.length - 1), screen.selected + 1);
					if (screen.kind === "workflowDetail") {
						const wfKey = screen.workflowKey;
						const workflow = workflows.find((item) => item.key === wfKey);
						screen.selected = Math.min(Math.max(0, (workflow?.jobs.length ?? 0) - 1), screen.selected + 1);
					}
					tui.requestRender();
					return;
				}
				if (data === "r") {
					void refresh();
					return;
				}
				if (data === "s") {
					const job = selectedJob();
					if (job) done({ kind: "stop", jobId: job.id });
					return;
				}
				if (data === "a") {
					const job = selectedJob();
					if (job) done({ kind: "abort", jobId: job.id });
					return;
				}
				if (data === "p" || data === "t" || data === "f") {
					const job = selectedJob();
					if (job)
						done({
							kind: "prompt",
							jobId: job.id,
							mode: data === "t" ? "steer" : data === "f" ? "follow_up" : "prompt",
						});
					return;
				}
				if (data === "o") {
					const job = selectedJob();
					if (job) done({ kind: "switch", jobId: job.id });
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (screen.kind === "agents") {
						const job = jobs[screen.selected];
						if (job) screen = { kind: "agentDetail", jobId: job.id, parent: "agents" };
					} else if (screen.kind === "workflows") {
						const workflow = workflows[screen.selected];
						if (workflow) screen = { kind: "workflowDetail", workflowKey: workflow.key, selected: 0 };
					} else if (screen.kind === "workflowDetail") {
						const job = selectedJob();
						if (job) {
							screen = {
								kind: "agentDetail",
								jobId: job.id,
								parent: "workflows",
								parentWorkflowKey: screen.workflowKey,
								parentWorkflowSelected: screen.selected,
							};
						}
					}
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					if (goBack()) {
						tui.requestRender();
						return;
					}
					done({ kind: "close" });
					return;
				}
				if (matchesKey(data, Key.ctrl("c")) || data === "q") done({ kind: "close" });
			},
		};
	});

	if (!action || action.kind === "close" || action.kind === "refresh") return;
	const job = (await readJobStates()).find((item) => item.id === action.jobId);
	if (!job) {
		ctx.ui.notify("Job disappeared", "warning");
		return;
	}
	if (action.kind === "stop") {
		await stopJob(job);
		ctx.ui.notify(`Stop requested for ${job.shortId}`, "info");
		return;
	}
	if (action.kind === "abort") {
		await sendJobControl(job, { type: "abort" });
		ctx.ui.notify(`Abort queued for ${job.shortId}`, "info");
		return;
	}
	if (action.kind === "prompt") {
		const label = action.mode === "steer" ? "Steer" : action.mode === "follow_up" ? "Follow-up" : "Prompt";
		const message = await ctx.ui.input(`${label} ${job.shortId}:`, "message");
		if (!message) return;
		await sendJobControl(job, { type: action.mode, message });
		ctx.ui.notify(`${label} queued for ${job.shortId}`, "info");
		return;
	}
	if (action.kind === "switch") {
		if (!job.sessionFile) {
			ctx.ui.notify(`Job ${job.shortId} has no session file yet`, "warning");
			return;
		}
		const result = await ctx.switchSession(job.sessionFile);
		if (result.cancelled) ctx.ui.notify("Session switch cancelled", "warning");
	}
}

function renderAgentList(
	lines: string[],
	width: number,
	selected: number,
	theme: { fg(color: string, text: string): string; bg(color: string, text: string): string },
): string[] {
	if (jobsEmptyForRender(lines, width, "No Pi jobs yet. Run /pi-dispatch <task> to start one.", theme)) return lines;
	for (const group of groupJobs(currentRenderJobs)) {
		lines.push("");
		lines.push(fitLine(theme.fg("muted", group.label), width));
		for (const item of group.jobs) {
			const index = currentRenderJobs.indexOf(item);
			lines.push(formatJobRow(item, width, index === selected, theme));
		}
	}
	return lines;
}

let currentRenderJobs: PiJobState[] = [];
let currentRenderWorkflows: WorkflowGroup[] = [];

function jobsEmptyForRender(
	lines: string[],
	width: number,
	message: string,
	theme: { fg(color: string, text: string): string },
): boolean {
	if (currentRenderJobs.length > 0) return false;
	lines.push("");
	lines.push(fitLine(theme.fg("muted", message), width));
	return true;
}

function renderAgentDetail(
	lines: string[],
	width: number,
	jobId: string,
	theme: { fg(color: string, text: string): string; bold(text: string): string },
): string[] {
	const job = currentRenderJobs.find((item) => item.id === jobId);
	if (!job) {
		lines.push("");
		lines.push(fitLine(theme.fg("warning", "Job no longer exists. Press ← to go back."), width));
		return lines;
	}
	lines.push("");
	lines.push(
		fitLine(
			theme.fg("dim", "Agent detail — press ←/esc to return, o to open/switch to the persisted Pi session."),
			width,
		),
	);
	for (const line of formatJobDetails(job, width, theme)) lines.push(line);
	return lines;
}

function renderWorkflowList(
	lines: string[],
	width: number,
	selected: number,
	theme: {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
		bold(text: string): string;
	},
): string[] {
	if (currentRenderWorkflows.length === 0) {
		lines.push("");
		lines.push(
			fitLine(
				theme.fg("muted", "No Pi workflow runs yet. Run /pi-workflow <proposal.md> or /pi-dispatch <proposal.md>."),
				width,
			),
		);
		return lines;
	}
	lines.push("");
	lines.push(fitLine(theme.fg("muted", "Workflow runs"), width));
	for (const workflow of currentRenderWorkflows) {
		const index = currentRenderWorkflows.indexOf(workflow);
		lines.push(formatWorkflowRow(workflow, width, index === selected, theme));
	}
	return lines;
}

function renderWorkflowDetail(
	lines: string[],
	width: number,
	workflowKey: string,
	selected: number,
	theme: {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
		bold(text: string): string;
	},
): string[] {
	const workflow = currentRenderWorkflows.find((item) => item.key === workflowKey);
	if (!workflow) {
		lines.push("");
		lines.push(fitLine(theme.fg("warning", "Workflow run no longer exists. Press ← to go back."), width));
		return lines;
	}
	lines.push("");
	lines.push(fitLine(theme.fg("accent", theme.bold(workflow.label)), width));
	lines.push(
		fitLine(
			theme.fg(
				"dim",
				`updated ${relativeTime(workflow.updatedAt)} | source ${workflow.sourcePath ?? "inline/ad-hoc"} | target ${workflow.targetProject ?? "none"}`,
			),
			width,
		),
	);
	lines.push(
		fitLine(
			theme.fg("dim", "enter drills into selected agent; o opens its persisted Pi session; s stops it."),
			width,
		),
	);
	for (const job of workflow.jobs) {
		const index = workflow.jobs.indexOf(job);
		lines.push(formatJobRow(job, width, index === selected, theme));
	}
	return lines;
}

async function sendJobControl(job: PiJobState, command: Record<string, unknown>): Promise<void> {
	const controlPath = job.controlPath ?? join(job.jobDir, "control.jsonl");
	await writeFile(controlPath, `${JSON.stringify({ ...command, id: randomUUID() })}\n`, { flag: "a" });
}

async function stopJob(job: PiJobState): Promise<void> {
	const pids = [job.workerPid, job.runnerPid].filter((pid): pid is number => typeof pid === "number" && pid > 0);
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
	await writeJson(join(job.jobDir, "state.json"), {
		...job,
		state: "stopped",
		summary: "stop requested",
		updatedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
	});
}

async function readJobStates(): Promise<PiJobState[]> {
	const root = getJobsRoot();
	try {
		await mkdir(root, { recursive: true });
		const entries = await readdir(root, { withFileTypes: true });
		const jobs: PiJobState[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const state = await readJobState(join(root, entry.name, "state.json"));
			if (state) jobs.push(state);
		}
		return jobs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	} catch {
		return [];
	}
}

async function readJobState(path: string): Promise<PiJobState | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		const record = asRecord(parsed);
		if (!record || record.schemaVersion !== 1 || typeof record.id !== "string") return undefined;
		return parsed as PiJobState;
	} catch {
		return undefined;
	}
}

function summarizeJobs(jobs: PiJobState[]): { total: number; running: number; blocked: number; done: number } {
	return {
		total: jobs.length,
		running: jobs.filter((job) => job.state === "running" || job.state === "queued").length,
		blocked: jobs.filter((job) => job.state === "blocked").length,
		done: jobs.filter((job) => job.state === "done").length,
	};
}

function groupJobs(jobs: PiJobState[]): Array<{ label: string; jobs: PiJobState[] }> {
	const groups = [
		{ label: "Needs input", states: new Set<JobStateName>(["blocked"]) },
		{ label: "Working", states: new Set<JobStateName>(["queued", "running"]) },
		{ label: "Completed", states: new Set<JobStateName>(["done", "failed", "stopped"]) },
	];
	return groups
		.map((group) => ({ label: group.label, jobs: jobs.filter((job) => group.states.has(job.state)) }))
		.filter((group) => group.jobs.length > 0);
}

function groupWorkflows(jobs: PiJobState[]): WorkflowGroup[] {
	const byKey = new Map<string, WorkflowGroup>();
	for (const job of jobs) {
		const key = workflowKeyForJob(job);
		const existing = byKey.get(key);
		if (existing) {
			existing.jobs.push(job);
			if (new Date(job.updatedAt).getTime() > new Date(existing.updatedAt).getTime())
				existing.updatedAt = job.updatedAt;
			continue;
		}
		byKey.set(key, {
			key,
			label: workflowLabelForJob(job),
			jobs: [job],
			updatedAt: job.updatedAt,
			sourcePath: job.workflowSourcePath,
			targetProject: job.targetProject,
		});
	}
	return Array.from(byKey.values())
		.map((workflow) => ({
			...workflow,
			jobs: workflow.jobs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
		}))
		.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function workflowKeyForJob(job: PiJobState): string {
	if (job.workflowRunId) return `run:${job.workflowRunId}`;
	if (job.workflowSourcePath) return `source:${job.workflowSourcePath}`;
	return `job:${job.id}`;
}

function workflowLabelForJob(job: PiJobState): string {
	if (job.workflowName) return job.workflowName;
	if (job.workflowSourcePath) return basename(job.workflowSourcePath).replace(/\.[^.]+$/, "");
	return `Ad-hoc: ${job.name}`;
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

function formatJobRow(
	job: PiJobState,
	width: number,
	selected: boolean,
	theme: { fg(color: string, text: string): string; bg(color: string, text: string): string },
): string {
	const glyph = stateGlyph(job.state);
	const age = relativeTime(job.updatedAt);
	const model = `${job.provider}/${job.model}`;
	const summary = job.summary ?? job.prompt;
	const prefix = selected ? theme.fg("accent", "> ") : "  ";
	const state = styleState(job.state, glyph, theme);
	const fixed = `${prefix}${state} ${job.shortId} `;
	const tail = ` ${theme.fg("dim", model)} ${theme.fg("muted", age)}`;
	const nameAndSummary = `${job.name} ${theme.fg("muted", "—")} ${summary}`;
	const available = Math.max(10, width - visibleWidth(fixed) - visibleWidth(tail));
	const line = fixed + truncateToWidth(nameAndSummary, available) + tail;
	return selected ? theme.bg("selectedBg", fitLine(line, width)) : fitLine(line, width);
}

function formatWorkflowRow(
	workflow: WorkflowGroup,
	width: number,
	selected: boolean,
	theme: { fg(color: string, text: string): string; bg(color: string, text: string): string },
): string {
	const counts = summarizeJobs(workflow.jobs);
	const glyph =
		counts.running > 0
			? "●"
			: counts.blocked > 0
				? "?"
				: workflow.jobs.some((job) => job.state === "failed")
					? "×"
					: "✓";
	const prefix = selected ? theme.fg("accent", "> ") : "  ";
	const fixed = `${prefix}${theme.fg(counts.running > 0 ? "accent" : counts.blocked > 0 ? "warning" : "success", glyph)} `;
	const tail = ` ${theme.fg("dim", `${workflow.jobs.length} jobs`)} ${theme.fg("muted", relativeTime(workflow.updatedAt))}`;
	const parts = [
		workflow.label,
		workflow.targetProject ? `target=${workflow.targetProject}` : undefined,
		workflow.sourcePath ? basename(workflow.sourcePath) : undefined,
	].filter(Boolean);
	const available = Math.max(10, width - visibleWidth(fixed) - visibleWidth(tail));
	const line = fixed + truncateToWidth(parts.join(" — "), available) + tail;
	return selected ? theme.bg("selectedBg", fitLine(line, width)) : fitLine(line, width);
}

function formatJobDetails(
	job: PiJobState,
	width: number,
	theme: { fg(color: string, text: string): string; bold(text: string): string },
): string[] {
	const lines = [
		theme.fg("accent", theme.bold(`peek: ${job.shortId} ${job.name}`)),
		`state: ${job.state}`,
		`cwd: ${job.cwd}`,
		...(job.worktreePath ? [`worktree: ${job.worktreePath}`, `branch: ${job.worktreeBranch ?? "unknown"}`] : []),
		`model: ${job.provider}/${job.model}:${job.thinking}`,
		`workflow: ${job.workflowName ?? "ad-hoc"}${job.workflowSourcePath ? ` (${job.workflowSourcePath})` : ""}`,
		`session: ${job.sessionFile ?? job.sessionId ?? "pending"}`,
		`pids: runner=${job.runnerPid ?? "-"} worker=${job.workerPid ?? "-"}`,
		...(job.costUsd !== undefined ? [`cost: $${job.costUsd.toFixed(4)}`] : []),
		...(job.error ? [`error: ${job.error}`] : []),
		`events: ${job.eventsPath}`,
		`control: ${job.controlPath ?? join(job.jobDir, "control.jsonl")}`,
		`stderr: ${job.stderrPath}`,
		"",
		job.lastText ?? job.summary ?? job.prompt,
	];
	return lines.map((line) => fitLine(theme.fg("dim", line), width));
}

function styleState(state: JobStateName, glyph: string, theme: { fg(color: string, text: string): string }): string {
	if (state === "done") return theme.fg("success", glyph);
	if (state === "failed") return theme.fg("error", glyph);
	if (state === "blocked") return theme.fg("warning", glyph);
	if (state === "running" || state === "queued") return theme.fg("accent", glyph);
	return theme.fg("muted", glyph);
}

function stateGlyph(state: JobStateName): string {
	if (state === "queued") return "·";
	if (state === "running") return "●";
	if (state === "blocked") return "?";
	if (state === "done") return "✓";
	if (state === "failed") return "×";
	return "■";
}

function relativeTime(date: string): string {
	const ms = Date.now() - new Date(date).getTime();
	if (ms < 60_000) return "now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
	return `${Math.floor(ms / 86_400_000)}d`;
}

function fitLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width));
}

function workflowNameForPlan(plan: DispatchPlan): string {
	if (plan.sourcePath) return basename(plan.sourcePath).replace(/\.[^.]+$/, "");
	if (plan.targetProject) return plan.targetProject;
	if (plan.workers.length === 1) return plan.workers[0]?.name ?? "ad-hoc";
	return "ad-hoc-workflow";
}

function formatPlanSummary(plan: DispatchPlan, dryRun: boolean): string {
	const heading = dryRun ? "Pi dispatch dry run" : "Pi dispatch request";
	const rows = plan.workers.map((worker, index) => {
		const parts = [
			`${index + 1}. ${worker.name ?? "unnamed"}`,
			`cwd=${worker.cwd}`,
			`model=${worker.provider}/${worker.model}:${worker.thinking}`,
			`tools=${(worker.tools ?? DEFAULT_TOOLS).join(",")}`,
			`isolation=${worker.isolation}`,
			`piBin=${worker.piBin}`,
			...(worker.extensions.length > 0 ? [`extensions=${worker.extensions.join(",")}`] : []),
			`agentBus=${worker.agentBus ? "on" : "off"}`,
		];
		return parts.join(" | ");
	});
	return [
		`## ${heading}`,
		`Source: ${plan.sourcePath ?? "inline prompt"}`,
		...(plan.targetProject ? [`Target project: ${plan.targetProject}`] : []),
		`Workers: ${plan.workers.length}`,
		"",
		...rows,
	].join("\n");
}

function formatDispatchReport(jobs: PiJobState[], expected: number): string {
	const rows = jobs.map((job, index) => {
		return `${index + 1}. ${job.name} | short=${job.shortId} | state=${job.state} | model=${job.provider}/${job.model} | cwd=${job.cwd}`;
	});
	return [
		"## Pi dispatch result",
		`Dispatched: ${jobs.length}/${expected}`,
		"",
		...rows,
		"",
		"Open `/pi-agents` to watch, stop, or resume jobs.",
	].join("\n");
}

function buildSeedPrompt(
	worker: DispatchWorker,
	plan: DispatchPlan,
	originCwd: string,
	originSessionFile: string | undefined,
): string {
	const lines = [
		"You are a Pi background worker dispatched from a parent Pi Agent session.",
		"",
		"## Origin",
		"- Origin harness: pi-agent",
		`- Origin cwd: ${originCwd}`,
		`- Origin session file: ${originSessionFile ?? "ephemeral"}`,
		`- Dispatch source: ${plan.sourcePath ?? "inline prompt"}`,
		`- Worker name: ${worker.name ?? "unnamed"}`,
		`- Worker cwd: ${worker.cwd}`,
		...(plan.targetProject ? [`- Target project: ${plan.targetProject}`] : []),
		...(worker.tags.length > 0 ? [`- Tags: ${worker.tags.join(", ")}`] : []),
		"",
		"## Coordination rules",
		"- Pi owns this session lifecycle. Do not write Pi session JSONL as a control path.",
		"- Keep the task bounded to the request. Surface blockers and final outcome clearly.",
		"- If the task needs human input, stop and say exactly what is needed in the final response.",
		"- Do not consume Claude Code quota. You are running under the configured Pi model.",
		"",
		"## Task",
		worker.seedPrompt.trim(),
	];
	return lines.join("\n");
}

function parseArgs(input: string): ParsedArgs {
	const words = splitShellLike(input.trim());
	const parsed: ParsedArgs = {
		dryRun: false,
		noConfirm: false,
		follow: false,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL,
		thinking: DEFAULT_THINKING,
		isolation: "none",
		piBin: "pi",
		extensions: [],
		agentBus: false,
		prompt: "",
	};
	const promptWords: string[] = [];
	let parsingFlags = true;

	for (let i = 0; i < words.length; i++) {
		const word = words[i] ?? "";
		if (parsingFlags && word === "--") {
			parsingFlags = false;
			continue;
		}
		if (!parsingFlags || !word.startsWith("--")) {
			promptWords.push(word);
			continue;
		}

		const { key, value } = splitFlag(word);
		const takeValue = () => {
			if (value !== undefined) return value;
			const next = words[++i];
			if (!next) throw new Error(`Missing value for --${key}`);
			return next;
		};

		switch (key) {
			case "dry-run":
				parsed.dryRun = true;
				break;
			case "yes":
			case "no-confirm":
				parsed.noConfirm = true;
				break;
			case "follow":
				parsed.follow = true;
				break;
			case "cwd":
				parsed.cwd = takeValue();
				break;
			case "name":
				parsed.name = takeValue();
				break;
			case "provider":
				parsed.provider = takeValue();
				break;
			case "model":
				parsed.model = takeValue();
				break;
			case "thinking": {
				const thinking = parseThinking(takeValue());
				if (!thinking) throw new Error("--thinking must be one of: off, minimal, low, medium, high, xhigh");
				parsed.thinking = thinking;
				break;
			}
			case "tools":
				parsed.tools = takeValue()
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean);
				break;
			case "isolation": {
				const isolation = parseIsolation(takeValue());
				if (!isolation) throw new Error("--isolation must be one of: none, worktree");
				parsed.isolation = isolation;
				break;
			}
			case "pi-bin":
				parsed.piBin = takeValue();
				break;
			case "extension":
				parsed.extensions.push(takeValue());
				break;
			case "agent-bus":
				parsed.agentBus = true;
				break;
			case "no-agent-bus":
				parsed.agentBus = false;
				break;
			case "agent-bus-url":
				parsed.agentBusUrl = takeValue();
				parsed.agentBus = true;
				break;
			case "agent-bus-project":
				parsed.agentBusProject = takeValue();
				parsed.agentBus = true;
				break;
			default:
				throw new Error(`Unknown /pi-dispatch flag: --${key}`);
		}
	}

	parsed.prompt = promptWords.join(" ").trim();
	return parsed;
}

function runnerSource(): string {
	return String.raw`import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const stderr = createWriteStream(config.stderrPath, { flags: "a" });

async function readState() {
  try { return JSON.parse(await readFile(config.statePath, "utf8")); } catch { return {}; }
}

let ioQueue = Promise.resolve();

function enqueueIo(work) {
  ioQueue = ioQueue.then(work, work);
  return ioQueue;
}

async function writeState(patch) {
  return enqueueIo(async () => {
    const current = await readState();
    await writeFile(config.statePath, JSON.stringify({ ...current, ...patch, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  });
}

async function appendEvent(event) {
  return enqueueIo(() => writeFile(config.eventsPath, JSON.stringify(event) + "\n", { flag: "a" }));
}

function buildArgs() {
  const args = ["--mode", "rpc", "--name", config.name, "--provider", config.provider, "--model", config.model, "--thinking", config.thinking];
  if (Array.isArray(config.tools) && config.tools.length > 0) args.push("--tools", config.tools.join(","));
  for (const extension of config.extensions) args.push("--extension", extension);
  if (config.agentBus) {
    args.push("--agent-bus-url", config.agentBusUrl || "http://localhost:9888/api/agent-bus/events");
    args.push("--agent-bus-project", config.agentBusProject || "pi-dispatch");
    args.push("--agent-bus-host", config.agentBusHost || "localhost");
  }
  return args;
}

function sendRpc(command) {
  if (!child.stdin || child.stdin.destroyed) return;
  child.stdin.write(JSON.stringify(command) + "\n");
}

function firstText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}

function summarizeUsage(messages) {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const message of messages) {
    if (!message || message.role !== "assistant" || !message.usage) continue;
    input += Number(message.usage.input || 0);
    output += Number(message.usage.output || 0);
    cost += Number(message.usage.cost?.total || 0);
  }
  return { input, output, cost };
}

async function findSessionFile(sessionId) {
  if (!sessionId) return undefined;
  const root = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const content = await readFile(path, "utf8");
        const first = content.split(/\r?\n/, 1)[0];
        const header = JSON.parse(first);
        if (header && header.type === "session" && header.id === sessionId) return path;
      } catch {}
    }
  }
  return undefined;
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max - 1).trimEnd() + "…" : value;
}

await mkdir(config.statePath.slice(0, config.statePath.lastIndexOf("/")), { recursive: true });
await writeState({ state: "running", summary: "starting pi" });

const child = spawn(config.piBin, buildArgs(), { cwd: config.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
await writeState({ workerPid: child.pid, summary: "pi rpc running" });

let buffer = "";
let sessionId;
let controlOffset = 0;

sendRpc({ id: "state-0", type: "get_state" });
sendRpc({ id: "initial", type: "prompt", message: config.prompt });

const controlTimer = setInterval(async () => {
  let content;
  try { content = await readFile(config.controlPath, "utf8"); } catch { return; }
  const next = content.slice(controlOffset);
  controlOffset = content.length;
  for (const line of next.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { sendRpc(JSON.parse(line)); } catch {}
  }
}, 250);

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const index = buffer.indexOf("\n");
    if (index === -1) break;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    void appendEvent(event);
    if (event.type === "response" && event.command === "get_state" && event.success && event.data?.sessionId) {
      sessionId = event.data.sessionId;
      void writeState({ sessionId, sessionFile: event.data.sessionFile });
    } else if (event.type === "session") {
      sessionId = event.id;
      void writeState({ sessionId, summary: "session started" });
    } else if (event.type === "agent_start") {
      void writeState({ state: "running", summary: "agent running", completedAt: undefined, error: undefined });
    } else if (event.type === "tool_execution_start") {
      void writeState({ state: "running", summary: "tool: " + event.toolName });
    } else if (event.type === "tool_execution_end") {
      void writeState({ summary: (event.isError ? "tool failed: " : "tool done: ") + event.toolName });
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = String(event.assistantMessageEvent.delta || "").trim();
      if (delta) void writeState({ summary: "responding: " + truncate(delta, 80) });
    } else if (event.type === "agent_end") {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const assistants = messages.filter((message) => message && message.role === "assistant");
      const last = assistants[assistants.length - 1];
      const text = firstText(last);
      const usage = summarizeUsage(assistants);
      const failed = last && (last.stopReason === "error" || last.stopReason === "aborted");
      void writeState({
        state: failed ? "failed" : "done",
        summary: text ? truncate(text.replace(/\s+/g, " "), 160) : failed ? "agent failed" : "done",
        lastText: text ? truncate(text, 4000) : undefined,
        error: failed ? last.errorMessage || last.stopReason : undefined,
        inputTokens: usage.input,
        outputTokens: usage.output,
        costUsd: usage.cost,
        completedAt: new Date().toISOString(),
      });
      sendRpc({ id: "state-after-agent-end", type: "get_state" });
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderr.write(chunk);
});

child.on("error", (error) => {
  void writeState({ state: "failed", summary: "spawn failed", error: error.message, completedAt: new Date().toISOString() });
});

child.on("close", async (code, signal) => {
  clearInterval(controlTimer);
  if (buffer.trim()) {
    try { await appendEvent(JSON.parse(buffer.trim())); } catch {}
  }
  const current = await readState();
  const sessionFile = await findSessionFile(current.sessionId || sessionId);
  const terminalState = current.state === "stopped" ? "stopped" : code === 0 && current.state !== "failed" ? current.state || "done" : "failed";
  const exitDetail = "pi exited with code " + (code ?? "null") + (signal ? " signal " + signal : "");
  await writeState({
    state: terminalState === "running" ? "done" : terminalState,
    sessionFile,
    exitCode: code ?? undefined,
    error: code === 0 ? current.error : current.error || exitDetail,
    summary: code === 0 ? current.summary || "done" : current.summary || "pi failed",
    completedAt: new Date().toISOString(),
  });
  stderr.end();
});
`;
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getJobsRoot(): string {
	return join(getAgentDir(), "jobs");
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function isReadableFile(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

function resolveMaybeRelative(baseDir: string, path: string): string {
	return isAbsolute(path) ? path : resolve(baseDir, path);
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function extractFrontmatter(content: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	return match?.[1];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	return undefined;
}

function parseIsolation(value: string | undefined): IsolationMode | undefined {
	if (value === "none" || value === "worktree") return value;
	return undefined;
}

function splitFlag(word: string): { key: string; value?: string } {
	const raw = word.slice(2);
	const equals = raw.indexOf("=");
	if (equals === -1) return { key: raw };
	return { key: raw.slice(0, equals), value: raw.slice(equals + 1) };
}

function splitShellLike(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("Unterminated quote in /pi-dispatch arguments");
	if (current) words.push(current);
	return words;
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || `worker-${Date.now()}`;
}
