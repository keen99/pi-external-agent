/**
 * External Agent Tool — Delegate tasks to pi, Claude Code, or Codex CLI as background agents
 *
 * Spawns agent CLI subprocesses with isolated context windows.
 *
 * Modes:
 *   - Single: { agent: "pi"|"claude"|"codex", task: "..." }
 *   - Parallel: { tasks: [...] } — up to 8 tasks, 4 concurrent
 *   - Chain: { chain: [...] } — sequential with {previous} placeholder
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_CAP = 50 * 1024;

// ── config ──
// Read from ~/.pi/agent/settings.json under the "externalAgent" key:
//   { "externalAgent": { "allow": ["pi","claude"], "deny": ["codex"] } }
// allow = allowlist (if set, only these agents permitted)
// deny  = denylist (always excluded; wins over allow)
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const ALL_AGENTS: AgentName[] = ["pi", "claude", "codex"];

function readEnabledAgents(): Set<AgentName> {
	let cfg: any = {};
	try {
		if (fs.existsSync(SETTINGS_PATH)) cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
	} catch { /* ignore malformed */ }
	const ext = cfg?.externalAgent || {};
	const allow: string[] = Array.isArray(ext.allow) ? ext.allow : ALL_AGENTS;
	const deny: string[] = Array.isArray(ext.deny) ? ext.deny : [];
	const enabled = ALL_AGENTS.filter((a) => allow.includes(a) && !deny.includes(a));
	return new Set(enabled.length ? enabled : ALL_AGENTS);
}

function disabledAgentError(disabled: AgentName): string {
	return `Agent '${disabled}' is disabled in settings.json (externalAgent.allow/deny).`;
}

// ── types ──

interface Usage {
	input: number; output: number; cacheRead: number; cacheWrite: number;
	cost: number; contextTokens: number; turns: number;
}

interface ExtractedMsg {
	role: string;
	text: string;
	toolCalls?: { name: string; args: Record<string, unknown> }[];
}

interface SingleResult {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage: Usage;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	messages: ExtractedMsg[];
}

interface ExtAgentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
}

// ── helpers ──

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function isFailed(r: SingleResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error";
}

function getOutput(r: SingleResult): string {
	if (isFailed(r)) return r.errorMessage || r.stderr || r.output || "(no output)";
	return r.output || "(no output)";
}

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtUsage(u: Usage, model?: string): string {
	const p: string[] = [];
	if (u.turns) p.push(`${u.turns}T`);
	if (u.input) p.push(`↑${fmtTokens(u.input)}`);
	if (u.output) p.push(`↓${fmtTokens(u.output)}`);
	if (u.cacheRead) p.push(`R${fmtTokens(u.cacheRead)}`);
	if (u.cacheWrite) p.push(`W${fmtTokens(u.cacheWrite)}`);
	if (u.cost) p.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens) p.push(`ctx:${fmtTokens(u.contextTokens)}`);
	if (model) p.push(model);
	return p.join(" ");
}

function capOutput(s: string): string {
	const bytes = Buffer.byteLength(s, "utf8");
	if (bytes <= PER_TASK_CAP) return s;
	let t = s.slice(0, PER_TASK_CAP);
	while (Buffer.byteLength(t, "utf8") > PER_TASK_CAP) t = t.slice(0, -1);
	return `${t}\n\n[Truncated ${bytes - Buffer.byteLength(t, "utf8")} bytes. Full output in tool details.]`;
}

type OnUpdate = (partial: AgentToolResult<ExtAgentDetails>) => void;

