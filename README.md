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

### See it

<p align="center"><img src="site/assets/screenshots/projects.webp" alt="The Projects page with Projects, Jobs and Running agents tabs, New Project and New Job buttons and project cards with progress bars and agent avatars" width="900"></p>

<details>
<summary><b>More screenshots</b>: a project page, the task board with sub-agents, New project, offloading, New Job, Agents</summary>

**A project, its team and its questions.** Name, description and OKR goal, budgets you can extend, Stop and Cancel, and a question an agent asked you with options to pick.

<img src="site/assets/screenshots/project.webp" alt="The Crumb & Co website project page: title with rename, Stop and Cancel buttons, token and time budgets, a question from the cpo agent with three answer options, the team panel and the chat" width="800">

**A task board with sub-agents.** To do, In progress, Needs you and Done. The devops lead waits while its aws-engineer sub-agent writes Terraform; designs show as previews below.

<img src="site/assets/screenshots/board.webp" alt="The task board: cards for each task with assignee avatars, including a sub-task for aws-engineer marked as a sub-task of Set up hosting on AWS, and three design style previews below" width="800">

**Describe it, set an OKR, pick the team.** Name and description, a goal with an OKR example and Generate from description, the team, each member’s model and a time limit.

<img src="site/assets/screenshots/new-project.webp" alt="The New project form with numbered sections: name and description, goal with a Generate from description button, and the team picker with ten agents" width="800">

**Hand the work to Claude or ChatGPT.** One switch runs the team on the coding agents you already have on this machine, with your own login. The planner and judge stay on your default model.

<img src="site/assets/screenshots/offload.webp" alt="The Models section of the New project form: Run the work on set to ChatGPT, with cpo, designer and engineer each showing ChatGPT for this project, then a 3 hour time limit" width="800">

<img src="site/assets/screenshots/new-job.webp" alt="The New Job form: a name, description and goal, then ordered steps that each pick an agent, with a schedule" width="800">

**Save a repeatable job.** Ordered steps, each done by one agent, run on demand or on a cron schedule.

**Each agent on its own model.** Local Ollama by default; switch any agent to Claude Code, OpenAI, Anthropic or your own server.

<img src="site/assets/screenshots/agents.webp" alt="The Agents page: agent cards with Runs on, a time limit and Slack chat set up per agent, and the Add agent form" width="800">

</details>

Most screenshots come from a demo with a made-up bakery; Projects, New Job and Agents are from a local instance.

