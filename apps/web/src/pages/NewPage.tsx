import { AgentForm } from '../components/AgentForm.tsx';
import { JobForm } from '../components/JobsPanel.tsx';
import { NEW_ITEMS } from '../components/NewMenu.tsx';
import { go, NEW_KINDS, type NewKind } from '../hooks.ts';
import { NewProject } from './ProjectsPage.tsx';

/** Where each kind lands once it exists. */
const AFTER: Record<Exclude<NewKind, 'project'>, string> = { job: '#/jobs', agent: '#/agents' };

/** The New menu's destination: one page, one form per kind, and a way to switch kinds. */
export function NewPage({ kind }: { kind: NewKind }) {
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>New {NEW_ITEMS[kind].title.toLowerCase()}</h1>
          <p className="muted">{NEW_ITEMS[kind].hint}.</p>
        </div>
      </header>

      <div className="segmented" role="tablist" aria-label="What to create">
        {NEW_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? 'active' : ''}
            onClick={() => go(`#/new/${k}`)}
          >
            {NEW_ITEMS[k].title}
          </button>
        ))}
      </div>

      {kind === 'project' && <NewProject onClose={() => go('#/projects')} />}
      {kind === 'job' && (
        <JobForm
          editing={null}
          onClose={() => go(AFTER.job)}
          // The form calls onSaved, then onClose: both land on the Jobs tab.
          onSaved={() => undefined}
        />
      )}
      {kind === 'agent' && (
        <AgentForm onCreated={() => go(AFTER.agent)} onCancel={() => go('#/agents')} />
      )}
    </div>
  );
}