async function mapConcurrent<TIn, TOut>(
	items: TIn[], concurrency: number, fn: (item: TIn, i: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (!items.length) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTemp(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ext-agent-"));
	const safeName = prefix.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiBin(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGeneric = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGeneric) return { command: process.execPath, args: [] };
	return { command: "pi", args: [] };
}

// ── Pi runner ──
// pi --mode json -p --no-session
// Events: message_end (role=assistant), tool_execution_start, turn_end, agent_end

async function runPi(
	task: string, cwd: string | undefined, defaultCwd: string,
	systemPrompt: string | undefined, model: string | undefined,
	tools: string[] | undefined, signal: AbortSignal | undefined,
	onUpdate: OnUpdate | undefined,
	makeDetails: (results: SingleResult[]) => ExtAgentDetails,
	step?: number,
): Promise<SingleResult> {
	const piBin = getPiBin();
	const args = [...piBin.args, "--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;

	const result: SingleResult = {
		agent: "pi", task, cwd, exitCode: 0, step,
		output: "", stderr: "", usage: emptyUsage(), messages: [], model,
	};

	const emit = () => {
		onUpdate?.({
			content: [{ type: "text", text: result.output || "(running...)" }],
			details: makeDetails([result]),
		});
	};

	try {
		if (systemPrompt) {
			const tmp = await writePromptToTemp("pi", systemPrompt);
			tmpDir = tmp.dir;
			tmpFile = tmp.filePath;
			args.push("--append-system-prompt", tmpFile);
		}

		args.push(task);

		return new Promise<SingleResult>((resolve) => {
			const proc = spawn(piBin.command, args, {
				cwd: cwd ?? defaultCwd, shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_CODING_AGENT_DIR: path.join(os.homedir(), ".pi", "agent") },
			});

			let stdoutBuf = "";
			let stderrBuf = "";

			const parseLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try { ev = JSON.parse(line); } catch { return; }

				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					const msg = ev.message;
					result.usage.turns++;
					if (msg.usage) {
						result.usage.input += msg.usage.input || 0;
						result.usage.output += msg.usage.output || 0;
						result.usage.cacheRead += msg.usage.cacheRead || 0;
						result.usage.cacheWrite += msg.usage.cacheWrite || 0;
						result.usage.cost += msg.usage.cost?.total || 0;
						result.usage.contextTokens = msg.usage.totalTokens || 0;
					}
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (!result.model && msg.model) result.model = msg.model;
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "text" && block.text) {
								result.output = block.text;
								result.messages.push({ role: "assistant", text: block.text });
							}
							if (block.type === "toolCall") {
								result.messages.push({
									role: "assistant", text: "",
									toolCalls: [{ name: block.name, args: block.arguments || {} }],
								});
							}
						}
					}
					emit();
				}

				if (ev.type === "tool_execution_start") {
					result.messages.push({
						role: "assistant", text: "",
						toolCalls: [{ name: ev.toolName || "tool", args: ev.args || {} }],
					});
					emit();
				}
			};

			proc.stdout.on("data", (d: Buffer) => {
				stdoutBuf += d.toString();
				const lines = stdoutBuf.split("\n");
				stdoutBuf = lines.pop() || "";
				for (const l of lines) parseLine(l);
			});

			proc.stderr.on("data", (d: Buffer) => {
				stderrBuf += d.toString();
				result.stderr = stderrBuf;
			});

			proc.on("close", (code) => {
				if (stdoutBuf.trim()) parseLine(stdoutBuf);
				result.exitCode = code ?? 0;
				if (stderrBuf && !result.output) {
					result.errorMessage = stderrBuf.slice(0, 2000);
				}
				emit();
				resolve(result);
			});

			proc.on("error", (err) => {
				result.exitCode = 1;
				result.errorMessage = err.message;
				resolve(result);
			});

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
	} finally {
		if (tmpFile) try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
}

// ── Claude Code runner ──
// claude -p --output-format stream-json --verbose --no-session-persistence
// Events: system (init), assistant (content blocks), result (final)

