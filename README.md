# pi-external-agent

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
pi install git:github.com/keen99/pi-external-agent
```

## License

MIT
