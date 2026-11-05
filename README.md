# Gantrix

Open-source agents that work a plan like a Gantt chart. You create agents, give each one
or more skills, and hand Gantrix a goal. A planner breaks the goal into dependent steps,
workers run ready steps in parallel, and a judge checks every result against its
acceptance criterion and replans until the goal is met or a budget runs out.

Runs locally: Node 26, LangGraph.js, BullMQ on Valkey, Postgres, and Ollama.

## Run it

```bash
nvm use
npm install
cp .env.example .env          # set GANTRIX_TOKEN
npm run infra:up              # Postgres 18 on :15432, Valkey 9 on :16379
npm run db:migrate
```

Work in progress. Full documentation comes with the first end-to-end release.
