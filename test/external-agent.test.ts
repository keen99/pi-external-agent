import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import test from "node:test";

const { default: extAgent } = await import("../index.js");

// ── harness ─────────────────────────────────────────────────────────────
type Capture = { tool: string; def: any };

function harness(opts: { settings?: object; modelRegistry?: any } = {}) {
	const cap: Capture = {};
	const fakePi: any = {
		registerTool: (def: any) => { cap.tool = def.name; cap.def = def; },
	};
	// settings override — ALWAYS hermetic: default permissive file so real
	// ~/.pi/agent/settings.json never leaks into test outcomes.
	{
		const dir = mkdtempSync(join(tmpdir(), "extagent-cfg-"));
		const p = join(dir, "settings.json");
		writeFileSync(p, JSON.stringify(opts.settings ?? {}));
		process.env.EXTERNAL_AGENT_SETTINGS = p;
	}
	const fakeCtx: any = { cwd: tmpdir(), modelRegistry: opts.modelRegistry };
	extAgent(fakePi);
	return {
		cap,
		execute: (params: any, onUpdate?: any) =>
			cap.def.execute("t1", params, new AbortController().signal, onUpdate, fakeCtx),
		cleanup: () => { delete process.env.EXTERNAL_AGENT_SETTINGS; },
	};
}

// PATH shim infra: bin dir with executable scripts that emit canned agent
// output and record argv for assertions.
let binDirCounter = 0;
function makeShims(shims: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), `extagent-bin-${binDirCounter++}-`));
	for (const [name, body] of Object.entries(shims)) {
		const p = join(dir, name);
		writeFileSync(p, `#!/bin/bash\n${body}\n`);
		chmodSync(p, 0o755);
	}
	return dir;
}

function withPath(bin: string, fn: () => Promise<void>) {
	const saved = process.env.PATH;
	const savedPi = process.env.EXTERNAL_AGENT_PI_BIN;
	process.env.PATH = `${bin}:${saved}`;
	return async () => {
		try { await fn(); }
		finally {
			process.env.PATH = saved;
			if (savedPi === undefined) delete process.env.EXTERNAL_AGENT_PI_BIN;
			else process.env.EXTERNAL_AGENT_PI_BIN = savedPi;
		}
	};
}

const capDir = () => mkdtempSync(join(tmpdir(), "extagent-cap-"));
const capture = (dir: string) => (existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8") : "");

// ── registration ────────────────────────────────────────────────────────
test("registers external_agent tool with execute + renderers", () => {
	const { cap, cleanup } = harness();
	assert.equal(cap.tool, "external_agent");
	assert.equal(typeof cap.def.execute, "function");
	assert.equal(typeof cap.def.renderCall, "function");
	assert.equal(typeof cap.def.renderResult, "function");
	cleanup();
});

// ── mode validation ─────────────────────────────────────────────────────
test("zero or multiple modes → exactly-one-mode message", async () => {
	const { execute, cleanup } = harness();
	let r = await execute({});
	assert.match(r.content[0].text, /Provide exactly one mode/);
	r = await execute({ agent: "pi", task: "x", tasks: [{ agent: "pi", task: "y" }] });
	assert.match(r.content[0].text, /Provide exactly one mode/);
	cleanup();
});

// ── allow/deny ──────────────────────────────────────────────────────────
test("denied agent blocked with settings error", async () => {
	const { execute, cleanup } = harness({ settings: { externalAgent: { deny: ["codex"] } } });
	const r = await execute({ agent: "codex", task: "x" });
	assert.match(r.content[0].text, /'codex' is disabled/);
	assert.equal(r.isError, true);
	cleanup();
});

test("allowlist restricts to listed agents", async () => {
	const { execute, cleanup } = harness({ settings: { externalAgent: { allow: ["pi"] } } });
	const r = await execute({ agent: "claude", task: "x" });
	assert.match(r.content[0].text, /'claude' is disabled/);
	cleanup();
});

// ── parallel limits ─────────────────────────────────────────────────────
test("parallel above MAX_PARALLEL=8 rejected", async () => {
	const { execute, cleanup } = harness();
	const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: "codex", task: `t${i}` }));
	const r = await execute({ tasks });
	assert.match(r.content[0].text, /Too many tasks \(9\). Max 8\./);
	cleanup();
});

