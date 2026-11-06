# Gantrix

Open-source agents that work a plan like a Gantt chart.

You create **agents**, give each one or more **skills**, and hand Gantrix a **goal**. A planner
breaks the goal into steps with dependencies. Workers run every step whose dependencies are
done, in parallel. A judge checks each result against the step's acceptance criterion, and the
loop retries, replans or asks you for approval until the goal is met or a budget runs out.
Everything runs on your machine with open-source models.

```
 Web dashboard ─┐   REST + live events (SSE)
 CLI ───────────┼──► Fastify API ──► Postgres: agents, skills, tasks, steps, events, checkpoints
                │         │ start / approve / cancel
                │         ▼
                │   Supervisor (LangGraph): checks the database on every tick,
                │     ▲ tick            schedules ready steps, then sleeps
                │     │                 │
                │   Valkey + BullMQ ◄───┘ jobs: plan · step · goal check
                │                         │
                └── approvals ◄────────── Workers: LangGraph agent per step
                                           tools from SKILL.md + MCP · judge
                                           │
                                         Ollama (or any OpenAI-compatible server)
```

Stack: Node 26, TypeScript 7, LangGraph.js, BullMQ on Valkey, Postgres 18, Fastify,
React + Vite, Ollama. Every dependency is MIT, Apache-2.0, BSD or ISC licensed.

## Quick start

You need Node 26 (`nvm use` reads `.nvmrc`), Docker, and [Ollama](https://ollama.com).

```bash
npm install
cp .env.example .env
sed -i '' "s/^GANTRIX_TOKEN=$/GANTRIX_TOKEN=$(openssl rand -hex 32)/" .env   # macOS sed
npm run infra:up          # Postgres 18 on 127.0.0.1:15432, Valkey 9 on 127.0.0.1:16379
npm run db:migrate
ollama pull qwen3:8b      # the default model; any Ollama model works
```

Run these three in separate terminals:

```bash
npm run dev:api           # http://127.0.0.1:4700
npm run dev:worker        # runs plans, steps and judges
npm run dev:web           # dashboard at http://127.0.0.1:4701 (paste GANTRIX_TOKEN once)
```

Add a skill and two agents, then give it a goal:

```bash
npm run gantrix -- skills add examples/skills/workspace-files
npm run gantrix -- agents add researcher -d "Collects facts and writes notes" -s workspace-files --max-concurrency 2
npm run gantrix -- agents add editor -d "Turns notes into a polished summary" -s workspace-files
npm run gantrix -- run "Write tea.md and coffee.md with 3 facts each, then compare.md with a table"
```

`run` follows the task live and ends with a Gantt chart:

```
✔ research_tea       │███████████████████████████████                 │  42.6s  researcher
✔ research_coffee    │███████████████████████████████                 │  43.5s  researcher
✔ compare_tea_coffee │                               ░████████        │  11.1s  editor
                     0                                               1m6s
```

## How a task runs

1. **Plan.** The planner sees the goal, every agent's description and tools, and (when
   replanning) the steps already finished and why the last plan fell short. Its plan is
   validated (unknown agents, missing dependencies, cycles); problems go back to it, up to 3 tries.
2. **Schedule.** The supervisor starts every step whose dependencies succeeded, within each
   agent's `maxConcurrency` and the worker's model slots (`GANTRIX_LLM_CONCURRENCY`).
3. **Run.** The step's agent works with its skills' tools inside the task workspace
   (`~/.gantrix/workspaces/<task>`), up to 25 model turns.
4. **Judge.** A judge model (with thinking on) checks the reply and the files the step wrote
   against the step's "done when" criterion. A rejected step retries with the judge's feedback,
   up to `maxStepAttempts`.
5. **Replan.** A step that runs out of attempts triggers a new plan once running steps finish.
   Finished steps are kept, and the new plan builds on them.
6. **Goal check.** When every step has passed, the judge checks the goal itself; if it isn't
   met, that's another replan.

A task ends as `succeeded`, `needs_attention` (a budget ran out: tokens, minutes or replans),
`failed` (planning failed, or a system error) or `cancelled`.

Everything is durable. Kill the worker mid-step and restart it: the step continues from its last
LangGraph checkpoint, and the supervisor heals anything that was half-scheduled.

## Skills

A skill is a folder with a `SKILL.md`. Plain Claude-style skills (just `name` and
`description`) work as instruction-only skills; Gantrix adds optional keys:

