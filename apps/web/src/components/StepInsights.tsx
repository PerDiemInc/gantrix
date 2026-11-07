import type { AgentDto, StepDto } from '@gantrix/shared';
import { label } from '../format.ts';

/** Resolve the newest eligible version, never a later replan of a historical step. */
export function dependenciesOf(step: StepDto, steps: StepDto[]) {
  return step.dependsOn.map((key) => {
    const candidates = steps.filter((s) => s.key === key && s.planVersion <= step.planVersion);
    const dependency = candidates.sort((a, b) => b.planVersion - a.planVersion)[0];
    return { key, dependency };
  });
}

export function ownerOf(step: StepDto, agents: Map<string, AgentDto>): string {
  // agentId becomes null when the agent is deleted; a missing entry means agents are loading.
  return step.agentId ? (agents.get(step.agentId)?.name ?? '…') : 'Deleted agent';
}

export function StepInsights({
  step,
  steps,
  agents,
}: {
  step: StepDto;
  steps: StepDto[];
  agents: Map<string, AgentDto>;
}) {
  const dependencies = dependenciesOf(step, steps);
  return (
    <section className="step-insights" aria-label="Task execution details">
      <dl>
        <div>
          <dt>Owner</dt>
          <dd>{ownerOf(step, agents)}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>
            {step.attempt} · plan {step.planVersion}
          </dd>
        </div>
        <div>
          <dt>Recorded token usage</dt>
          <dd>{step.tokensUsed.toLocaleString()}</dd>
        </div>
      </dl>
      <p className="muted small">
        Usage is cumulative for this task, not a dollar estimate. Project totals also include
        planning and goal checks.
      </p>
      <h3 className="small">Dependencies</h3>
      {dependencies.length ? (
        <ul>
          {dependencies.map(({ key, dependency }) => (
            <li key={key}>
              <span className="mono">{key}</span> ·{' '}
              {dependency ? label(dependency.status) : 'Not found'}
              {dependency && ` · ${ownerOf(dependency, agents)}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No prerequisite tasks.</p>
      )}
      <h3 className="small">Latest recorded judge feedback</h3>
      <p className="prose">
        {step.judgeReason ??
          (step.status === 'judging' ? 'Evaluation in progress.' : 'No verdict recorded.')}
      </p>
      <p className="muted small">Checked against: {step.acceptance}</p>
    </section>
  );
}