**Site:** https://perdieminc.github.io/gantrix/ has an overview and the same getting-started steps.
Compare: [Gantrix vs CrewAI](https://perdieminc.github.io/gantrix/vs/crewai/) ·
[Gantrix vs LangGraph.js](https://perdieminc.github.io/gantrix/vs/langgraph/).
Guide: [Run AI agents locally with Ollama](https://perdieminc.github.io/gantrix/local-ai-agents-ollama/).
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

**Fastest:** `./init.sh` installs nvm if missing, installs the Node version from `.nvmrc`, runs
`npm install`, starts Postgres and Valkey with Docker, applies migrations and starts the API,
worker and dashboard. Docker must be running. Then pull the model in another terminal
(`ollama pull qwen3:8b`) and skip to step 4.

```bash
git clone git@github.com:PerDiemInc/gantrix.git && cd gantrix
./init.sh
```

Or do it by hand:

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

If you didn't use `./init.sh`, one command does setup, infra, migrations and starts the API, worker and dashboard
(agents run on your local Ollama):

```bash
npm start
```

Or run each piece yourself. Open three terminals in the repo and run one command in each:

```bash
npm run dev:api        # the API on http://127.0.0.1:4700
npm run dev:worker     # runs the plans, steps and judges; prints "Gantrix worker ready"
npm run dev:web        # the dashboard on http://127.0.0.1:4701
```

Open http://127.0.0.1:4701. It asks for your token once; print it with `npm run token`.

### 4. Add a skill and two agents

A first start already adds a **starter team** (CTO, CMO, CRO, CISO, designer, engineer, CPO,
DevOps and the AWS and GCP engineers, each with its skills), so the Agents page isn't empty.
Press **Edit** on any agent to change its name, description, instructions and skills, or
**Remove** the ones you don't want; they don't come back. Skip this step if the starter team is
enough. To add your own:


```bash
npm run gantrix -- skills add examples/skills/workspace-files
npm run gantrix -- agents add researcher -d "Collects facts and writes notes" -s workspace-files --max-concurrency 2
npm run gantrix -- agents add editor -d "Turns notes into a polished summary" -s workspace-files
```

The planner reads each agent's description to decide who does what, so make it specific.
You can also do this on the dashboard's Skills and Agents pages. When you add an agent there,
pick where it runs and then a model from that server's list. Every agent gets a Gant avatar;
click it on the Agents page to pick another one, upload your own image, or use initials.

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

Or watch it on the dashboard. In the dashboard a run is a **project**, and its steps are the
**tasks** its agents work on:
- **Projects** shows every project at once. Each card has its status, the tasks done so far, the
  agents on it (a ring shows who is working or waiting for you), and what is happening now.
  Projects that need your approval stand out. Filter by running, needs you or finished.
- **A project's page** shows the progress, tokens and time, a "Working now" card for each busy
  agent, approvals, the Gantt timeline and the files. The chat runs beside them, or as a tab on
  a phone.

**Setting up a project.** The New project form has five parts:

1. **Name and description:** a short name, and what the project is, for whom, and what you
   already have.
2. **Goal:** an OKR works best, meaning one objective and 3 or 4 measurable key results. The box
   shows an example. **Generate from description** has the default model draft an OKR from your
   description for you to edit. The judge checks the finished work against the goal.
3. **Team:** the agents who work on it. None picked means all of them.
4. **Models:** **Run the work on** moves the whole team to Claude or ChatGPT on this machine
   (see [Offload to Claude or ChatGPT](#offload-to-claude-or-chatgpt-on-your-machine)). Or each
   team member uses its usual model, or **Change for this project** to pick
   another (for example local Claude Code) for this project only.
5. **Time limit:** 3 hours by default. You can add more while it runs.

With Slack set up, **Post to Slack** (on by default) gives the project a Slack thread; see
[Slack](#slack-optional).

On the command line: `gantrix run --name "Crumb site" --description "…" --agents cpo,designer,engineer
--max-minutes 180 "<goal>"`.

**More time while it runs.** Use **+15 min / +30 min / +1 h** under the budget meters, or run
`gantrix extend <project> --minutes 30`. If a project stopped because it ran out of time,
tokens or replans, **Continue** gives it more and picks up where it stopped. Finished tasks are
kept; tasks that were cut off run again. From the terminal: `gantrix extend last --minutes 30
--tokens 100000 --replans 2`.

**Your agents are the project's employees.** The **Team** panel shows each one with its role,
the model it runs on, what it's doing now (working on a task, waiting for you, up next or done)
and how many of its tasks are finished. Add or remove employees while the project runs; new
ones get work from the next plan or a reassigned task.

**Tasks on a board.** **Tasks** shows a board with To do, In progress, Needs you, Done and
Failed columns, each card showing who does it. Switch to **Timeline** for the Gantt chart.
Click any task to change its title, instructions, "done when" or who it's assigned to. Use **Run
again** to redo a finished or failed task; a finished or stopped project opens again for it. A
task in progress can't change, so message its agent instead.

**Which model each agent uses.** On the Agents page, every agent has **Runs on**: local Ollama by
default, or **Change** to any connection, such as OpenAI, Anthropic, a custom server, or your
local Claude Code (`claude -p`) for the agents that need a stronger model.

**Seeing the design work.** **Designs and images** on the project page shows a thumbnail of
every mockup under `design/` and `site/` and of every image. Click one to open it full size. When
the designer asks which style to build, the question shows a preview of each option.

**The chat reads like a meeting.** Next to the Gantt chart and the status, the planner, each
agent, the judge and you talk in turn. You can join in at any time:
- To one running step: the agent reads your note before its next turn.
- To everyone: once the running steps finish, the planner replans with your note and keeps the
  finished work. This replan doesn't use up the replan budget.

```bash
npm run gantrix -- say last "Also add a price comparison"           # to everyone
npm run gantrix -- say last --to research_tea "Use sources from 2025" # to one step
```

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
auto-approve: [web_fetch]       # optional; tools that run without asking (never shell or deploy_site)
---
Instructions the agent gets whenever it has this skill.
```

| Built-in tool | What it does | Waits for you |
|---|---|---|
| `read_file`, `write_file`, `list_files` | Text files in the project's folder (the step's own folder with isolated steps) | never |
| `web_fetch` | Public web pages; refuses local and private addresses | on projects that ask first, unless a skill auto-approves it |
| `shell` | A shell command in the task's folder, 2-minute limit | on projects that ask first (no skill can skip that) |
| `ask_user` | Asks you a question, optionally with answers to pick from, and waits for your reply | always waits for you |
| `deploy_site` | Publishes a workspace folder with an `index.html` on the local preview server (port 4702) | on projects that ask first |

MCP tools are named `<server>_<tool>` (for example `search_query`) and need approval on
ask-first projects unless a skill lists them in `auto-approve`. No skill can waive `shell`
or `deploy_site`.

Examples are in [`examples/skills`](examples/skills): `workspace-files`, `shell-commands`,
`web-reader`, and `media-images` / `media-video` (see below).

Installing a skill copies it to `~/.gantrix/skills/<name>/<version>` and records a checksum, so
editing your original folder doesn't change what runs. To update a skill, bump its `version`
and install it again.

### Find and install a skill from the web

On **Skills → Install a skill**, there are two ways to find one online, and both end at the same
review.

**Search online** looks in several places at once, and you choose which:

| Source | What it searches | Needs |
|---|---|---|
| **skills.sh** | The [skills.sh](https://skills.sh) directory, ranked by installs | nothing |
| **Featured collections** | The skills in Anthropic's [`anthropics/skills`](https://github.com/anthropics/skills) and in this project's [`examples/skills`](examples/skills), listed from the repositories themselves | nothing |
| **GitHub repositories** | Repositories tagged `agent-skills` or `claude-skills`, or mentioning `SKILL.md` in their readme, by stars | nothing |
| **Inside GitHub repos** | `SKILL.md` files on GitHub whose text matches | a GitHub connection: GitHub only allows code search with a token |

With nothing typed, it shows the featured collections. A source that can't answer (a rate limit,
no token, skills.sh down) says so and the others still do. If you have a **GitHub connection**
(Connections), its token is used for GitHub's search and lookups: a much higher rate limit, and
it enables the code search. It is sent only to `api.github.com`, never to skills.sh or to the
file downloads. skills.sh's search is an unofficial, undocumented endpoint, so it may change;
some of its results come from other registries and can't be installed from GitHub, which it says.

**From a link** takes a paste instead:

- a GitHub **repository** (it lists the skills inside, and you pick one),
- a **folder** in one: `https://github.com/owner/repo/tree/main/skills/my-skill`,
- a skill's **`SKILL.md`** on GitHub, or a direct `https://…/SKILL.md` link,
- a **skills.sh page**: `https://skills.sh/anthropics/skills/frontend-design`. The link names the
  skill but not its folder, so Gantrix finds the folder with that name in the repository (and
  asks you to pick if there are several).

Gantrix downloads it to a holding area and **shows you what it would install before anything is
installed**: the description, where it is from, every file, the instructions the agent will
follow, and in plain words what it can do on your machine: run shell commands, start programs
(the exact command, for example `npx -y some-mcp`), run tools without asking, and any bundled
scripts. You tick *I have read what this skill can do* and press Install. What you installed is
exactly what you were shown: the files are checksummed, and the install is refused if they
changed. Nothing is run when a skill is installed; it can only do things once an agent that has
it runs a step.

```bash
npm run gantrix -- skills search "frontend design"       # every source; --sources skills-sh,github
npm run gantrix -- skills add https://skills.sh/anthropics/skills/frontend-design
# shows the same review, then asks "Install it? [y/N]"  (--yes skips the question)
```

Skills from GitHub are **pinned to the commit you reviewed** and recorded with their source, so
the Skills page says where each one came from. A skill is code an agent can run, so only install
ones you trust. The limits keep it small and plain: GitHub or a direct `SKILL.md` link over
https (never a private or local address), text files only, at most 100 files, 512 KB each and
2 MB in all, and no symlinks or submodules. A private repository can't be installed this way;
download it and install the folder. GitHub allows 60 anonymous lookups an hour, so a busy hour
may need a wait.

## Example: build me a website

A project where the agents talk to you as they work:

```bash
npm run gantrix -- team add            # cpo, designer, engineer and the rest
npm run gantrix -- example website     # or: New project → "Build me a website" on the dashboard
```

1. **The product manager (`cpo`) asks you** what the site is for, who it's for and which pages
   it needs, one question at a time, then writes `product/brief.md`.
2. **The designer sketches three different styles** as `design/styles/*.html` and asks you
   which one to build; the question shows a preview of each. If you've set up images
   (`npm run media:link`, ComfyUI running), it also makes real images such as a hero photo or a
   logo, saved as PNG, JPEG or WebP under `design/assets/`. `team add` gives the designer the
   images skill when it finds the `gantrix-media-mcp` command.
3. **The engineer builds the site** in `site/` in the style you chose and **deploys it** to
   the local preview server. The link is in its reply and under **Open deployed site** on the
   project page, at `http://127.0.0.1:4702/<name>/`.

Questions show up on the project page, on the Approvals page and in `gantrix tail`. You can
also answer from the terminal with `gantrix answer <id> "your answer"`. A question always
waits for you, even on projects that don't ask first. Skip one and the agent makes, and states,
an assumption. The example gets a 3-hour time budget, because your answers take time.

The preview server only serves `~/.gantrix/sites` (`GANTRIX_SITES_DIR`), on its own port
(`GANTRIX_PREVIEW_PORT`, 4702). A deployed site can't reach the dashboard or your token.

## The executive team (optional)

One command adds ten ready-made agents, each with its own skill:

```bash
npm run gantrix -- team add                 # or: team add --only cto,designer   (-m <model> for all)
npm run gantrix -- run "CPO: plan the v2 launch; CTO: estimate the work; CMO: write the launch post"
```

| Agent | Skill | Does | Tools |
|---|---|---|---|
| `cto` | `exec-cto` | Architecture decisions (ADRs), code reviews, build plans, technical risks | files, web, shell |
| `cmo` | `exec-cmo` | Positioning, campaign plans, launch posts, landing-page copy, SEO briefs | files, web |
| `cro` | `exec-cro` | Customer profiles, lead lists from public pages, cold email and SMS drafts, sends email | files, web, outreach |
| `ciso` | `exec-ciso` | Threat models, code and dependency audits, config checks, authorized tests of your own systems | files, web, shell |
| `cpo` | `exec-cpo` | PRDs, priorities, milestone timelines with a Mermaid gantt, risks, status updates | files |
| `engineer` | `exec-engineer` | Builds websites and small tools from the brief and the chosen design, then deploys them to the local preview server | files, web, shell, deploy |
| `devops` | `exec-devops` | Deploys to the simplest platform that fits: Supabase, Heroku, Vercel, Netlify, Render, Fly.io, Railway, Cloudflare, GitHub Pages. Hands AWS and GCP to its sub-agents | files, web, shell, ask, delegate |
| `aws-engineer` | `devops-aws` | Sub-agent: Terraform for AWS (S3 + CloudFront, ECS Fargate, Lambda, RDS, IAM, VPC), checked with fmt/validate/tflint/checkov and planned; applies only when allowed and you say yes | files, web, shell, ask |
| `gcp-engineer` | `devops-gcp` | Sub-agent: Terraform for GCP (Cloud Run, Cloud Storage + CDN, Cloud SQL, Artifact Registry, IAM), checked and planned; applies only when allowed and you say yes | files, web, shell, ask |
| `designer` | `exec-designer`, `google-slides` | Mobile apps, websites, dashboards, marketing materials (social posts, flyers, emails), business cards and Google Slides decks: brief, wireframes, design tokens, HTML/CSS mockups and print files, checked against WCAG 2.2 | files, web, Google Slides |

It's safe to run again. Team agents you haven't changed move to the newest team skills; any
other existing agent is left as it is. The skills are plain folders in
`examples/skills/exec-*`; copy one, edit it, bump its version and install your own.

**Things to know:**
- The CTO and CISO can run shell commands. Use "Ask me before risky tools" to approve each one.
- The CISO only tests what the task names as yours. Anything else goes under "Not tested".
- The skills are written for small local models. Ask for one deliverable per step.

**Deployment and sub-agents.** `devops` reads the project, picks where it should run and
writes `deploy/plan.md`. For Supabase, Heroku, Vercel and the other platforms it uses their CLIs
itself. For AWS or GCP it uses the `delegate` tool to hand a sub-task to `aws-engineer` or
`gcp-engineer`, which write Terraform in `infra/aws/` or `infra/gcp/`, check it and run
`terraform plan`. The sub-task appears on the board as "sub-task for …", with its own
conversation and review. `devops` waits while it runs, then carries on with the result.
The skills tell the agents to ask you (`ask_user`) before `terraform apply`, paid resources, DNS
and anything destructive. That's an instruction to the model, not a lock: they run these
commands through `shell`, which runs without asking unless the project asks first. For real
cloud accounts, turn on "Ask me before risky tools" so every command waits for you. The CLIs (`supabase`, `heroku`, `vercel`, `fly`, `terraform`,
`aws`, `gcloud`…) must be installed and logged in by you; the agents never handle keys.

```bash
npm run gantrix -- team add --only devops,aws-engineer,gcp-engineer
npm run gantrix -- run --agents devops,aws-engineer "Deploy site/ to AWS as a static site behind CloudFront; plan only"
```

**Any agent can have sub-agents.** Add `delegate` to a skill's `tools` and its agent can hand
self-contained sub-tasks to another agent on the project's team and wait for the result. Rules:

- Only agents on the project's team can get a sub-task. If you picked a team, the others are
  out of reach, so a prompt injection can't recruit an agent with more powerful tools.
- Sub-tasks go one level deep: a sub-agent can't delegate further.
- One task can hand out at most 6 sub-tasks.
- A failed sub-task goes back to the agent that delegated it, which decides what to do; it
  doesn't fail the project.
- Agents that run on Claude Code (`claude -p`) can't delegate, because they don't get Gantrix
  tools. A Claude Code agent can be a sub-agent.

**Slide decks in Google Slides.** The designer builds decks in your Google Drive. Set it up once:

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the **Google Slides API**.
   Then create an OAuth client of type **Desktop app** and download its JSON.
2. Save that file as `~/.gantrix/google/oauth-client.json`.
3. Run these, and sign in with the link they print:

```bash
npm run slides:link     # makes the gantrix-slides-mcp command available
npm run slides:auth
```

Gantrix asks Google only for `drive.file` access. It can see and edit the decks it creates,
never the rest of your Drive. The sign-in token is saved in `~/.gantrix/google/token.json`
(chmod 600). Until you
connect it, the designer writes the deck as an outline file instead.

Business cards and flyers come out as print-ready HTML with bleed: open them in a browser, then
Print → Save as PDF with no margins.

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

- **Every email waits for your approval**, one recipient at a time, even on projects that don't
  ask first. Sending to a real person can't be undone. Approve or deny it on the project page,
  the Approvals page or with `gantrix approve <id>`.
- Each one gets an unsubscribe line, your postal address and a `List-Unsubscribe` header
  (US CAN-SPAM). Check the rules where your recipients live, such as GDPR or CASL.
- `OUTREACH_DAILY_LIMIT` (default 25) caps sends per day.
- A person gets at most three emails, and never after they're added to the do-not-contact list.
  That list is `~/.gantrix/outreach/do-not-contact.txt`; one address or `@domain` per line. An
  address also blocks its `+tag` variants, and `@domain` also blocks its subdomains.
- Every send is logged to `~/.gantrix/outreach/sent.csv`. Sends run one at a time, so the caps
  hold even when an agent asks for several at once. If that file has a line Gantrix can't read,
  it stops sending until you fix or remove the line.
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
- Image and video calls run without asking unless the project asks first. A video clip takes minutes.
- You choose the models per skill with `MEDIA_MODELS`. The agent picks among them per call.

**Settings** (in a skill's `mcp-servers` → `env`):

| Setting | Default | Meaning |
|---|---|---|
| `MEDIA_MODELS` | `z-image-turbo` | Which models this skill can use, comma-separated |
| (file extension) | `.png` | `generate_image` saves PNG, JPEG (`.jpg`) or WebP (`.webp`), picked by the path's extension |
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

## Jobs

A **project** is a goal the planner breaks into steps. A **job** is a saved, repeatable list of
steps you write yourself: *use this agent (and its skills) to do this, then that agent to do
that…* There is no planner, so every run is predictable.

On **Projects**, press **+ New Job**:

1. Name it and say what a finished run looks like (the goal the judge checks at the end).
2. Add steps in order. Each step has a title, an agent (whose skills it uses), what to do, and
   optionally how we know it worked. Each step starts when the one before it has passed.
3. Pick a schedule: only when you press **Run now**, or a cron pattern such as
   `0 9 * * 1-5` (weekdays at 09:00) in a time zone.

Every run is an ordinary project, so you can follow it, steer it and approve tools as usual;
jobs show their last run and next scheduled run. **Pause** stops the schedule and **Play** turns
it back on. A job doesn't overlap itself: if the last run is still going when the schedule
fires, that run is skipped. The worker (`npm run dev:worker`) must be running for schedules.

Example: a *Daily pull request scan* with steps `Fetch open PRs` (agent with the GitHub skill)
→ `Summarize discussions` → `Post to Slack`, scheduled `0 9 * * *`. The API is
`/api/jobs` (`POST /api/jobs/:id/run` runs one now).

## Talk to an agent in Slack

Give an agent a Slack connection and it is a live teammate: always online, answering DMs and
mentions as itself. It can answer people in Slack, using its own model and system prompt. It's off by
default and **requires Slack bot credentials**.

### The easy way: the Connect Slack guide

In the dashboard open **Connections → Connect Slack** (or `#/connect/slack`). It is about five
minutes, in six steps, and each step says exactly where to click in Slack:

<p align="center"><img src="site/assets/screenshots/slack-connect-1.webp" alt="The Connect Slack page: step 1, Open Slack with the manifest filled in, and step 2, install the app and paste the bot token" width="800"></p>

1. **Create the app.** One button opens Slack's *create app* page with Gantrix's manifest
   already filled in (name, bot user, permissions, Socket Mode). Or copy the manifest and paste it
   at [api.slack.com/apps](https://api.slack.com/apps) → *Create New App → From a manifest*.
2. **Install it, copy the bot token.** *Install App → Install to Workspace → Allow*, then
   *OAuth & Permissions → Bot User OAuth Token*. It starts with `xoxb-`.
3. **Make the app-level token.** *Basic Information → App-Level Tokens → Generate Token and
   Scopes*, name it, add the scope `connections:write`. It starts with `xapp-`.
4. **Add your member ID.** In Slack: your profile → *⋮ More → Copy member ID* (like
   `U01ABCDE2F`). Only the people listed can talk to your agents.
5. **Save and test.** Gantrix checks each field as you paste (it tells you if you pasted the
   wrong kind of token), then connects to Slack and reports who the bot is, which workspace it
   is in, and whether Socket Mode works. Slack's errors come back with the fix.
6. **Choose the agents.** The project manager (`cpo`) is suggested first.

<p align="center"><img src="site/assets/screenshots/slack-connect-2.webp" alt="Steps 3 and 4 of the Connect Slack page with the app-level token and a member ID filled in and checked" width="800"></p>

The same walkthrough, with the Slack links, is on the site:
[Connect Gantrix to Slack](https://perdieminc.github.io/gantrix/connect-slack/). Slack's own docs:
[app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/),
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode),
[finding a member ID](https://slack.com/help/articles/360003827751-Create-a-link-to-a-members-profile).

### By hand

1. Create the Slack app from [`docs/slack-app-manifest.yml`](docs/slack-app-manifest.yml) (it
   includes DMs and Socket Mode).
2. On **Connections → Add connection → Slack**, save the app's **bot token** (`xoxb-…`), its
   **app-level token** (`xapp-…`, so Gantrix can hear messages) and the **allowed Slack user
   IDs**. Only those people can talk to the agents. **Test** checks all three.
3. On **Agents**, press **Set up** next to *Slack* on an agent and pick that connection (or pick
   it in the **Talk to it in Slack** menu when you add the agent). Saving is refused until the
   connection has a bot token, an app-level token and at least one allowed user.

Both tokens are secrets: Gantrix keeps them in your local database and never returns them, and a
value written as `env:NAME` is read from the worker's environment instead.

Then DM the bot, or mention it in a channel it's in: `@Gantrix writer: summarize what we
shipped`. If several agents share one connection, start with the agent's name; with one, no
name is needed. Replies stay in the thread, and the thread is the conversation. In chat an
agent only talks; to make it do work with its tools, start a project or a job.

**Ask it for its status.** On every message the agent is given its own current work, fresh from
the database: its tasks in running projects (and how long each has run, and on which attempt),
what is waiting for a person (a question to answer, a tool to approve), and what it finished or
failed in the last 24 hours. Ask `@Gantrix writer: what's your status?` (or "what are you
working on?", "anything blocked?") and it summarizes that in its own voice. It sees only its own
tasks, never invents any, and if its model is down a status question is still answered, as a
plain list of the same facts.

## Managing projects

- **Name** a project in the New project form, or rename it with the pencil next to its title.
  Without a name it shows the start of its description or goal.
- **Stop** pauses it: nothing new starts and running tasks stop within seconds, even a long
  Claude or ChatGPT turn. Time spent stopped doesn't count against the time limit.
  **Resume** picks it up where it stopped. **Cancel** ends it for good.
- **Delete** (finished or stopped projects only) removes the project, its tasks, chat and
  history, and its workspace folder. Sites it deployed stay. The dashboard asks first; the CLI
  needs `--yes`.

### Build a site, deploy it to AWS, and don't stop until it is live

Four settings make a project able to finish a real deployment on its own. In the dashboard
they are under **Deploy and finish** in the New project form and on the Agents page.

| Setting | Dashboard | CLI | What it does |
|---|---|---|---|
| Variables for shell commands | A text box, one `NAME=value` per line | `--env AWS_PROFILE=deploy` (repeat) | Agents' shell commands get them, so `aws` and `terraform` can sign in |
| Time limit per task | Agents page, per agent | `agents add --timeout 30` | A task that runs longer is stopped and tried again, so one hung command can't hold the plan. Shell commands may run this long instead of 2 minutes |
| Keep going | A checkbox, and a switch on the project | `--keep-going` | No time, token or replan limit: the project ends when the goal is met or you press Stop |
| Done only when the site is live | A checkbox | `--live-check` | Gantrix fetches the deployed public URL itself before it accepts the goal |

```bash
npm run gantrix -- team add          # also moves the team to the newest skills
npm run gantrix -- run "Build a one-page site for Crumb & Co and deploy it to AWS with S3 and CloudFront" \
  --agents engineer,devops,aws-engineer \
  --env AWS_PROFILE=gantrix-deploy --env AWS_REGION=us-east-1 \
  --keep-going --live-check
```

- **Variables.** A value is used as typed; `NAME=env:OTHER` reads `OTHER` from the worker's
  `.env` instead, so a secret needn't be saved. Values live in your local Postgres and the API
  only ever returns the names. Shell runs with `HOME` set to the project folder, so with
  `AWS_PROFILE` set Gantrix also points `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` at
  your real `~/.aws`. A profile that signs in with SSO needs `HOME=/Users/you` as well.
- **Use a narrow profile.** Agents can run anything that profile allows. Give it only S3,
  CloudFront and ACM for a static site, and set a billing alarm: keep going has no cost limit
  of its own.
- **Time limits.** Set 30 minutes or so on `aws-engineer`: a first CloudFront distribution takes
  longer than the 2 minutes a shell command gets by default.
- **The live check.** Agents check a deployed URL with the `verify_url` tool (public addresses
  only). Before the goal is judged, Gantrix fetches those URLs again; if none answers with a
  2xx status the goal is not met and the project replans.
- **Where it still waits for you.** The AWS and GCP skills ask before `terraform apply`, and a
  project waits for your answer however long it takes. A project also still ends as `failed`
  if the planner can't produce a valid plan in three tries or the model server stays down.

### Start anything from one button

The **New** button in the top bar opens a menu: **Project**, **Job** or **Agent**. Each opens its
form on its own page (`#/new/project`, `#/new/job`, `#/new/agent`), and a switch at the top moves
between them. The Projects, Jobs and Agents pages are lists.

Wherever you pick a model, it is a dropdown of what the chosen place offers (for Ollama, the
models you have pulled). A model that isn't in the list stays selectable, and **Other…** lets you
type a name; **Back to the list** undoes it. Press **refresh** after pulling a model.

### Talk to the project owner

Open a project and switch its chat panel from **Team** to **Owner** to ask where the project
stands: what is done, what is blocked, what happens next. The owner is the project's `cpo` (or
`pm`) agent when the team has one, otherwise a generic "Project owner". It answers from the
project's live state each time, on the default model, and remembers the conversation. It never
changes anything: to steer the team, use **Team**, or Stop and Add time. `GET` and `POST
/api/tasks/:id/discussion` are the same conversation over the API.

### What's running right now

The dashboard's **Live** page lists every agent working at this moment: its task and project,
the model it runs on, whether that model is local or cloud, how long it has been at it and the
tokens used. Below it are the models Ollama holds in memory, with size, GPU or CPU split, the
agents using each one and when it unloads. A stopped project drops off the page. `GET /api/live`
returns the same data. The **System** page shows memory, CPU load and running Docker containers.

## Slack (optional)

Each project with **Post to Slack** on gets its own thread in one channel: the plan, each
finished or failed task, every question an agent asks you, and the end (which also shows in the
channel). It works both ways:

- **Reply in the thread** to steer the team (your note reaches the agents working now), or to
  answer the question an agent asked. A number picks one of its options.
- **Mention the app** in the thread to ask about the project, for example *@Gantrix what's
  left?*. It answers from the project's tasks, results and recent activity, using the default
  model.
- **Commands** (mention the app): `status`, `add designer`, `remove cto`, `stop`, `resume`,
  `extend 60m`, `rename Crumb site`, `help`. A mention outside a thread lists running projects.

Only users in `SLACK_ALLOWED_USERS` can interact with the app. Other users are ignored,
including status and questions. Set this to your verified Slack member ID for personal use.
Send a goal by direct message or mention the app in the configured channel to start a project.
All progress stays in that message's thread; reply there to continue. New Slack projects ask
before risky tools. Enable `message.im` and `im:history` for DMs (included in the manifest).
The existing planner selects agents and skills; their configured model connections still apply,
so select local Ollama models for the planner and every agent before claiming local-only runs.

**Set it up (about 5 minutes):**

1. Go to <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick your
   workspace and paste [`docs/slack-app-manifest.yml`](docs/slack-app-manifest.yml).
2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`) into
   `SLACK_BOT_TOKEN`.
3. Under **Basic Information → App-Level Tokens**, generate a token with the
   `connections:write` scope and put it (`xapp-…`) in `SLACK_APP_TOKEN`. Skip this step if you
   only want updates, not replies.
4. In Slack, invite the app to a channel (`/invite @Gantrix`). Copy the channel ID from the
   channel's details (it starts with `C`) into `SLACK_CHANNEL_ID`.
5. Put your member ID (your profile → ⋮ → **Copy member ID**) in `SLACK_ALLOWED_USERS`.
6. Restart the API. It logs `Slack: posting to C…, listening for replies`.

Gantrix uses Socket Mode, so it needs no public URL and works on your laptop. Tokens stay in
`.env`; the dashboard only learns whether Slack is set up.

## Approvals and safety

- **By default, agents don't ask.** Every tool call runs without an approval, including shell
  commands, web requests and MCP tools. Each call is still logged, so you can see it in the chat
  and on the Logs page. The one exception: the CRO's emails always wait for you.
- **Turn approvals on for a project** with "Ask me before risky tools" on the dashboard, or
  `gantrix run --ask "…"`. Then shell, publishing, web, MCP and email calls wait for you, and
  only that step pauses. Decide with Approve/Deny on the project or Approvals page, in
  `gantrix tail <task>`, or with `gantrix approve <id>` / `gantrix deny <id>`.
- To make every new project ask first, set `GANTRIX_APPROVE_ALL=false`. A skill's
  `auto-approve` list can never waive `shell` or `deploy_site`.
- **Local only.** The API (port 4700) and the preview server (4702) listen on `127.0.0.1` and
  answer only to `localhost`, `127.0.0.1` or `[::1]` as the address. A web page that points its
  own domain at your machine (DNS rebinding) gets turned away. If you set `GANTRIX_HOST` to
  another address on purpose, that check is off and only the token protects the API.
- **`web_fetch` stays on the public internet.** It checks the address it actually connects to,
  on every redirect, and refuses private, local and cloud-metadata addresses.
- File tools refuse paths that leave the project's folder, including through a symlink whose
  target doesn't exist yet.
- Image and video jobs give up after 15 minutes (images) or 60 minutes (video), or as soon as
  ComfyUI loses the job.
- **Isolated steps (optional).** Set `GANTRIX_ISOLATED_STEPS=true` and each new project gives
  every step its own folder at `steps/<step-id>/`, so agents can't overwrite each other's
  files. A step gets copies of everything it builds on (its dependencies and theirs) in
  `inputs/<step-id>/`, the project's own files in `inputs/project/`, and a delegated step a
  copy of its parent's files. Copies leave out symlinks, `.git`, `node_modules` and each
  step's own `inputs/`. They refresh on a new attempt; a resume after an approval keeps them.
  Projects created before you turn it on keep the shared folder. Copies take disk space, and
  the Files panel lists at most 500 entries, so prefer it for small projects.
- **Workspace separation is not an OS sandbox.** Built-in file tools reject paths escaping
  the step folder. Shell commands, MCP servers and model-provider CLIs still execute with
  your account's permissions and can access other paths or the network. Run untrusted
  agents in a separate container/VM; approvals do not make arbitrary code safe.
- Web pages and MCP results can contain text that tries to steer the agent. Approval is where
  you catch that.
- The API listens on `127.0.0.1` only and needs the token on every request.
- Shell commands and MCP servers get a reduced environment, not the server's complete
  environment. This does not prevent them from reading files accessible to your OS account.

## CLI

```
gantrix agents [list | add <name> [-d text] [-s skills] [-m model] [-c connection] [--slack connection] [--max-concurrency n] | rm <name>]
gantrix connections [list | add <name> -p ollama|openai|anthropic|http|claude-code|codex|github|slack [--setting key=value…] [-u url] [--method m] [--content-type t] [--body template] [--reply-path p] [-H "Name: value"…] [--api-key-env NAME] | test <name> <model> | rm <name>]
gantrix jobs [list | add <name> --goal text --step "agent|title|instructions"… [--schedule cron] [--timezone zone] [--slack] | run <name> | pause <name> | play <name> | rm <name>]
gantrix skills [list | add <folder> | rm <name[@version]>]
gantrix team add [--only cto,cmo,cro,ciso,cpo,designer,engineer,devops,aws-engineer,gcp-engineer] [-m model]
gantrix run "<goal>" [--name text] [--description text] [--slack] [--offload claude|chatgpt] [--agents a,b] [--max-minutes n] [--max-tokens n] [--max-replans n] [--ask | --approve-all] [--detach]
gantrix tasks | show <task> [--all] | tail <task> | logs <task> [step] [--full] | cancel <task> | files <task> [path]
gantrix say <task> "<note>" [--to <step>]
gantrix extend <task> [--minutes n] [--tokens n] [--replans n]
gantrix stop <task> | resume <task> | rename <task> "<name>" | delete <task> --yes | slack <task> on|off
gantrix approvals | approve <id> | deny <id> | answer <id> "<answer>"
gantrix example website
```

Run it as `npm run gantrix -- <command>`. `<task>` is `last`, a full ID, or the short ID that
`gantrix tasks` prints.

## Models

The **default model** plans projects, judges every task, and runs agents that don't set their
own model. It is a setting, not an environment variable: choose it on the **Agents** page
(**Default model**, the same dropdowns as everywhere), or with the CLI:

```bash
npm run gantrix -- default-model                                 # show it
npm run gantrix -- default-model llama3.1:8b                     # a model on the local Ollama
npm run gantrix -- default-model gpt-5-mini --connection openai  # on a saved connection
npm run gantrix -- default-model --reset                         # the built-in qwen3:8b
```

It is saved in the database, so the API and the worker always agree and a change applies to the
next task with no restart. Until you choose one it is the built-in `qwen3:8b` on the local
Ollama. It can be a model on Ollama, OpenAI or Anthropic (it must plan and judge, so not Claude
Code, Codex or a custom HTTP server), and its connection can't be deleted while it is the default.
`GANTRIX_DEFAULT_MODEL` and `GANTRIX_DEFAULT_CONNECTION` are not read any more: if they are still
in your `.env`, the API and worker warn at start; choose the model once and delete the lines.

An agent's own model can be any Ollama model, or `openai/<model>` with a base URL for any
OpenAI-compatible server (vLLM, llama.cpp, LM Studio).

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
| `claude-code` | `claude` on your PATH | Your local Claude Code, run as `claude -p` (agents only) |
| `http` | the URL you give | Any HTTP server: you set the method, Content-Type, body and where the reply is (agents only) |

### GitHub and Slack connections

**Connections** also holds credentials for services, not just models. They never show up in
the agent model pickers.

- **GitHub:** a fine-grained token with **Pull requests: Read**, plus an optional organization
  and repositories. **Test** signs in and checks the organization is visible.
- **Slack (existing app):** the bot token (`xoxb-…`) of the Slack app you already installed, an
  optional app-level token (`xapp-…`) so replies in threads reach Gantrix, a channel ID and the
  Slack user IDs allowed to steer. Invite the bot to the channel. **Test** runs `auth.test`,
  checks the channel and, if given, Socket Mode.

Tokens can be `env:NAME` to read them from `.env` instead of saving them. Saved values are
never returned by the API.

### Any HTTP server

For an API that isn't OpenAI-, Anthropic- or Ollama-compatible, describe the request yourself.
On the dashboard's Connections page, choose **Custom HTTP server**. Or use the CLI:

```bash
npm run gantrix -- connections add mine --provider http \
  --url "https://api.example.com/v1/generate/{{model}}" --method POST \
  -H "Authorization: Bearer env:MINE_API_KEY" -H "X-Team: research" \
  --body '{"input": {"text": "{{prompt}}"}, "options": {"max_tokens": 1024}}' \
  --reply-path data.outputs.0.text
npm run gantrix -- connections test mine my-model
```

| Setting | Default | Meaning |
|---|---|---|
| URL | (required) | `http://` or `https://`; may contain `{{model}}` or `{{prompt}}` (URL-encoded) |
| Method | `POST` | `POST`, `PUT`, `PATCH` or `GET` (GET has no body; put `{{prompt}}` in the URL) |
| Content-Type | `application/json` | The body is escaped to match: JSON, form-encoded or plain text |
| Body | `{"model": "{{model}}", "prompt": "{{prompt}}"}` | Placeholders: `{{prompt}}`, `{{system}}`, `{{model}}`, and `"{{messages}}"` for an OpenAI-style message array |
| Reply path | auto | Where the answer is in the JSON response, like `choices.0.message.content`. Blank tries the common shapes, then uses the whole response |
| Headers | none | As many as you need, one row each |

- **The Test button sends the real request** with your prompt. It shows the request (header
  values hidden), the status, the raw response and every text path in it. While you edit the
  connection, click a path to use it as the reply path.
- **Tools work over plain text.** The agent is told to answer with a
  `{"tool": "write_file", "args": {...}}` block when it wants a tool. Gantrix runs the tool and
  sends back the result. Small models sometimes get the JSON wrong.
- **Custom HTTP runs agents only.** The planner and judge stay on Ollama, OpenAI or Anthropic.

**Editing a connection.** On the Connections page, click **Edit** on any connection to change its
URL, headers or request. Saved header values stay hidden: leave them as they are, or click
**Replace** to type a new one.

### Offload to Claude or ChatGPT on your machine

Hand a project's work to the coding agents you already have and pay for. In New project, set
**Run the work on** to **Claude** or **ChatGPT**, or from the terminal:

```bash
npm run gantrix -- run --offload chatgpt --agents engineer "Add a contact page to site/"
npm run gantrix -- run --offload claude "Write a test plan to qa/plan.md"
```

Claude uses [Claude Code](https://claude.com/claude-code) (`claude -p`) and ChatGPT uses the
[Codex CLI](https://github.com/openai/codex) (`codex exec`). Install them and sign in yourself
(`claude`, `codex login`); Gantrix detects them and creates the connection the first time. Any
choice you make for one agent in that form still wins.

- Only the agents' work moves. The planner and judge stay on your default model.
- These agents use their own tools, so `ask_user`, `delegate`, `deploy_site` and MCP tools aren't
  available to them. They make an assumption and say so instead of asking you.
- Prompts and files go to Anthropic or OpenAI, and the work counts against your plan.
- Token budgets count new tokens only, not the cached context each run reads again.
- Offload is a project setting, so agents you add later follow it. The Team panel shows the model
  each agent uses on that project, and the judge reads the files these agents changed.
- An OpenAI or Anthropic connection needs a model name; Gantrix asks for one when you save.

To use one for a single agent instead, click **Change** next to **Runs on** on the Agents page.

### ChatGPT (Codex CLI) as an agent

```bash
npm run gantrix -- connections add chatgpt-local --provider codex   # -u /path/to/codex if it isn't on PATH
npm run gantrix -- connections test chatgpt-local default
npm run gantrix -- agents add coder -d "Writes and edits code" -c chatgpt-local
```

- Each model turn runs `codex exec` in the step's folder with your ChatGPT login.
- It always runs in Codex's `workspace-write` sandbox, so it can read your disk but write only in
  that folder. On projects that don't ask first (the default) it can use the network; on
  projects that ask first it can't.
- Gantrix can't see or approve the commands it runs inside a run.
- Each run skips your `~/.codex/config.toml` (so no MCP servers from it) and saves no session. It
  gets only a short list of environment variables (like `PATH` and `HOME`), so no API keys or
  Gantrix secrets.

### Claude Code as an agent

An agent can use your local [Claude Code](https://claude.com/claude-code) instead of a chat model.
Each model turn of its step runs `claude -p` inside the task's folder, with your Claude login,
and Claude Code does the work with its own tools.

```bash
npm run gantrix -- connections add claude-local --provider claude-code   # -u /path/to/claude if it isn't on PATH
npm run gantrix -- connections test claude-local sonnet
npm run gantrix -- agents add coder -d "Writes and edits code" -c claude-local -m sonnet
```

- Gantrix can't see or approve the tool calls Claude Code makes inside a run. On projects that
  don't ask first (the default), it gets file tools plus Bash, WebFetch and WebSearch. On
  projects that ask first, it gets file tools only (Read, Write, Edit, Glob, Grep).
- Each run is started without MCP servers and without a saved session. It doesn't get the
  API keys or Gantrix secrets in its environment, so it always uses your Claude login.
- The planner and judge still need an Ollama, OpenAI or Anthropic model, so Claude Code can't be
  the default model's connection.
- The step's tokens come from Claude Code's own report (new tokens only), and its usage counts
  against your Claude plan.

**How headers work:**
- A header value of `env:NAME` (or `Bearer env:NAME`) is read from the worker's environment
  when a step runs. Put the key in `.env` and restart the API and worker.
- Any other value is saved in your local database and never returned by the API.
- `Authorization: Bearer …` and `x-api-key` go to each SDK's key setting. Without either, the
  SDKs read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` themselves.

**Using a connection for everything.** To have the planner and judge use a connection too, choose
it as the **Default model** on the Agents page (or `gantrix default-model <model> --connection
<name>`).

A connection whose URL isn't on this machine or your network is marked **cloud**. Prompts and
task content then go to that service, and its prices apply.

## Configuration

All settings are environment variables in `.env`; see [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | Compose ports | Postgres and Valkey |
| `GANTRIX_TOKEN` | set by `npm run setup` | API token, at least 32 characters |
| `GANTRIX_HOST`, `GANTRIX_PORT` | `127.0.0.1`, `4700` | API address |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | The local Ollama. (The default *model* is chosen on the Agents page, not here.) |
| `GANTRIX_LLM_CONCURRENCY` | `2` | Model calls at once per worker |
| `GANTRIX_WORKSPACES_DIR`, `GANTRIX_SKILLS_DIR` | `~/.gantrix/…` | Where task files and skills live |
| `GANTRIX_MAX_STEP_ATTEMPTS`, `_MAX_REPLANS`, `_MAX_TOKENS`, `_MAX_MINUTES` | 3, 5, 200000, 60 | Default budgets per task |
| `GANTRIX_SITES_DIR`, `GANTRIX_PREVIEW_PORT` | `~/.gantrix/sites`, `4702` | Where deploy_site publishes, and the preview server's port |
| `GANTRIX_APPROVE_ALL` | `true` | Tool calls run without asking; `false` makes every new project ask first |
| `GANTRIX_ISOLATED_STEPS` | `false` | Each step of a new project works in its own folder with copies of its inputs |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | unset | Projects with Slack on post progress to a thread in this channel |
| `SLACK_APP_TOKEN` | unset | Socket Mode: replies and mentions in Slack reach the project |
| `SLACK_ALLOWED_USERS` | empty | Slack member ids who may steer, answer, change the team, stop or rename |
| `GANTRIX_DASHBOARD_URL` | `http://127.0.0.1:4701` | Where links in Slack messages point |

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

### Workflow evaluations

Run the live model through two small business workflows and check artifacts independently
of the judge with `npm run evaluate -- <file-only-agent-uuid>`. Reports include correctness,
tokens, elapsed time, retries and judge feedback; dollar cost remains unknown. See
[the evaluation guide](docs/evaluation.md) for setup, safety limits and comparison guidance.

### GitHub PR discussions

Open **Projects → GitHub PR Scan** and press **Play**. The built-in project is
available on every installation. To add a separate scan to an existing project,
open that project and expand **GitHub PR scan**.
Enter a fine-grained GitHub token with **Pull requests: Read** permission. Set an
organization (for example, `PerDiemInc`), a list of repositories, or both.
Choose **Save and play** on the first run. After setup, **Play** and **Pause**
control the built-in project. It polls immediately and then every five minutes by
default. The first scan includes existing discussions on open PRs. The built-in
project shows recent summaries in the dashboard.

- **Slack** — Enter a bot token and channel. Use a private channel for private
  repositories. To answer replies in report threads, add a Socket Mode app token
  and allowed Slack user IDs.
- **Email** — Enter an SMTP URL with credentials, a sender, and a recipient.
  To answer replies, enter the sender mailbox's IMAP host, username, and password.
  Reply from the configured recipient address and keep the subject intact.

Settings and delivery history are scoped to the project in Valkey. Credentials are
encrypted using the Gantrix API token and omitted from the settings response.
If you rotate that token, remove the saved scan and enter its settings again.
Uncheck **Enable scheduled scan** to pause it independently of the project's
normal plan. The local Ollama model summarizes PR discussion text with no tools.
