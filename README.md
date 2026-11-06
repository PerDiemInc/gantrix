<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/assets/wordmark-dark.png">
    <img src="site/assets/wordmark-light.png" alt="Gantrix: a cartoon critter made of three Gantt bars, next to the word Gantrix" width="460">
  </picture>
</p>

<p align="center"><b>Open-source AI agents that work a plan like a Gantt chart, on your own machine.</b></p>

**Gantrix is an open-source, local-first AI agent orchestrator.** Give it a goal and agents with
skills (SKILL.md folders and MCP servers). It plans dependent steps, runs the ready ones in
parallel on Ollama models, has a judge check each result, and asks you before risky tools run.
It retries and replans until the goal is met or a budget runs out.

```
✔ research_tea       │███████████████████████████████                 │  42.6s  researcher
✔ research_coffee    │███████████████████████████████                 │  43.5s  researcher
✔ compare_tea_coffee │                               ░████████        │  11.1s  editor
                     0                                               1m6s
```

**Site:** https://perdieminc.github.io/gantrix/ has an overview and the same getting-started steps.
Compare: [Gantrix vs CrewAI](https://perdieminc.github.io/gantrix/vs/crewai/) ·
[Gantrix vs LangGraph.js](https://perdieminc.github.io/gantrix/vs/langgraph/).
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

To see what each agent was told, what it answered and every tool call it made, open **Logs**
on the task page, or click "View conversation" on a step. You can also print it in the terminal:

```bash
npm run gantrix -- logs last                # every step
npm run gantrix -- logs last compare_facts  # one step; add --full for system prompts and thinking
```

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

Examples are in [`examples/skills`](examples/skills): `workspace-files`, `shell-commands`,
`web-reader`, and `media-images` / `media-video` (see below).

Installing a skill copies it to `~/.gantrix/skills/<name>/<version>` and records a checksum, so
editing your original folder doesn't change what runs. To update a skill, bump its `version`
and install it again.

## The executive team (optional)

One command adds five ready-made agents, each with its own skill:

```bash
npm run gantrix -- team add                 # or: team add --only cto,cpo   (-m <model> for all)
npm run gantrix -- run "CPO: plan the v2 launch; CTO: estimate the work; CMO: write the launch post"
```

| Agent | Skill | Does | Tools |
|---|---|---|---|
| `cto` | `exec-cto` | Architecture decisions (ADRs), code reviews, build plans, technical risks | files, web, shell |
| `cmo` | `exec-cmo` | Positioning, campaign plans, launch posts, landing-page copy, SEO briefs | files, web |
| `cro` | `exec-cro` | Customer profiles, lead lists from public pages, cold email and SMS drafts, sends email | files, web, outreach |
| `ciso` | `exec-ciso` | Threat models, code and dependency audits, config checks, authorized tests of your own systems | files, web, shell |
| `cpo` | `exec-cpo` | PRDs, priorities, milestone timelines with a Mermaid gantt, risks, status updates | files |

It's safe to run again: existing agents are left as they are. The skills are plain folders in
`examples/skills/exec-*`; copy one, edit it, bump its version and install your own.

**Things to know:**
- Shell commands from the CTO and CISO always wait for your approval.
- The CISO only tests what the task names as yours. Anything else goes under "Not tested".
- The skills are written for small local models. Ask for one deliverable per step.

**Sending email from the CRO.** The CRO drafts by default. To let it send one-to-one email from
your own mailbox:

```bash
npm run outreach:link                       # makes the gantrix-outreach-mcp command available
cat > ~/.gantrix/outreach.env <<'ENV'
SMTP_URL=smtps://you%40example.com:app-password@smtp.example.com:465
OUTREACH_FROM=Your Name <you@example.com>
OUTREACH_POSTAL_ADDRESS=Your Company, 1 Main St, City, ST 00000
ENV
chmod 600 ~/.gantrix/outreach.env
```

- Every email waits for your approval, one recipient at a time.
- Each one gets an unsubscribe line, your postal address and a `List-Unsubscribe` header
  (US CAN-SPAM). Check the rules where your recipients live, such as GDPR or CASL.
- `OUTREACH_DAILY_LIMIT` (default 25) caps sends per day.
- A person gets at most three emails, and never after they're added to the do-not-contact list.
  That list is `~/.gantrix/outreach/do-not-contact.txt`; one address or `@domain` per line.
- Every send is logged to `~/.gantrix/outreach/sent.csv`.
- SMS stays draft-only. Texting people who haven't agreed to it is illegal in the US (TCPA).

## Images and video (optional)

Agents can create images and short video clips with open models on your own machine. Gantrix
runs them through a local [ComfyUI](https://github.com/Comfy-Org/ComfyUI), which stays a
separate program, so nothing here changes Gantrix's MIT licence.

| Model | Makes | Licence | Time on a 48 GB M5 Pro |
|---|---|---|---|
| `z-image-turbo` | PNG images from text, or variations of an image | Apache-2.0 | about 30 s for 1024×576 |
| `wan-2.2-5b` | MP4 clips (no sound) from text or a start image | Apache-2.0 | per 2 s clip: `fast` 640×352 ~1.5 min, `standard` 832×480 ~3.5 min, `high` 1280×704 ~12 min |

**Set it up** (tested on Apple Silicon with 48 GB; about 21 GB of downloads per model):

```bash
npm run comfyui:setup -- all     # or: images | video. Installs ComfyUI v0.42.1 in ~/ComfyUI
cd ~/ComfyUI && .venv/bin/python main.py --listen 127.0.0.1 --port 8188   # keep it running
npm run media:link               # makes the gantrix-media-mcp command available to skills
npm run gantrix -- skills add examples/skills/media-images
npm run gantrix -- skills add examples/skills/media-video
npm run gantrix -- agents add artist -d "Creates images and short video clips" -s media-images,media-video
```

**How it works:**
- The skills start the `gantrix-media-mcp` server. It gives agents `generate_image`,
  `generate_video` and `list_media_models`, and saves the files in the task's folder.
- Images run without asking. Each video clip asks for your approval, because it takes minutes.
- You choose the models per skill with `MEDIA_MODELS`. The agent picks among them per call.

**Settings** (in a skill's `mcp-servers` → `env`):

| Setting | Default | Meaning |
|---|---|---|
| `MEDIA_MODELS` | `z-image-turbo` | Which models this skill can use, comma-separated |
| `MEDIA_DEFAULT_IMAGE`, `MEDIA_DEFAULT_VIDEO` | the first enabled | Default model per kind |
| `MEDIA_VIDEO_QUALITY` | `standard` | `fast`, `standard` or `high` |
| `MEDIA_UNLOAD_AFTER` | `true` | Free ComfyUI's RAM after each job; set `false` for faster back-to-back jobs |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | Where ComfyUI runs |
| `MEDIA_ACCEPT_LICENSES` | empty | Models that aren't open source can only be enabled by listing them here |

**Good to know:**
- `high` video needs more than 48 GB of RAM to avoid swapping. On a 48 GB Mac, use `standard`.
- Image variations keep the layout and colours up to strength 0.8. They can't keep a character
  while changing the scene; animating an image with `generate_video` does keep it.
- Any model that isn't OSI open source shows a ⚠ warning with its usage limits wherever it
  appears, and stays off until it's listed in `MEDIA_ACCEPT_LICENSES`.
- LTX-2 was tried and dropped: running LTX Desktop next to ComfyUI used more RAM than a 48 GB
  Mac has.

## Approvals and safety

- When a step needs approval, only that step pauses. Decide on the dashboard's Approvals page,
  in `gantrix tail <task>` (it asks `Approve? [y/N]`), or with `gantrix approve <id>` /
  `gantrix deny <id>`.
- **God mode** skips every approval for one task: `gantrix run --approve-all "…"`, or tick
  ⚡ God mode on the dashboard. Shell commands, web requests, MCP tools and emails then run
  without asking. Each such call is still logged and marked ⚡ auto-approved. To make it the
  default for every task, set `GANTRIX_APPROVE_ALL=true`. It's off by default; use it only with
  goals and skills you trust.
- **`shell` is not sandboxed.** It can do anything your user account can. Read every command
  before you approve it.
- Web pages and MCP results can contain text that tries to steer the agent. Approval is where
  you catch that.
- The API listens on `127.0.0.1` only and needs the token on every request.
- Shell commands and MCP servers don't get the server's environment, so they can't read the
  token or the database password.

## CLI

```
gantrix agents [list | add <name> [-d text] [-s skills] [-m model] [-c connection] [--max-concurrency n] | rm <name>]
gantrix connections [list | add <name> -p ollama|openai|anthropic [-u url] [-H "Name: value"…] [--api-key-env NAME] | test <name> <model> | rm <name>]
gantrix skills [list | add <folder> | rm <name[@version]>]
gantrix team add [--only cto,cmo,cro,ciso,cpo] [-m model]
gantrix run "<goal>" [--max-minutes n] [--max-tokens n] [--max-replans n] [--approve-all] [--detach]
gantrix tasks | show <task> [--all] | tail <task> | logs <task> [step] [--full] | cancel <task> | files <task> [path]
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

### Connections: OpenAI, Anthropic, any URL, local or cloud

A connection saves where a model server is and how to log in to it. Give an agent one with
`--connection`, and its `--model` is then that server's model name.

```bash
# Cloud APIs; the key is read from the worker's environment (.env), never stored.
npm run gantrix -- connections add openai --provider openai --api-key-env OPENAI_API_KEY
npm run gantrix -- connections add claude --provider anthropic --api-key-env ANTHROPIC_API_KEY

# Anything local or custom: a URL plus any headers.
npm run gantrix -- connections add lmstudio --provider openai --url http://127.0.0.1:1234/v1
npm run gantrix -- connections add gateway --provider anthropic --url https://llm.internal.example \
  -H "Authorization: Bearer env:GATEWAY_TOKEN" -H "X-Team: research"

npm run gantrix -- connections test claude claude-sonnet-5-5     # sends one short prompt
npm run gantrix -- agents add writer -s workspace-files -c claude -m claude-sonnet-5-5
```

| Provider | Default URL | Works with |
|---|---|---|
| `ollama` | `OLLAMA_BASE_URL` | Ollama, local or behind a proxy |
| `openai` | `https://api.openai.com/v1` | OpenAI, and OpenAI-compatible servers: vLLM, llama.cpp, LM Studio, LiteLLM, OpenRouter |
| `anthropic` | `https://api.anthropic.com` | Anthropic, and Anthropic-compatible gateways |

**How headers work:**
- A header value of `env:NAME` (or `Bearer env:NAME`) is read from the worker's environment
  when a step runs. Put the key in `.env` and restart the API and worker.
- Any other value is saved in your local database and never returned by the API.
- `Authorization: Bearer …` and `x-api-key` go to each SDK's key setting. Without either, the
  SDKs read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` themselves.

**Using a connection for everything.** To have the planner and judge use a connection too, set
`GANTRIX_DEFAULT_CONNECTION=<name>` and `GANTRIX_DEFAULT_MODEL=<that server's model>`.

A connection whose URL isn't on this machine or your network is marked **cloud**. Prompts and
task content then go to that service, and its prices apply.

## Configuration

All settings are environment variables in `.env`; see [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | Compose ports | Postgres and Valkey |
| `GANTRIX_TOKEN` | set by `npm run setup` | API token, at least 32 characters |
| `GANTRIX_HOST`, `GANTRIX_PORT` | `127.0.0.1`, `4700` | API address |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Default model server |
| `GANTRIX_DEFAULT_MODEL` | `qwen3:8b` | Planner, judge and default agent model |
| `GANTRIX_DEFAULT_CONNECTION` | unset (Ollama) | A saved connection for the planner, judge and agents without their own |
| `GANTRIX_LLM_CONCURRENCY` | `2` | Model calls at once per worker |
| `GANTRIX_WORKSPACES_DIR`, `GANTRIX_SKILLS_DIR` | `~/.gantrix/…` | Where task files and skills live |
| `GANTRIX_MAX_STEP_ATTEMPTS`, `_MAX_REPLANS`, `_MAX_TOKENS`, `_MAX_MINUTES` | 3, 5, 200000, 60 | Default budgets per task |
| `GANTRIX_APPROVE_ALL` | `false` | God mode for every new task (tool calls run without asking) |

## Development

```bash
npm run typecheck && npm run lint
npm test              # unit tests
npm run test:e2e      # the real engine against Docker, with a fake model (no GPU needed)
```

The end-to-end tests use their own database (`gantrix_test`) and Valkey DB 2, so they don't
touch your data.

Layout: `apps/server` (API, engine, worker), `apps/cli`, `apps/web` (dashboard),
`packages/shared` (types used by all three), `packages/media-mcp` (image and video server),
`examples/skills`, `scripts` (setup), `site` (the website).

## License

MIT

---

<p align="center">Powered by <a href="https://tryperdiem.com"><b>Per Diem</b></a></p>
