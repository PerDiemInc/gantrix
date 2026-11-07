import type { ApprovalListItem } from '@gantrix/shared';
import { api } from '../api.ts';
import { QuestionCard } from '../components/QuestionCard.tsx';
import { ago, short } from '../format.ts';
import { useLive } from '../hooks.ts';

export function ApprovalsPage() {
  const { data, reload } = useLive(
    () => api.get<ApprovalListItem[]>('/api/approvals?status=pending'),
    '/api/stream',
    [],
  );
  const decide = async (id: string, approved: boolean) => {
    await api.post(`/api/approvals/${id}`, { approved });
    reload();
  };
  return (
    <section className="card">
      <h2>Waiting for you</h2>
      {data && !data.length && <p className="muted">No questions or approvals are waiting.</p>}
      {data?.map((a) =>
        a.tool === 'ask_user' ? (
          <div key={a.id} className="stack">
            <div className="muted small">
              <a href={`#/projects/${a.taskId}`}>project {short(a.taskId)}</a> ·{' '}
              {a.goal.slice(0, 80)}
            </div>
            <QuestionCard
              id={a.id}
              taskId={a.taskId}
              stepId={a.stepId}
              who={a.stepTitle}
              args={a.args}
              onDone={reload}
            />
          </div>
        ) : (
          <div key={a.id} className="approval">
            <div>
              <div className="muted small">
                <a href={`#/projects/${a.taskId}`}>project {short(a.taskId)}</a> · {a.stepTitle} ·{' '}
                {ago(a.createdAt)}
              </div>
              <p className="small">{a.goal}</p>
              <strong>{a.tool}</strong>
              <pre className="args">{JSON.stringify(a.args, null, 2)}</pre>
            </div>
            <div className="approval-actions">
              <button type="button" className="primary" onClick={() => void decide(a.id, true)}>
                Approve
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() => void decide(a.id, false)}
              >
                Deny
              </button>
            </div>
          </div>
        ),
      )}
    </section>
  );
}
