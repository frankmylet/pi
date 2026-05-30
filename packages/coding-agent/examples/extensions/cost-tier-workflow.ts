/**
 * Cost-tier Workflow Demo
 *
 * Adds a `/cost-workflow` command that previews a tiny workflow policy before
 * dispatching jobs to Pi subprocesses. It is intentionally a demo, not a full
 * workflow runtime: policy lives in JSON, every job has an explicit model,
 * effort, maxCostUsd, and tools, and Opus-class jobs are gated unless the user
 * passes `--allow-opus`.
 *
 * Usage:
 *   /cost-workflow add tests for the auth helper
 *   /cost-workflow --config examples/extensions/cost-tier-workflow.demo.json add tests
 *   /cost-workflow --run --allow-opus add tests
 */

import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type TierName = "scout" | "implement" | "architect" | string;

interface TierPolicy {
	provider: string;
	model: string;
	effort: Effort;
	maxCostUsd: number;
	tools: string[];
	requiresExplicitOptIn?: boolean;
}

interface WorkflowJob {
	id: string;
	tier: TierName;
	prompt: string;
}

interface WorkflowConfig {
	name: string;
	description?: string;
	policy: { tiers: Record<string, TierPolicy> };
	jobs: WorkflowJob[];
}

interface ParsedArgs {
	run: boolean;
	allowOpus: boolean;
	noConfirm: boolean;
	configPath?: string;
	task: string;
}

interface ResolvedJob {
	job: WorkflowJob;
	policy: TierPolicy;
	prompt: string;
	gatedReason?: string;
}

const DEFAULT_WORKFLOW: WorkflowConfig = {
	name: "cost-tier-demo",
	description: "Cheap scout, mid-tier implementation, and Opus architecture review only with explicit opt-in.",
	policy: {
		tiers: {
			scout: {
				provider: "anthropic",
				model: "claude-haiku-4-5-20251001",
				effort: "low",
				maxCostUsd: 0.25,
				tools: ["read", "grep", "find", "ls"],
			},
			implement: {
				provider: "openai-codex",
				model: "gpt-5.5",
				effort: "medium",
				maxCostUsd: 2,
				tools: ["read", "bash", "edit", "write"],
			},
			architect: {
				provider: "anthropic",
				model: "claude-opus-4-8",
				effort: "high",
				maxCostUsd: 3,
				tools: ["read", "grep", "find", "ls"],
				requiresExplicitOptIn: true,
			},
		},
	},
	jobs: [
		{
			id: "survey",
			tier: "scout",
			prompt:
				"Read-only scout pass for: {{task}}\n\nReturn relevant files, likely risks, and the cheapest next step. Do not edit files.",
		},
		{
			id: "patch",
			tier: "implement",
			prompt:
				"Implement the smallest safe patch for: {{task}}\n\nKeep scope tight. Run targeted validation. Stop if requirements are missing.",
		},
		{
			id: "architecture-review",
			tier: "architect",
			prompt:
				"Architecture-only review for: {{task}}\n\nDo not edit. Identify any high-severity design risks before broader fanout.",
		},
	],
};

export default function costTierWorkflowDemo(pi: ExtensionAPI) {
	pi.registerCommand("cost-workflow", {
		description: "Preview/run a cost-tiered Pi workflow demo with Opus opt-in",
		getArgumentCompletions: (prefix) => {
			const flags = ["--run", "--dry-run", "--allow-opus", "--no-confirm", "--config="];
			const filtered = flags.filter((flag) => flag.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((flag) => ({ value: flag, label: flag })) : null;
		},
		handler: async (args, ctx) => {
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			if (!parsed.task) {
				ctx.ui.notify("Usage: /cost-workflow [--run] [--allow-opus] [--config path] <task>", "error");
				return;
			}

			let config: WorkflowConfig;
			try {
				config = parsed.configPath ? await loadConfig(parsed.configPath, ctx.cwd) : DEFAULT_WORKFLOW;
				validateConfig(config);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const resolved = resolveJobs(config, parsed.task, parsed.allowOpus);
			const preview = formatPreview(config, resolved, parsed);
			pi.sendMessage({
				customType: "cost-tier-workflow",
				content: preview,
				display: true,
				details: { config, parsed, resolved },
			});

			if (!parsed.run) {
				ctx.ui.notify(`Dry run: ${resolved.length} job(s), ${gatedCount(resolved)} gated`, "info");
				return;
			}

			const runnable = resolved.filter((item) => !item.gatedReason);
			if (runnable.length === 0) {
				ctx.ui.notify("No runnable jobs. Add --allow-opus or remove gated jobs.", "warning");
				return;
			}

			if (!parsed.noConfirm) {
				if (!ctx.hasUI) {
					ctx.ui.notify("/cost-workflow --run requires --no-confirm when UI is unavailable", "error");
					return;
				}
				const confirmed = await ctx.ui.confirm("Run cost-tier workflow jobs?", preview);
				if (!confirmed) {
					ctx.ui.notify("Workflow cancelled", "info");
					return;
				}
			}

			const reports: string[] = [];
			for (const item of runnable) {
				const command = buildPiArgs(item);
				reports.push(`## ${item.job.id}\n\n\`${previewCommand(command)}\``);
				const result = await pi.exec(command[0], command.slice(1), { cwd: ctx.cwd, timeout: 15 * 60_000 });
				reports.push(formatRunResult(item, result));
				if (result.code !== 0) break;
			}

			pi.sendMessage({
				customType: "cost-tier-workflow-result",
				content: `# ${config.name} result\n\n${reports.join("\n\n")}`,
				display: true,
				details: { reports },
			});
			ctx.ui.notify(`Workflow finished: ${runnable.length} attempted job(s)`, "info");
		},
	});
}

function parseArgs(raw: string): ParsedArgs {
	const tokens = tokenize(raw);
	const rest: string[] = [];
	const parsed: ParsedArgs = { run: false, allowOpus: false, noConfirm: false, task: "" };

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--run") parsed.run = true;
		else if (token === "--dry-run") parsed.run = false;
		else if (token === "--allow-opus") parsed.allowOpus = true;
		else if (token === "--no-confirm") parsed.noConfirm = true;
		else if (token === "--config") {
			const value = tokens[++i];
			if (!value) throw new Error("--config requires a path");
			parsed.configPath = value;
		} else if (token.startsWith("--config=")) {
			parsed.configPath = token.slice("--config=".length);
		} else if (token.startsWith("--")) {
			throw new Error(`Unknown flag: ${token}`);
		} else {
			rest.push(token);
		}
	}

	parsed.task = rest.join(" ").trim();
	return parsed;
}

function tokenize(input: string): string[] {
	const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return tokens.map((token) => {
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1);
		}
		return token;
	});
}

