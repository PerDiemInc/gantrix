import type { ApprovalListItem } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, getToken, setToken, subscribe } from './api.ts';
import { useRoute } from './hooks.ts';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { ApprovalsPage } from './pages/ApprovalsPage.tsx';
import { LogsPage } from './pages/LogsPage.tsx';
import { SkillsPage } from './pages/SkillsPage.tsx';
import { TaskPage } from './pages/TaskPage.tsx';
import { TasksPage } from './pages/TasksPage.tsx';

function TokenGate({ onSaved, rejected }: { onSaved: () => void; rejected: boolean }) {
  const [value, setValue] = useState('');
  const save = (e: FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
    onSaved();
  };
  return (
    <form className="card gate" onSubmit={save}>
      <h1>Gantrix</h1>
      <p>
        Paste the API token (GANTRIX_TOKEN from the server's .env). It's kept in this browser only.
      </p>
      {rejected && <p className="error">That token was rejected.</p>}
      <input type="password" value={value} onChange={(e) => setValue(e.target.value)} required />
      <button type="submit" className="primary">
        Continue
      </button>
    </form>
  );
}

export function App() {
  const route = useRoute();
  const [state, setState] = useState<'checking' | 'ok' | 'need' | 'rejected'>(
    getToken() ? 'checking' : 'need',
  );
  const [pending, setPending] = useState(0);

  useEffect(() => {
    if (state !== 'checking') return;
    api.get('/api/agents').then(
      () => setState('ok'),
      (e) => setState(e instanceof ApiError && e.status === 401 ? 'rejected' : 'ok'),
    );
  }, [state]);

  useEffect(() => {
    if (state !== 'ok') return;
    const count = () =>
      void api
        .get<ApprovalListItem[]>('/api/approvals?status=pending')
        .then((a) => setPending(a.length));
    count();
    return subscribe('/api/stream', (e) => {
      if (e.type === 'approval.requested' || e.type === 'approval.decided') count();
    });
  }, [state]);

  if (state === 'need' || state === 'rejected') {
    return <TokenGate rejected={state === 'rejected'} onSaved={() => setState('checking')} />;
  }
  if (state === 'checking') return null;

  const nav = [
    ['tasks', 'Tasks'],
    ['agents', 'Agents'],
    ['skills', 'Skills'],
    ['approvals', 'Approvals'],
  ] as const;
  const current = route.page === 'task' || route.page === 'logs' ? 'tasks' : route.page;
  return (
    <>
      <nav className="top">
        <a href="#/tasks" className="brand">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <rect x="1" y="3" width="9" height="3" rx="1" className="b1" />
            <rect x="5" y="7" width="10" height="3" rx="1" className="b2" />
            <rect x="3" y="11" width="6" height="3" rx="1" className="b3" />
          </svg>
          Gantrix
        </a>
        {nav.map(([page, title]) => (
          <a key={page} href={`#/${page}`} className={current === page ? 'active' : ''}>
            {title}
            {page === 'approvals' && pending > 0 && <span className="badge">{pending}</span>}
          </a>
        ))}
        <button
          type="button"
          className="ghost small signout"
          onClick={() => {
            setToken('');
            setState('need');
          }}
        >
          Forget token
        </button>
      </nav>
      <main>
        {route.page === 'tasks' && <TasksPage />}
        {route.page === 'task' && <TaskPage id={route.id} />}
        {route.page === 'logs' && (
          <LogsPage id={route.id} {...(route.stepId ? { stepId: route.stepId } : {})} />
        )}
        {route.page === 'agents' && <AgentsPage />}
        {route.page === 'skills' && <SkillsPage />}
        {route.page === 'approvals' && <ApprovalsPage />}
      </main>
    </>
  );
}
