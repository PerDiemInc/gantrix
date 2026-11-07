import { setTimeout as sleep } from 'node:timers/promises';
import { type AgentDto, isTerminal, type TaskDetailDto } from '@gantrix/shared';
import { createClient } from './client.ts';
import { findReport, gradeOutput, workflowCases } from './evaluation.ts';

// Explicit agent selection keeps evaluation away from unrelated agents and their credentials.
const agentId = process.argv[2];
if (!agentId || !/^[0-9a-f-]{36}$/i.test(agentId) || !process.env.GANTRIX_TOKEN) {
  console.error('Usage: npm run evaluate -- <file-only-agent-uuid> (GANTRIX_TOKEN required)');
  process.exit(2);
}
const api = createClient(
  process.env.GANTRIX_URL ?? 'http://127.0.0.1:4700',
  process.env.GANTRIX_TOKEN,
);
const agent = await api.get<AgentDto>(`/api/agents/${agentId}`);
const reports = [];
for (const scenario of workflowCases) {
  const started = Date.now();
  const task = await api.post<TaskDetailDto>('/api/tasks', {
    name: `Evaluation: ${scenario.id}`,
    goal: scenario.goal,
    agentIds: [agentId],
    approveAll: false,
    slack: false,
    budget: { maxMinutes: 5, maxTokens: 30000, maxStepAttempts: 2, maxReplans: 1 },
  });
  console.error(`${scenario.id}: task ${task.id}`);
  let snapshot: TaskDetailDto;
  // No tool approvals are granted by this runner, even if a model requests one.
  for (;;) {
    snapshot = await api.get<TaskDetailDto>(`/api/tasks/${task.id}`);
    if (isTerminal(snapshot.status)) break;
    if (
      snapshot.approvals.some((approval) => approval.status === 'pending') ||
      Date.now() - started > 360000
    ) {
      await api.post(`/api/tasks/${task.id}/cancel`);
      snapshot = await api.get<TaskDetailDto>(`/api/tasks/${task.id}`);
      break;
    }
    await sleep(1000);
  }
  const { files } = await api.get<{ files: string[] }>(`/api/tasks/${task.id}/files`);
  const reportPath = findReport(
    files,
    snapshot.steps.filter((s) => s.status === 'succeeded').map((s) => s.id),
  );
  const output = reportPath
    ? await api.get<string>(
        `/api/tasks/${task.id}/files/content?path=${encodeURIComponent(reportPath)}`,
      )
    : '';
  const grade = gradeOutput(output, scenario.expected);
  reports.push({
    scenario: scenario.id,
    taskId: task.id,
    status: snapshot.status,
    passed: snapshot.status === 'succeeded' && grade.passed,
    checks: grade.checks,
    reportPath,
    elapsedMs: Date.now() - started,
    tokensUsed: snapshot.tokensUsed,
    // Token totals are available, but input/output rates and splits are not recorded.
    costUsd: null,
    replans: snapshot.replans,
    attempts: snapshot.steps.reduce((n, s) => n + s.attempt, 0),
    steps: snapshot.steps.map(({ key, status, tokensUsed, attempt, judgeReason }) => ({
      key,
      status,
      tokensUsed,
      attempt,
      judgeReason,
    })),
  });
}
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      agent: {
        id: agent.id,
        name: agent.name,
        model: agent.model,
        connectionId: agent.connectionId,
      },
      reports,
    },
    null,
    2,
  ),
);
process.exitCode = reports.every((report) => report.passed) ? 0 : 1;
