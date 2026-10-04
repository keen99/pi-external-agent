# pi-external-agent

![release-watch](https://github.com/keen99/pi-external-agent/actions/workflows/release-watch.yml/badge.svg)
[![pi tested](https://img.shields.io/github/v/release/keen99/pi-external-agent?label=pi%20tested%200.75.0%20%E2%86%92)](https://github.com/keen99/pi-external-agent/releases)

A [pi](https://pi.dev) extension that adds an `external_agent` tool for delegating tasks to other agent CLIs as isolated background processes.

## Agents

| Name    | CLI          | Notes |
|---------|--------------|-------|
| `pi`    | pi           | Spawns pi with isolated context, no extensions, no session |
| `claude`| Claude Code  | Requires `claude` on `$PATH` |
| `codex` | Codex CLI    | Requires `codex` on `$PATH` |

## Modes

- **single** — `{ agent, task }`: one agent, one task.
- **parallel** — `{ tasks: [...] }`: up to 8 tasks, max 4 concurrent.
- **chain** — `{ chain: [...] }`: sequential; use `{previous}` placeholder to pass prior step's output.

## Params

| Param         | Applies to        | Description |
|---------------|-------------------|-------------|
| `agent`       | single            | `pi` \| `claude` \| `codex` |
| `task`        | single            | Task text |
| `tasks`       | parallel          | Array of single-style items |
| `chain`       | chain             | Array of items, `{previous}` substituted in `task` |
| `cwd`         | single            | Working directory |
| `model`       | single + per-item | Override model |
| `systemPrompt`| pi, claude        | Custom system prompt |
| `tools`       | pi                | Tools to enable (comma list) |

## Config

Agent availability can be restricted in `~/.pi/agent/settings.json` under
the `externalAgent` key:

```json
{
  "externalAgent": {
    "allow": ["pi", "claude"],
    "deny": ["codex"]
  }
}
```

- `allow` — allowlist. If set, only these agents are permitted.
- `deny` — denylist. Always excluded; wins over `allow`.

If neither is set, all three agents (`pi`, `claude`, `codex`) are available.
Disabled agents rejected at execution time with a clear error.

## Install

```bash
# ssh
pi install git:git@github.com:keen99/pi-external-agent

# https
pi install git:github.com/keen99/pi-external-agent
```

## Development

```sh
npm run check       # typecheck + unit tests (real subprocess PATH shims, no network)
npm run test:matrix # deep smoke on every published pi release >= 0.75.0
```

Unit tests drive the real tool via fake pi and REAL agent subprocesses:
bash shims on PATH emit canned stream-json for pi/claude/codex and
record argv, proving spawn, stream parsing, usage extraction, chain
{previous} substitution, chain fail-fast, parallel counting, allow/deny
enforcement, and model resolution — no network, no real CLIs. The
matrix boots each pinned pi release in RPC mode with the extension
loaded and asserts tool registration + settings-derived enabled set on
the real process. Cached installs live in `.matrix-cache/` and are
reused across runs; new pi releases are picked up automatically.

`EXTERNAL_AGENT_SETTINGS` overrides the settings path (tests are
hermetic — never reads your real settings.json), `EXTERNAL_AGENT_PI_BIN`
overrides the pi binary the runner spawns, `EXTERNAL_AGENT_DEBUG=1`
writes a load marker for the smoke, `PI_TEST_BIN` overrides the pi
binary in the matrix smoke.

## License

MIT
