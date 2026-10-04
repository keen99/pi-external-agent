#!/usr/bin/env node
// Deep pinned-pi smoke for the external-agent tool. Boots real pi in RPC
// mode with the extension loaded (EXTERNAL_AGENT_DEBUG=1) and asserts the
// tool registered with allow/deny enforcement derived from settings —
// marker records tool name + enabled agent set. Behavior (spawn, stream
// parse, modes) is covered by unit tests with real PATH-shim subprocesses;
// here we prove the real pi accepts the tool and computes the enabled set.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-ext-agent-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
// Deliberately permissive + distinctive: deny codex so the marker proves
// settings were actually read by the real process, not defaulted.
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mocktest', defaultModel: 'mock-model', externalAgent: { deny: ['codex'] } }, null, 2) + '\n');
const MARKER = join(agentDir, 'external-agent-loaded.json');

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, EXTERNAL_AGENT_DEBUG: '1', EXTERNAL_AGENT_SETTINGS: join(agentDir, 'settings.json') }, cwd: dir },
);
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const t0 = Date.now();
const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
const poll = setInterval(() => {
	if (existsSync(MARKER)) {
		clearInterval(poll);
		finish(true);
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(poll);
		finish(false);
	}
}, 200);

function finish(ok) {
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(killTimer);
		try {
			assert2(ok, `timed out; stderr tail: ${err.slice(-800)}`);
			const m = JSON.parse(readFileSync(MARKER, 'utf8'));
			assert2(m.loaded === true, `loaded flag: ${JSON.stringify(m)}`);
			assert2(m.tool === 'external_agent', `tool name: ${JSON.stringify(m.tool)}`);
			assert2(JSON.stringify(m.enabled) === JSON.stringify(['pi', 'claude']), `enabled set honors deny:[codex]: ${JSON.stringify(m.enabled)}`);
			console.log(`Deep smoke PASS: real pi loaded external_agent; enabled=${JSON.stringify(m.enabled)} (${(Date.now() - t0) / 1000 | 0}s).`);
		} catch (e) {
			console.error('FAIL', e.message);
			console.error(`stdout tail: ${out.slice(-400)}`);
			process.exitCode = 1;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
