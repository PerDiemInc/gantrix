# Evaluate real workflows

`npm run evaluate -- <agent-uuid>` runs the live planner, worker and judge against two
small, synthetic business workflows: cafe sales reconciliation and release-readiness
triage. It checks the JSON artifacts against deterministic expected results rather
than taking the judge's verdict as proof of correctness. These are smoke evaluations,
not evidence of broad model quality or a statistically meaningful benchmark.

Start the API/worker and configured model using the README. Create a dedicated agent
with **only** the `workspace-files` skill and use its UUID (from `gantrix agents list`).
Do not use an agent with MCP or shell skills. Evaluation creates two retained projects,
consumes model tokens and may incur provider fees. It never approves tool calls or
posts to Slack. Approvals or a six-minute timeout cause cancellation; inspect the task
before rerunning. No model calls are made by the unit tests.

```sh
npm run evaluate -- YOUR-AGENT-UUID > evaluation.json
```

`GANTRIX_TOKEN` is loaded from `.env`; `GANTRIX_URL` optionally changes the API URL.
Results include each task ID, deterministic check results, elapsed time, tokens,
attempts, replans and judge feedback. Exit status is 0 only when every workflow reaches
`succeeded` **and** passes every artifact check. The `costUsd` field is deliberately
null: the engine doesn't record input/output price splits, and local inference isn't
free electricity. Don't present a token total as a verified dollar charge.

Compare the same model and configuration across multiple runs, retaining failures.
Record commit SHA, planner/judge model configuration, hardware and any provider rates
alongside results; the report includes the selected agent metadata, but that does not
capture all global environment configuration. Never publish private task output or
credentials. No benchmark scores are claimed by this PR until actual model runs occur.