// ── codex single (PATH shim, real spawn) ────────────────────────────────
test("codex single: canned stream parsed, output returned", async () => {
	const cap = capDir();
	const bin = makeShims({
		codex: `echo "$@" >> ${join(cap, "argv.log")}
echo '{"type":"item.completed","item":{"type":"agent_message","text":"codex says hi"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}}'`,
	});
	const run = withPath(bin, async () => {
		const { execute, cleanup } = harness();
		const r = await execute({ agent: "codex", task: "greet" });
		assert.equal(r.isError, undefined);
		assert.equal(r.content[0].text, "codex says hi");
		assert.equal(r.details.mode, "single");
		assert.equal(r.details.results[0].agent, "codex");
		assert.equal(r.details.results[0].usage.turns, 1);
		assert.equal(r.details.results[0].usage.input, 10);
		assert.equal(r.details.results[0].usage.cacheRead, 2);
		assert.match(capture(cap), /greet/);
		cleanup();
	});
	await run();
	rmSync(bin, { recursive: true, force: true });
});

// ── claude single ───────────────────────────────────────────────────────
test("claude single: result event becomes output, usage + cost captured", async () => {
	const cap = capDir();
	const bin = makeShims({
		claude: `echo "$@" >> ${join(cap, "argv.log")}
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"usage":{"input_tokens":7,"output_tokens":3},"content":[{"type":"text","text":"claude partial"}]}}'
echo '{"type":"result","result":"claude final","num_turns":2,"stop_reason":"end","usage":{"input_tokens":7,"output_tokens":3},"total_cost_usd":0.01}'`,
	});
	const run = withPath(bin, async () => {
		const { execute, cleanup } = harness();
		const r = await execute({ agent: "claude", task: "do it" });
		assert.equal(r.content[0].text, "claude final");
		const res = r.details.results[0];
		assert.equal(res.usage.turns, 2);
		assert.equal(res.usage.cost, 0.01);
		assert.equal(res.output, "claude final");
		// permission-mode flag present
		assert.match(capture(cap), /bypassPermissions/);
		cleanup();
	});
	await run();
	rmSync(bin, { recursive: true, force: true });
});

