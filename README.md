<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/assets/wordmark-dark.png">
    <img src="site/assets/wordmark-light.png" alt="Gantrix: a cartoon critter made of three Gantt bars, next to the word Gantrix" width="460">
  </picture>
</p>

<p align="center"><b>Open-source AI agents that work a plan like a Gantt chart, on your own machine.</b></p>

You create **agents**, give each one or more **skills**, and hand Gantrix a **goal**. A planner
splits the goal into steps that depend on each other. Steps that are ready run in parallel. A
judge checks every result, and Gantrix retries, replans or asks for your approval until the goal
is met or a budget runs out.

```
✔ research_tea       │███████████████████████████████                 │  42.6s  researcher
✔ research_coffee    │███████████████████████████████                 │  43.5s  researcher
✔ compare_tea_coffee │                               ░████████        │  11.1s  editor
                     0                                               1m6s
```

**Site:** [`site/index.html`](site/index.html) has an overview and the same getting-started steps.
The mascot is Gant; the logo files are in [`site/assets`](site/assets).

---

## Get started

About 10 minutes, most of it downloading the model.

### 1. Install the prerequisites

| You need | Check with | Get it |
|---|---|---|
| Node.js 26.13 or newer | `node -v` | `nvm install` (the repo has an `.nvmrc`) |
| Docker (running) | `docker info` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [OrbStack](https://orbstack.dev) |
| Ollama (running) | `ollama list` | [ollama.com](https://ollama.com), then `ollama serve` or open the app |

On a Mac, run Ollama natively, not in Docker: Docker on a Mac can't use the GPU.

### 2. Install and configure

```bash
git clone git@github.com:PerDiemInc/gantrix.git && cd gantrix
nvm use
npm install
npm run setup          # creates .env with a random API token
npm run infra:up       # Postgres on 127.0.0.1:15432 and Valkey on 127.0.0.1:16379
npm run db:migrate     # prints "Migrations applied."
ollama pull qwen3:8b   # the default model, about 5 GB
```

### 3. Start Gantrix

Open three terminals in the repo and run one command in each:

```bash
npm run dev:api        # the API on http://127.0.0.1:4700
npm run dev:worker     # runs the plans, steps and judges; prints "Gantrix worker ready"
npm run dev:web        # the dashboard on http://127.0.0.1:4701
```

Open http://127.0.0.1:4701. It asks for your token once; print it with `npm run token`.

### 4. Add a skill and two agents

```bash
npm run gantrix -- skills add examples/skills/workspace-files
npm run gantrix -- agents add researcher -d "Collects facts and writes notes" -s workspace-files --max-concurrency 2
npm run gantrix -- agents add editor -d "Turns notes into a polished summary" -s workspace-files
```

The planner reads each agent's description to decide who does what, so make it specific.
You can also do this on the dashboard's Skills and Agents pages.

### 5. Run your first task

```bash
npm run gantrix -- run "Write tea.md and coffee.md with 3 facts each, then compare.md with a table"
```

You'll see the plan, each step start and finish, and a Gantt chart at the end. The files are in
the task's workspace:

```bash
npm run gantrix -- files last               # list them
npm run gantrix -- files last compare.md    # print one
```

Or watch it on the dashboard: Tasks, then the task.

### Troubleshooting

| You see | Fix |
|---|---|
| `Can't reach the Gantrix API` | Start `npm run dev:api`. |
| `The API rejected the token` | The CLI reads `.env` in the repo; the dashboard: Forget token, then paste `npm run token`. |
| A task stays at `planning` | Start `npm run dev:worker`. |
| Steps fail with `fetch failed` or `model not found` | Start Ollama (`ollama serve`) and pull the model (`ollama pull qwen3:8b`). |
| `port is already allocated` on `infra:up` | Something else uses 15432 or 16379; stop it or change the ports in `docker-compose.yml` and `.env`. |
| `Create at least one agent` | Do step 4 first. |

---

## How a task runs

1. **Plan.** The planner sees the goal and every agent's description and tools. Its plan is
   checked for unknown agents, missing dependencies and cycles; problems go back to it (3 tries).
2. **Schedule.** Every step whose dependencies are done starts, within each agent's
   `--max-concurrency` and the worker's model slots (`GANTRIX_LLM_CONCURRENCY`).
3. **Run.** The agent works with its skills' tools in the task's folder
   (`~/.gantrix/workspaces/<task>`), up to 25 model turns.
4. **Judge.** A judge model checks the reply and the files the step wrote against the step's
   "done when" criterion. A rejected step tries again with the feedback (3 attempts).
5. **Replan.** A step that runs out of attempts triggers a new plan. Finished steps are kept.
6. **Goal check.** When every step has passed, the judge checks the goal itself; if it isn't
   met yet, Gantrix replans.

A task ends as `succeeded`, `needs_attention` (a budget ran out), `failed` (planning failed or
a system error) or `cancelled`. Budgets per task: `--max-minutes`, `--max-tokens`,
`--max-replans`.

Restarting the worker is safe: a step continues from its last checkpoint.

```
 Dashboard ─┐   REST + live events
 CLI ───────┼──► API ──► Postgres (tasks, steps, events, checkpoints)
            │     │
            │   Supervisor: on every change, starts the steps that are ready
            │     │
            │   Valkey queue ──► Workers: one agent per step · tools · judge ──► Ollama
            └── approvals ◄──────┘
```

Stack: Node 26, TypeScript 7, LangGraph.js, BullMQ on Valkey, Postgres 18, Fastify,
React + Vite, Ollama. Every dependency is MIT, Apache-2.0, BSD or ISC licensed.

## Skills

A skill is a folder with a `SKILL.md`. A plain Claude skill (just `name` and `description`) works
as an instruction-only skill. Gantrix adds optional keys:

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
Instructions the agent gets whenever it has this skill.
```

| Built-in tool | What it does | Needs approval |
|---|---|---|
| `read_file`, `write_file`, `list_files` | Text files in the task's folder only | no |
| `web_fetch` | Public web pages; refuses local and private addresses | yes, unless a skill auto-approves it |
| `shell` | A shell command in the task's folder, 2-minute limit | **always** |

MCP tools are named `<server>_<tool>` (for example `search_query`) and need approval unless a
skill lists them in `auto-approve`.

Three examples are in [`examples/skills`](examples/skills): `workspace-files`,
`shell-commands` and `web-reader`.

Installing a skill copies it to `~/.gantrix/skills/<name>/<version>` and records a checksum, so
editing your original folder doesn't change what runs. To update a skill, bump its `version`
and install it again.

## Approvals and safety

- When a step needs approval, only that step pauses. Decide on the dashboard's Approvals page,
  in `gantrix tail <task>` (it asks `Approve? [y/N]`), or with `gantrix approve <id>` /
  `gantrix deny <id>`.
- **`shell` is not sandboxed.** It can do anything your user account can. Read every command
  before you approve it.
- Web pages and MCP results can contain text that tries to steer the agent. Approval is where
  you catch that.
- The API listens on `127.0.0.1` only and needs the token on every request.
- Shell commands and MCP servers don't get the server's environment, so they can't read the
  token or the database password.

## CLI

```
gantrix agents [list | add <name> [-d text] [-s skills] [-m model] [--max-concurrency n] | rm <name>]
gantrix skills [list | add <folder> | rm <name[@version]>]
gantrix run "<goal>" [--max-minutes n] [--max-tokens n] [--max-replans n] [--detach]
gantrix tasks | show <task> [--all] | tail <task> | cancel <task> | files <task> [path]
gantrix approvals | approve <id> | deny <id>
```

Run it as `npm run gantrix -- <command>`. `<task>` is `last`, a full ID, or the short ID that
`gantrix tasks` prints.

## Models

`GANTRIX_DEFAULT_MODEL` (default `qwen3:8b`) plans and judges, and runs agents that don't set
their own model. An agent's `--model` can be any Ollama model, or `openai/<model>` with a base
URL for any OpenAI-compatible server (vLLM, llama.cpp, LM Studio).

Small models tend to plan steps one after another and sometimes reject good work. A larger model
plans more parallel steps and judges more accurately.

## Configuration

All settings are environment variables in `.env`; see [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | Compose ports | Postgres and Valkey |
| `GANTRIX_TOKEN` | set by `npm run setup` | API token, at least 32 characters |
| `GANTRIX_HOST`, `GANTRIX_PORT` | `127.0.0.1`, `4700` | API address |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Default model server |
| `GANTRIX_DEFAULT_MODEL` | `qwen3:8b` | Planner, judge and default agent model |
| `GANTRIX_LLM_CONCURRENCY` | `2` | Model calls at once per worker |
| `GANTRIX_WORKSPACES_DIR`, `GANTRIX_SKILLS_DIR` | `~/.gantrix/…` | Where task files and skills live |
| `GANTRIX_MAX_STEP_ATTEMPTS`, `_MAX_REPLANS`, `_MAX_TOKENS`, `_MAX_MINUTES` | 3, 5, 200000, 60 | Default budgets per task |

## Development

```bash
npm run typecheck && npm run lint
npm test              # unit tests
npm run test:e2e      # the real engine against Docker, with a fake model (no GPU needed)
```

The end-to-end tests use their own database (`gantrix_test`) and Valkey DB 2, so they don't
touch your data.

Layout: `apps/server` (API, engine, worker), `apps/cli`, `apps/web` (dashboard),
`packages/shared` (types used by all three), `examples/skills`, `site` (the overview page).

## License

MIT