async function runClaude(
	task: string, cwd: string | undefined, defaultCwd: string,
	systemPrompt: string | undefined, model: string | undefined,
	signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined,
	makeDetails: (results: SingleResult[]) => ExtAgentDetails,
	step?: number,
): Promise<SingleResult> {
	const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "bypassPermissions"];
	if (model) args.push("--model", model);
	if (systemPrompt) args.push("--system-prompt", systemPrompt);

	const result: SingleResult = {
		agent: "claude", task, cwd, exitCode: 0, step,
		output: "", stderr: "", usage: emptyUsage(), messages: [], model,
	};

	const emit = () => {
		onUpdate?.({
			content: [{ type: "text", text: result.output || "(running...)" }],
			details: makeDetails([result]),
		});
	};

	return new Promise<SingleResult>((resolve) => {
		const proc = spawn("claude", [...args, task], {
			cwd: cwd ?? defaultCwd, shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuf = "";
		let stderrBuf = "";

		const parseLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try { ev = JSON.parse(line); } catch { return; }

			if (ev.type === "assistant" && ev.message) {
				const msg = ev.message;
				if (msg.usage) {
					result.usage.input += msg.usage.input_tokens || 0;
					result.usage.output += msg.usage.output_tokens || 0;
					result.usage.cacheRead += msg.usage.cache_read_input_tokens || 0;
					result.usage.cacheWrite += msg.usage.cache_creation_input_tokens || 0;
				}
				if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text" && block.text) {
							result.messages.push({ role: "assistant", text: block.text });
						}
						if (block.type === "tool_use") {
							result.messages.push({
								role: "assistant", text: "",
								toolCalls: [{ name: block.name, args: block.input || {} }],
							});
						}
					}
				}
				emit();
			}

			if (ev.type === "result") {
				result.output = (ev.result || "").trim();
				result.usage.turns = ev.num_turns || 1;
				result.stopReason = ev.stop_reason || "end";
				if (ev.usage) {
					result.usage.input = ev.usage.input_tokens || result.usage.input;
					result.usage.output = ev.usage.output_tokens || result.usage.output;
					result.usage.cacheRead = ev.usage.cache_read_input_tokens || result.usage.cacheRead;
					result.usage.cacheWrite = ev.usage.cache_creation_input_tokens || result.usage.cacheWrite;
				}
				if (ev.total_cost_usd) result.usage.cost = ev.total_cost_usd;
				emit();
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			stdoutBuf += d.toString();
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const l of lines) parseLine(l);
		});

		proc.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
			result.stderr = stderrBuf;
		});

		proc.on("close", (code) => {
			if (stdoutBuf.trim()) parseLine(stdoutBuf);
			result.exitCode = code ?? 0;
			if (stderrBuf && !result.output) {
				result.errorMessage = stderrBuf.slice(0, 2000);
			}
			emit();
			resolve(result);
		});

		proc.on("error", (err) => {
			result.exitCode = 1;
			result.errorMessage = err.message;
			resolve(result);
		});

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ── Codex runner ──
// codex exec --json --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox
// Events: thread.started, turn.started, item.completed, turn.completed