```markdown
---
name: web-researcher            # lowercase letters, digits, dashes
description: Finds and summarises sources on the web.
version: 1.0.0                  # optional, default 0.0.0
tools: [web_fetch, write_file]  # optional built-in tools
mcp-servers:                    # optional MCP servers, started for each step
  search: { command: npx, args: [-y, some-search-mcp], env: { REGION: us } }
auto-approve: [web_fetch]       # optional; tools that run without asking (never shell)
---
Instructions the agent gets whenever it has this skill…
```

Built-in tools:

| Tool | What it does | Approval |
|---|---|---|
| `read_file`, `write_file`, `list_files` | Text files inside the task workspace only (symlinks included) | never |
| `web_fetch` | Public http(s) pages; refuses local and private addresses | asks, unless a skill auto-approves it |
| `shell` | `/bin/sh -c` in the workspace, 120 s timeout, minimal environment | **always asks** |

MCP tools are named `<server>_<tool>` (for example `search_query`) and ask for approval
unless listed in `auto-approve`.

Installing a skill (`gantrix skills add <folder>` or the Skills page) copies it to
`~/.gantrix/skills/<name>/<version>` and records a checksum. Gantrix checks the checksum before
every step, so editing your original folder doesn't change what runs; bump `version` and
install again instead.

## Approvals and safety

- A tool call that needs approval pauses only that step: the worker slot is freed, the call
  shows up in the dashboard (Approvals) and in `gantrix tail`, and the step resumes from the
  same point when you decide. A denied call tells the agent it was denied.
- **`shell` is not sandboxed.** It can do anything your user can, which is why it always asks.
  Read the command before approving it.
- Treat fetched web pages and MCP results as untrusted: an agent can be talked into asking for
  something harmful, and approval is where you catch it.
- The API listens on `127.0.0.1` and needs `Authorization: Bearer $GANTRIX_TOKEN` on every
  request. Tokens are never accepted in URLs, and request logs omit query strings.
- Shell commands and MCP servers don't inherit the server's environment, so they can't read
  the token or the database URL.

## CLI

```
gantrix agents [list | add <name> [-d text] [-s skills] [-m model] [--max-concurrency n] | rm <name>]
gantrix skills [list | add <folder> | rm <name[@version]>]
gantrix run "<goal>" [--max-minutes n] [--max-tokens n] [--max-replans n] [--detach]
gantrix tasks | show <task> [--all] | tail <task> | cancel <task> | files <task> [path]
gantrix approvals | approve <id> | deny <id>
```

`<task>` is `last`, a full id, or the short id `gantrix tasks` prints. `tail` asks about
approvals right in the terminal. The CLI reads `GANTRIX_TOKEN` (and `GANTRIX_URL`) from the
environment or the repo's `.env`.

## Models

`GANTRIX_DEFAULT_MODEL` (default `qwen3:8b`) plans and judges, and runs agents that don't set
their own model. Per agent, `model` can be any Ollama model, or `openai/<model>` with a
`modelBaseUrl` for any OpenAI-compatible server (vLLM, llama.cpp, LM Studio).

Small local models plan conservatively (often one step after another) and judge
imperfectly; a larger model gives better plans and fewer false rejections.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | Compose ports | Postgres and Valkey |
| `GANTRIX_TOKEN` | — | API token, at least 32 characters (required by the API) |
| `GANTRIX_HOST`, `GANTRIX_PORT` | `127.0.0.1`, `4700` | API address |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Default model server |
| `GANTRIX_DEFAULT_MODEL` | `qwen3:8b` | Planner, judge and default agent model |
| `GANTRIX_LLM_CONCURRENCY` | `2` | Model calls in flight per worker |
| `GANTRIX_WORKSPACES_DIR`, `GANTRIX_SKILLS_DIR` | `~/.gantrix/…` | Where task files and skills live |
| `GANTRIX_MAX_STEP_ATTEMPTS`, `_MAX_REPLANS`, `_MAX_TOKENS`, `_MAX_MINUTES` | 3, 5, 200000, 60 | Default budgets per task |

## Development

```bash
npm run typecheck && npm run lint
npm test              # unit tests
npm run test:e2e      # the real engine against Compose, with a fake Ollama (no GPU needed)
```

The end-to-end tests use their own database (`gantrix_test`) and Valkey DB 2, so they don't
touch your data.

Layout: `apps/server` (API, engine, worker), `apps/cli`, `apps/web`, `packages/shared`
(types shared by all three), `examples/skills`.

## License

MIT
