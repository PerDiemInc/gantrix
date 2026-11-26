import type { ApprovalListItem } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, getToken, setToken, subscribe } from './api.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { NewMenu } from './components/NewMenu.tsx';
import { useRoute } from './hooks.ts';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { ApprovalsPage } from './pages/ApprovalsPage.tsx';
import { ConnectionsPage } from './pages/ConnectionsPage.tsx';
import { ConnectSlackPage } from './pages/ConnectSlackPage.tsx';
import { LogsPage } from './pages/LogsPage.tsx';
import { MeetingsPage } from './pages/MeetingsPage.tsx';
import { NewPage } from './pages/NewPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { SkillsPage } from './pages/SkillsPage.tsx';
import { SystemPage } from './pages/SystemPage.tsx';
import { ProjectPage } from './pages/TaskPage.tsx';

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
    ['projects', 'Projects'],
    ['meetings', 'Meetings'],
    ['agents', 'Agents'],
    ['skills', 'Skills'],
    ['connections', 'Connections'],
    ['approvals', 'Approvals'],
    ['settings', 'Settings'],
    ['system', 'System'],
  ] as const;
  const current =
    route.page === 'project' ||
    route.page === 'logs' ||
    route.page === 'live' ||
    route.page === 'jobs'
      ? 'projects'
      : route.page === 'connect'
        ? 'connections'
        : route.page === 'new'
          ? route.kind === 'agent'
            ? 'agents'
            : 'projects'
          : route.page;
  return (
    <>
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById('main')?.focus()}
      >
        Skip to content
      </button>
      <nav className="top">
        <a href="#/projects" className="brand">
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
        <div className="nav-actions">
          <NewMenu />
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setToken('');
              setState('need');
            }}
          >
            Forget token
          </button>
        </div>
      </nav>
      <main id="main" tabIndex={-1}>
        <ErrorBoundary resetKey={location.hash}>
          {route.page === 'projects' && <ProjectsPage />}
          {route.page === 'jobs' && <ProjectsPage initialView="jobs" />}
          {route.page === 'new' && <NewPage kind={route.kind} />}
          {route.page === 'connect' && <ConnectSlackPage />}
          {route.page === 'project' && <ProjectPage id={route.id} />}
          {route.page === 'logs' && (
            <LogsPage id={route.id} {...(route.stepId ? { stepId: route.stepId } : {})} />
          )}
          {route.page === 'meetings' && <MeetingsPage />}
          {route.page === 'agents' && <AgentsPage />}
          {route.page === 'skills' && <SkillsPage />}
          {route.page === 'connections' && <ConnectionsPage />}
          {route.page === 'approvals' && <ApprovalsPage />}
          {route.page === 'live' && <ProjectsPage initialView="agents" />}
          {route.page === 'settings' && <SettingsPage />}
          {route.page === 'system' && <SystemPage />}
        </ErrorBoundary>
      </main>
    </>
  );
}