// ── pi single: bin override + model resolution + stream parse ───────────
test("pi single: EXTERNAL_AGENT_PI_BIN shim, JSON events parsed, model resolved to canonical", async () => {
	const cap = capDir();
	const piBin = makeShims({
		"fake-pi": `echo "$@" >> ${join(cap, "argv.log")}
echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","model":"m1","usage":{"input":1,"output":2,"totalTokens":9,"cost":{"total":0.001}},"content":[{"type":"text","text":"pi done"}]}}'`,
	});
	process.env.EXTERNAL_AGENT_PI_BIN = join(piBin, "fake-pi");
	const run = withPath(piBin, async () => {
		const { execute, cleanup } = harness({ modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-x" }] } });
		const r = await execute({ agent: "pi", task: "run", model: "claude-x" });
		assert.equal(r.content[0].text, "pi done");
		const res = r.details.results[0];
		assert.equal(res.usage.turns, 1);
		assert.equal(res.usage.contextTokens, 9);
		assert.equal(res.usage.cost, 0.001);
		assert.equal(res.model, "anthropic/claude-x"); // resolved spec pre-seeds result.model
		const argv = capture(cap);
		assert.match(argv, /--mode json -p --no-session --no-extensions/);
		assert.match(argv, /--model anthropic\/claude-x/);
		assert.match(argv, /run/);
		cleanup();
	});
	await run();
	rmSync(piBin, { recursive: true, force: true });
});

test("pi model: unknown bare id passes through unchanged", async () => {
	const cap = capDir();
	const piBin = makeShims({
		"fake-pi": `echo "$@" >> ${join(cap, "argv.log")}
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}'`,
	});
	process.env.EXTERNAL_AGENT_PI_BIN = join(piBin, "fake-pi");
	const run = withPath(piBin, async () => {
		const { execute, cleanup } = harness({ modelRegistry: { getAvailable: () => [] } });
		await execute({ agent: "pi", task: "t", model: "zzz" });
		assert.match(capture(cap), /--model zzz/);
		cleanup();
	});
	await run();
	rmSync(piBin, { recursive: true, force: true });
});

// ── chain ───────────────────────────────────────────────────────────────
test("chain: {previous} substituted from step 1 output into step 2", async () => {
	const cap = capDir();
	const bin = makeShims({
		codex: `echo "$@" >> ${join(cap, "argv.log")}
echo '{"type":"item.completed","item":{"type":"agent_message","text":"step-one-output"}}'`,
	});
	const run = withPath(bin, async () => {
		const { execute, cleanup } = harness();
		const r = await execute({ chain: [
			{ agent: "codex", task: "first" },
			{ agent: "codex", task: "review {previous}" },
		] });
		assert.equal(r.isError, undefined);
		assert.equal(r.content[0].text, "step-one-output");
		assert.equal(r.details.mode, "chain");
		assert.equal(r.details.results.length, 2);
		assert.equal(r.details.results[1].step, 2);
		const argv = capture(cap);
		assert.match(argv, /review step-one-output/);
		cleanup();
	});
	await run();
	rmSync(bin, { recursive: true, force: true });
});

test("chain fail-fast: failing first step prevents second spawn", async () => {
	const cap = capDir();
	const bin = makeShims({
		"codex": `for a in "$@"; do [ "$a" = "dies" ] && { echo "exploded" >&2; exit 3; }; done
echo "$@" >> ${join(cap, "argv.log")}
echo '{"type":"item.completed","item":{"type":"agent_message","text":"fine"}}'`,
	});
	const run = withPath(bin, async () => {
		const { execute, cleanup } = harness();
		const r = await execute({ chain: [
			{ agent: "codex", task: "dies" },
			{ agent: "codex", task: "second" },
		] });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /Chain failed step 1 \(codex\)/);
		assert.match(r.content[0].text, /exploded/);
		assert.equal(capture(cap).includes("second"), false, "step 2 never spawned");
		cleanup();
	});
	await run();
	rmSync(bin, { recursive: true, force: true });
});

// ── parallel ────────────────────────────────────────────────────────────
test("parallel: 3 real spawns, all succeed, summary counts", async () => {
	const cap = capDir();
	const bin = makeShims({
		codex: `echo "$@" >> ${join(cap, "argv.log")}
echo '{"type":"item.completed","item":{"type":"agent_message","text":"done '$RANDOM'"}}'`,
	});
	const run = withPath(bin, async () => {
		const { execute, cleanup } = harness();
		const r = await execute({ tasks: [
			{ agent: "codex", task: "a" },
			{ agent: "codex", task: "b" },
			{ agent: "codex", task: "c" },
		] });
		assert.match(r.content[0].text, /Parallel: 3\/3 succeeded/);
		assert.equal(r.details.results.length, 3);
		assert.deepEqual(r.details.results.map((x: any) => x.task).sort(), ["a", "b", "c"]);
		assert.equal(capture(cap).split("\n").filter((l) => l.trim()).length, 3);
		cleanup();
	});
	await run();
	rmSync(bin, { recursive: true, force: true });
});

test("parallel: partial failure reported in count and per-task status", async () => {
	const bin = makeShims({
		codex: `for a in "$@"; do [ "$a" = "bad" ] && exit 9; done
echo '{"type":"item.completed","item":{"type":"agent_message","text":"fine"}}'`,
	});
	const run = withPath(bin, async () => {
		const { execute, cleanup } = harness();
		const r = await execute({ tasks: [
			{ agent: "codex", task: "good" },
			{ agent: "codex", task: "bad" },
		] });
		assert.match(r.content[0].text, /Parallel: 1\/2 succeeded/);
		assert.match(r.content[0].text, /\[codex\] failed/);
		assert.match(r.content[0].text, /\[codex\] completed/);
		cleanup();
	});
	await run();
	rmSync(bin, { recursive: true, force: true });
});

// ── output cap ──────────────────────────────────────────────────────────
test("parallel summary truncates oversized output with marker", async () => {
	const big = "x".repeat(60 * 1024);
	const bin = makeShims({
		codex: `echo '{"type":"item.completed","item":{"type":"agent_message","text":"${big}"}}'`,
	});
	const run = withPath(bin, async () => {
		const { execute, cleanup } = harness();
		const r = await execute({ tasks: [{ agent: "codex", task: "big" }] });
		assert.match(r.content[0].text, /\[Truncated \d+ bytes/);
		cleanup();
	});
	await run();
	rmSync(bin, { recursive: true, force: true });
});

// ── renderers ───────────────────────────────────────────────────────────
test("renderCall: chain/parallel/single labels", () => {
	const { cap, cleanup } = harness();
	const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
	let t: any = cap.def.renderCall({ agent: "codex", task: "x".repeat(100) }, theme);
	assert.match(t.text, /codex/);
	t = cap.def.renderCall({ tasks: [{ agent: "codex", task: "1" }, { agent: "codex", task: "2" }] }, theme);
	assert.match(t.text, /parallel \(2 tasks\)/);
	t = cap.def.renderCall({ chain: [{ agent: "codex", task: "1" }, { agent: "codex", task: "2" }] }, theme);
	assert.match(t.text, /chain \(2 steps\)/);
	cleanup();
});

test("renderResult: empty details falls back to content text", () => {
	const { cap, cleanup } = harness();
	const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
	const out: any = cap.def.renderResult({ content: [{ type: "text", text: "fallback" }], details: undefined }, { expanded: false }, theme);
	assert.match(out.text, /fallback/);
	cleanup();
});