async function runCodex(
	task: string, cwd: string | undefined, defaultCwd: string,
	model: string | undefined, signal: AbortSignal | undefined,
	onUpdate: OnUpdate | undefined,
	makeDetails: (results: SingleResult[]) => ExtAgentDetails,
	step?: number,
): Promise<SingleResult> {
	const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox"];
	if (model) args.push("--model", model);

	const result: SingleResult = {
		agent: "codex", task, cwd, exitCode: 0, step,
		output: "", stderr: "", usage: emptyUsage(), messages: [], model,
	};

	const emit = () => {
		onUpdate?.({
			content: [{ type: "text", text: result.output || "(running...)" }],
			details: makeDetails([result]),
		});
	};

	return new Promise<SingleResult>((resolve) => {
		const proc = spawn("codex", [...args, task], {
			cwd: cwd ?? defaultCwd, shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuf = "";
		let stderrBuf = "";

		const parseLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try { ev = JSON.parse(line); } catch { return; }

			if (ev.type === "item.completed" && ev.item) {
				const item = ev.item;
				if (item.type === "agent_message" && item.text) {
					result.output = item.text;
					result.messages.push({ role: "assistant", text: item.text });
					emit();
				}
				if (item.type === "tool_call" || item.type === "function_call") {
					result.messages.push({
						role: "assistant", text: "",
						toolCalls: [{ name: item.name || item.tool || "tool", args: item.arguments || item.args || item.input || {} }],
					});
					emit();
				}
			}

			if (ev.type === "turn.completed") {
				result.usage.turns++;
				if (ev.usage) {
					result.usage.input += ev.usage.input_tokens || 0;
					result.usage.output += ev.usage.output_tokens || 0;
					result.usage.cacheRead += ev.usage.cached_input_tokens || 0;
				}
				emit();
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			stdoutBuf += d.toString();
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const l of lines) parseLine(l);
		});

		proc.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
			result.stderr = stderrBuf;
		});

		proc.on("close", (code) => {
			if (stdoutBuf.trim()) parseLine(stdoutBuf);
			result.exitCode = code ?? 0;
			if (stderrBuf && !result.output) {
				result.errorMessage = stderrBuf.slice(0, 2000);
			}
			emit();
			resolve(result);
		});

		proc.on("error", (err) => {
			result.exitCode = 1;
			result.errorMessage = err.message;
			resolve(result);
		});

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ── unified runner ──

type AgentName = "pi" | "claude" | "codex";

async function runAgent(
	agent: AgentName, task: string, cwd: string | undefined,
	defaultCwd: string, systemPrompt: string | undefined, model: string | undefined,
	tools: string[] | undefined,
	signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined,
	makeDetails: (results: SingleResult[]) => ExtAgentDetails,
	step?: number,
	modelRegistry?: any,
): Promise<SingleResult> {
	const resolvedModel = agent === "pi" ? resolvePiModelSpec(modelRegistry, model) : model;
	if (agent === "pi") return runPi(task, cwd, defaultCwd, systemPrompt, resolvedModel, tools, signal, onUpdate, makeDetails, step);
	if (agent === "claude") return runClaude(task, cwd, defaultCwd, systemPrompt, resolvedModel, signal, onUpdate, makeDetails, step);
	return runCodex(task, cwd, defaultCwd, resolvedModel, signal, onUpdate, makeDetails, step);
}

// ── schema ──

const AgentType = StringEnum(["pi", "claude", "codex"] as const, { description: "Which agent CLI to use" });

const TaskItem = Type.Object({
	agent: AgentType,
	task: Type.String(),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	systemPrompt: Type.Optional(Type.String({ description: "pi and claude only" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "pi only: tools to enable" })),
});

const ChainItem = Type.Object({
	agent: AgentType,
	task: Type.String({ description: "Use {previous} for prior step output" }),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	systemPrompt: Type.Optional(Type.String({ description: "pi and claude only" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "pi only" })),
});

const Params = Type.Object({
	agent: Type.Optional(AgentType),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(TaskItem)),
	chain: Type.Optional(Type.Array(ChainItem)),
	model: Type.Optional(Type.String({ description: "Override model (single mode)" })),
	systemPrompt: Type.Optional(Type.String({ description: "System prompt (pi and claude only)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "pi only: tools to enable" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
});

// ── display ──

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(msgs: ExtractedMsg[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const m of msgs) {
		if (m.text) items.push({ type: "text", text: m.text });
		if (m.toolCalls) for (const tc of m.toolCalls) items.push({ type: "toolCall", name: tc.name, args: tc.args as Record<string, any> });
	}
	return items;
}

function renderItems(items: DisplayItem[], limit: number, theme: any): string {
	const toShow = items.slice(-limit);
	const skipped = items.length > limit ? items.length - limit : 0;
	let t = "";
	if (skipped) t += theme.fg("muted", `... ${skipped} earlier\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = item.text.split("\n").slice(0, 3).join("\n");
			t += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			const preview = JSON.stringify(item.args).slice(0, 60);
			t += `${theme.fg("muted", "→ ")}${theme.fg("accent", item.name)} ${theme.fg("dim", preview)}\n`;
		}
	}
	return t.trimEnd();
}

// ── model resolution ──
// Resolve a bare model id to a canonical provider/modelId spec using only
// AUTHED models, so the spawned pi subprocess lands on an authed provider
// directly — no reliance on pi-model-authguard (which --no-extensions skips).
function resolvePiModelSpec(modelRegistry: any, model: string | undefined): string | undefined {
	if (!model) return undefined;
	// Already canonical (contains /)? Pass through after confirming auth.
	if (model.includes("/")) {
		const available = modelRegistry?.getAvailable?.() ?? [];
		const match = available.find((m: any) => `${m.provider}/${m.id}`.toLowerCase() === model.toLowerCase());
		if (match) return `${match.provider}/${match.id}`;
		// Not authed or unknown — still pass through; subprocess will error clearly.
		return model;
	}
	// Bare id: find exact match among authed models.
	const available = modelRegistry?.getAvailable?.() ?? [];
	const norm = model.toLowerCase();
	const idMatches = available.filter((m: any) => m.id.toLowerCase() === norm);
	if (idMatches.length === 1) return `${idMatches[0].provider}/${idMatches[0].id}`;
	// No authed exact match — fall back to bare id (subprocess behavior unchanged).
	return model;
}

// ── extension ──

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "external_agent",
		label: "External Agent",
		description: [
			"Delegate tasks to pi, Claude Code, or Codex CLI as isolated background agents.",
			"Agents: 'pi' (spawns pi with isolated context), 'claude' (Claude Code), 'codex' (Codex CLI).",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous}).",
			"Each agent runs in a separate process with its own context window.",
		].join(" "),
		parameters: Params,
		promptSnippet: "Delegate tasks to pi, Claude Code, or Codex as isolated background agents",
		promptGuidelines: [
			"Use external_agent when you need to delegate work to pi, Claude Code, or Codex with an isolated context.",
			"Use 'pi' agent when you want pi's full toolset with a different model or isolated context.",
			"Use 'claude' agent for Claude Code's specific tooling.",
			"Use 'codex' agent for Codex CLI's specific tooling.",
			"Use chain mode when step N needs output from step N-1. Use parallel for independent tasks.",
			"systemPrompt works with pi and claude agents. tools param only works with pi agent.",
		],

		async execute(_id, params, signal, onUpdate, ctx) {
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails = (mode: "single" | "parallel" | "chain") => (results: SingleResult[]): ExtAgentDetails => ({ mode, results });

			if (modeCount !== 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one mode: {agent, task} or {tasks: [...]} or {chain: [...]}." }],
					details: makeDetails("single")([]),
				};
			}

			// ── agent allow/deny enforcement ──
			const enabled = readEnabledAgents();
			const requestedAgents: AgentName[] = [];
			if (hasSingle && params.agent) requestedAgents.push(params.agent);
			if (params.tasks) for (const t of params.tasks) requestedAgents.push(t.agent);
			if (params.chain) for (const s of params.chain) requestedAgents.push(s.agent);
			const disabled = requestedAgents.filter((a) => !enabled.has(a));
			if (disabled.length) {
				return {
					content: [{ type: "text", text: disabledAgentError(disabled[0]) }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// ── chain ──
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previous = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskText = step.task.replace(/\{previous\}/g, previous);
					const chainUpd: OnUpdate | undefined = onUpdate
						? (partial) => {
								const cur = partial.details?.results[0];
								if (cur) onUpdate({ content: partial.content, details: makeDetails("chain")([...results, cur]) });
							}
						: undefined;

					const r = await runAgent(
						step.agent, taskText, step.cwd, ctx.cwd, step.systemPrompt, step.model, step.tools,
						signal, chainUpd, makeDetails("chain"), i + 1, ctx.modelRegistry,
					);
					results.push(r);

					if (isFailed(r)) {
						return {
							content: [{ type: "text", text: `Chain failed step ${i + 1} (${step.agent}): ${getOutput(r)}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previous = r.output;
				}
				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: last.output || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// ── parallel ──
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL) {
					return {
						content: [{ type: "text", text: `Too many tasks (${params.tasks.length}). Max ${MAX_PARALLEL}.` }],
						details: makeDetails("parallel")([]),
					};
				}

				const allResults: SingleResult[] = params.tasks.map(t => ({
					agent: t.agent, task: t.task, cwd: t.cwd, exitCode: -1,
					output: "", stderr: "", usage: emptyUsage(), messages: [],
				}));

				const WIDGET_KEY = "external-agent-parallel";
				const renderWidget = () => {
					try {
						const lines = allResults.map((r, i) => {
							const taskPreview = (r.task || "").slice(0, 60).replace(/\n/g, " ");
							let status: string;
							if (r.exitCode === -1) status = "running";
							else if (isFailed(r)) status = "failed";
							else status = "done";
							return `[${i + 1}/${allResults.length}] ${r.agent}: ${status} — ${taskPreview}`;
						});
						const done = allResults.filter(r => r.exitCode !== -1).length;
						lines.push(`Parallel: ${done}/${allResults.length} done`);
						ctx.ui?.setWidget?.(WIDGET_KEY, lines, { placement: "belowEditor" });
					} catch {
						/* widget best-effort */
					}
				};

				const emitAll = () => {
					renderWidget();
					if (!onUpdate) return;
					const done = allResults.filter(r => r.exitCode !== -1).length;
					const running = allResults.filter(r => r.exitCode === -1).length;
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await mapConcurrent(params.tasks, MAX_CONCURRENCY, async (t, idx) => {
					const r = await runAgent(
						t.agent, t.task, t.cwd, ctx.cwd, t.systemPrompt, t.model, t.tools,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[idx] = partial.details.results[0];
								emitAll();
							}
						},
						makeDetails("parallel"),
						idx, ctx.modelRegistry,
					);
					allResults[idx] = r;
					emitAll();
					return r;
				});

				const ok = results.filter(r => !isFailed(r)).length;
				try {
					ctx.ui?.setWidget?.(WIDGET_KEY, undefined);
				} catch {
					/* best-effort */
				}
				const summaries = results.map(r => {
					const output = capOutput(getOutput(r));
					const status = isFailed(r) ? "failed" : "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
					details: makeDetails("parallel")(results),
				};
			}

			// ── single ──
			if (params.agent && params.task) {
				const r = await runAgent(
					params.agent, params.task, params.cwd, ctx.cwd,
					params.systemPrompt, params.model, params.tools,
					signal, onUpdate, makeDetails("single"), undefined, ctx.modelRegistry,
				);
				if (isFailed(r)) {
					return {
						content: [{ type: "text", text: `${r.agent} failed: ${getOutput(r)}` }],
						details: makeDetails("single")([r]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: r.output || "(no output)" }],
					details: makeDetails("single")([r]),
				};
			}

			return {
				content: [{ type: "text", text: "Provide agent and task, tasks array, or chain array." }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const modeLabel = args.chain
				? `chain (${args.chain.length} steps)`
				: args.tasks
					? `parallel (${args.tasks.length} tasks)`
					: args.agent || "...";

			const preview = args.task
				? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task)
				: args.chain
					? args.chain.map((s: any) => `${s.agent}: ${(s.task || "").slice(0, 30)}`).join(" → ")
					: args.tasks
						? `${args.tasks.length} tasks`
						: "...";

			return new Text(
				theme.fg("toolTitle", theme.bold("external_agent ")) +
				theme.fg("accent", modeLabel) +
				"\n  " + theme.fg("dim", preview),
				0, 0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ExtAgentDetails | undefined;
			if (!details || !details.results.length) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderSingle = (r: SingleResult) => {
				const icon = isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = getDisplayItems(r.messages);

				if (expanded) {
					const c = new Container();
					c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`, 0, 0));
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					c.addChild(new Spacer(1));
					if (items.length) {
						c.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
						for (const item of items) {
							if (item.type === "toolCall") {
								c.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("accent", item.name), 0, 0));
							}
						}
						c.addChild(new Spacer(1));
					}
					if (r.output) {
						c.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
						c.addChild(new Markdown(r.output.trim(), 0, 0, mdTheme));
					}
					const usageStr = fmtUsage(r.usage, r.model);
					if (usageStr) {
						c.addChild(new Spacer(1));
						c.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return c;
				}

				let t = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
				if (isFailed(r) && r.errorMessage) t += `\n${theme.fg("error", r.errorMessage.slice(0, 200))}`;
				else if (items.length) t += `\n${renderItems(items, 10, theme)}`;
				else t += `\n${theme.fg("muted", "(no output)")}`;
				const usageStr = fmtUsage(r.usage, r.model);
				if (usageStr) t += `\n${theme.fg("dim", usageStr)}`;
				return new Text(t, 0, 0);
			};

			if (details.mode === "single") return renderSingle(details.results[0]);

			// Parallel / chain
			const allOk = details.results.every(r => !isFailed(r));
			const icon = allOk ? theme.fg("success", "✓") : theme.fg("warning", "◐");
			const label = details.mode === "chain" ? "chain" : "parallel";
			const okCount = details.results.filter(r => !isFailed(r)).length;

			if (expanded) {
				const c = new Container();
				c.addChild(new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold(label + " "))}${theme.fg("accent", `${okCount}/${details.results.length}`)}`,
					0, 0,
				));
				for (const r of details.results) {
					c.addChild(new Spacer(1));
					const stepLabel = r.step ? `Step ${r.step}: ` : "";
					const rIcon = isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					c.addChild(new Text(`${theme.fg("muted", stepLabel)}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
					if (r.output) {
						c.addChild(new Markdown(r.output.trim().slice(0, 2000), 0, 0, mdTheme));
					}
					const usageStr = fmtUsage(r.usage, r.model);
					if (usageStr) c.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return c;
			}

			let t = `${icon} ${theme.fg("toolTitle", theme.bold(label + " "))}${theme.fg("accent", `${okCount}/${details.results.length}`)}`;
			for (const r of details.results) {
				const rIcon = isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const stepLabel = r.step ? `Step ${r.step}: ` : "";
				const preview = (r.output || "(no output)").split("\n").slice(0, 2).join("\n");
				t += `\n  ${theme.fg("muted", stepLabel)}${theme.fg("accent", r.agent)} ${rIcon}`;
				t += `\n  ${theme.fg("dim", preview.slice(0, 100))}`;
			}
			t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(t, 0, 0);
		},
	});
}