async function loadConfig(configPath: string, cwd: string): Promise<WorkflowConfig> {
	const path = isAbsolute(configPath) ? configPath : resolve(cwd, stripAtPrefix(configPath));
	await access(path);
	return JSON.parse(await readFile(path, "utf8")) as WorkflowConfig;
}

function validateConfig(config: WorkflowConfig): void {
	if (!config.name) throw new Error("workflow config requires name");
	if (!config.policy?.tiers || typeof config.policy.tiers !== "object")
		throw new Error("workflow config requires policy.tiers");
	if (!Array.isArray(config.jobs) || config.jobs.length === 0)
		throw new Error("workflow config requires non-empty jobs");
	for (const job of config.jobs) {
		if (!job.id || !job.tier || !job.prompt) throw new Error("each job requires id, tier, and prompt");
		const tier = config.policy.tiers[job.tier];
		if (!tier) throw new Error(`job ${job.id} references unknown tier: ${job.tier}`);
		if (!tier.provider || !tier.model || !tier.effort || !Array.isArray(tier.tools)) {
			throw new Error(`tier ${job.tier} requires provider, model, effort, and tools`);
		}
	}
}

function resolveJobs(config: WorkflowConfig, task: string, allowOpus: boolean): ResolvedJob[] {
	return config.jobs.map((job) => {
		const policy = config.policy.tiers[job.tier];
		const prompt = job.prompt.replaceAll("{{task}}", task);
		const opusLike = `${policy.provider}/${policy.model}`.toLowerCase().includes("opus");
		const gatedReason = policy.requiresExplicitOptIn && opusLike && !allowOpus ? "requires --allow-opus" : undefined;
		return { job, policy, prompt, gatedReason };
	});
}

function gatedCount(jobs: ResolvedJob[]): number {
	return jobs.filter((job) => job.gatedReason).length;
}

function formatPreview(config: WorkflowConfig, jobs: ResolvedJob[], args: ParsedArgs): string {
	const totalBudget = jobs.reduce((sum, item) => sum + item.policy.maxCostUsd, 0);
	const lines = [
		`# ${config.name} ${args.run ? "run preview" : "dry run"}`,
		"",
		config.description ? `${config.description}\n` : "",
		`Task: ${args.task}`,
		`Mode: ${args.run ? "RUN after confirmation" : "DRY RUN only"}`,
		`Opus opt-in: ${args.allowOpus ? "yes" : "no"}`,
		`Declared max budget: $${totalBudget.toFixed(2)} (demo metadata; not a hard billing stop)`,
		"",
		"| Job | Tier | Model | Effort | Max | Tools | Status |",
		"| --- | --- | --- | --- | ---: | --- | --- |",
	];

	for (const item of jobs) {
		const p = item.policy;
		lines.push(
			`| ${item.job.id} | ${item.job.tier} | ${p.provider}/${p.model} | ${p.effort} | $${p.maxCostUsd.toFixed(2)} | ${p.tools.join(", ")} | ${item.gatedReason ?? "ready"} |`,
		);
	}

	lines.push("", "Architect/Opus jobs are skipped unless `--allow-opus` is present.");
	return lines.filter((line) => line !== undefined).join("\n");
}

function buildPiArgs(item: ResolvedJob): string[] {
	const p = item.policy;
	return [
		"pi",
		"--no-session",
		"--print",
		"--mode",
		"json",
		"--model",
		`${p.provider}/${p.model}`,
		"--thinking",
		p.effort,
		"--tools",
		p.tools.join(","),
		item.prompt,
	];
}

function previewCommand(args: string[]): string {
	return args
		.map((arg) => {
			if (/^[A-Za-z0-9_./:=,-]+$/.test(arg)) return arg;
			return JSON.stringify(arg);
		})
		.join(" ");
}

function formatRunResult(item: ResolvedJob, result: { code: number; stdout: string; stderr: string }): string {
	const stdout = truncate(result.stdout.trim(), 4000);
	const stderr = truncate(result.stderr.trim(), 2000);
	return [
		`Exit code: ${result.code}`,
		stdout ? `\nstdout:\n\`\`\`\n${stdout}\n\`\`\`` : "",
		stderr ? `\nstderr:\n\`\`\`\n${stderr}\n\`\`\`` : "",
		item.policy.maxCostUsd ? `\nDeclared maxCostUsd: $${item.policy.maxCostUsd.toFixed(2)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}
