import {
  type AgentDto,
  type AgentSetupDto,
  type AgentSetupResultDto,
  askedQuestions,
  type GithubAccessInput,
  interviewFor,
  looksSecret,
  MAX_SETUP_ANSWER_CHARS,
  renderSetupSkill,
  type SetupAnswers,
  type SetupQuestion,
} from '@gantrix/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api.ts';

/** "keep": leave the agent's access as it is. */
type Access = { mode: 'keep' | 'token' | 'env' | 'none' | string; token: string; repos: string };

export function toAccess(a: Access): GithubAccessInput | undefined {
  if (a.mode === 'keep') return undefined;
  if (a.mode === 'none') return { mode: 'none' };
  if (a.mode !== 'token' && a.mode !== 'env') return { mode: 'connection', connectionId: a.mode };
  const value = a.token.trim();
  if (!value) return undefined;
  // "owner/name, …" are repositories; a single word is a whole organization or user.
  const scope = a.repos.trim();
  const org = scope && !scope.includes('/') && !scope.includes(',') ? scope : '';
  return {
    mode: 'token',
    token: a.mode === 'env' ? `env:${value.replace(/^env:/, '')}` : value,
    ...(org ? { org } : scope ? { repos: scope } : {}),
  };
}

function GithubStep({
  state,
  access,
  onChange,
}: {
  state: AgentSetupDto;
  access: Access;
  onChange: (a: Access) => void;
}) {
  const current = state.githubConnections.find((c) => c.id === state.githubConnectionId);
  const typed = access.mode === 'token' || access.mode === 'env';
  return (
    <div className="stack-tight">
      <label>
        Access
        <select
          value={access.mode}
          onChange={(e) => onChange({ ...access, mode: e.target.value, token: '' })}
        >
          <option value="keep">{current ? `Keep ${current.name}` : 'Not now'}</option>
          <option value="token">Paste a token</option>
          <option value="env">Read the token from a variable in .env</option>
          {state.githubConnections
            .filter((c) => c.id !== current?.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                Use the saved connection {c.name}
              </option>
            ))}
          {current && <option value="none">Remove my GitHub access</option>}
        </select>
      </label>
      {typed && (
        <>
          <label>
            {access.mode === 'token' ? 'GitHub token' : 'Variable name'}
            <input
              type={access.mode === 'token' ? 'password' : 'text'}
              autoComplete="off"
              placeholder={access.mode === 'token' ? 'github_pat_…' : 'GITHUB_TOKEN'}
              value={access.token}
              onChange={(e) => onChange({ ...access, token: e.target.value })}
            />
          </label>
          <label>
            What may I read? <span className="muted small">(optional)</span>
            <input
              placeholder="acme/app, acme/api — or just acme for all of it"
              value={access.repos}
              onChange={(e) => onChange({ ...access, repos: e.target.value })}
            />
          </label>
          <p className="muted small">
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              Create a fine-grained token
            </a>{' '}
            with <b>Contents</b>, <b>Pull requests</b> and <b>Issues</b> set to <b>Read</b>. It is
            saved as a connection on this machine and is never put in the skill or shown to the
            model.
          </p>
        </>
      )}
    </div>
  );
}

function Wizard({
  agent,
  state,
  onClose,
  onSaved,
}: {
  agent: AgentDto;
  state: AgentSetupDto;
  onClose: () => void;
  onSaved: (r: AgentSetupResultDto) => void;
}) {
  const interview = interviewFor({
    name: agent.name,
    skills: agent.skills.filter((s) => s.id !== state.setup?.skillId),
  });
  const [answers, setAnswers] = useState<SetupAnswers>({ ...state.setup?.answers });
  const [access, setAccess] = useState<Access>({ mode: 'keep', token: '', repos: '' });
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const questions = askedQuestions(interview.questions, answers);
  const q: SetupQuestion | undefined = questions[at];
  const asked = new Set(questions.map((x) => x.id));
  const kept = Object.fromEntries(
    Object.entries(answers).filter(([id, a]) => asked.has(id) && a.trim()),
  );

  const next = (e?: FormEvent) => {
    e?.preventDefault();
    if (q && !q.kind && looksSecret(answers[q.id] ?? '')) {
      return setError(
        'That looks like a password or token. Take it out: answers go into the skill, which the model reads.',
      );
    }
    if (q?.kind && (access.mode === 'token' || access.mode === 'env') && !access.token.trim()) {
      return setError('Fill in the token or variable name, or press Skip.');
    }
    setError('');
    setAt(at + 1);
  };
  const skip = () => {
    if (q?.kind) setAccess({ mode: 'keep', token: '', repos: '' });
    else if (q) setAnswers({ ...answers, [q.id]: '' });
    setError('');
    setAt(at + 1);
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const github = asked.has('github') ? toAccess(access) : undefined;
      onSaved(
        await api.post<AgentSetupResultDto>(`/api/agents/${agent.id}/setup`, {
          answers: kept,
          ...(github ? { github } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const set = (value: string) => q && setAnswers({ ...answers, [q.id]: value });

  return (
    <div className="setup" aria-live="polite">
      {(at === 0 || !q) && (
        <p>
          <b>{agent.name}:</b> {q ? interview.intro : 'Here is my skill.'}
        </p>
      )}
      {q ? (
        <form className="stack-tight" onSubmit={next}>
          <p className="muted small">
            Question {at + 1} of {questions.length}
          </p>
          <p id={`setup-${agent.id}`}>
            <b>{q.ask}</b>
            {q.why && <span className="muted small"> {q.why}</span>}
          </p>
          {q.kind === 'github' ? (
            <GithubStep state={state} access={access} onChange={setAccess} />
          ) : (
            <>
              {q.options && (
                <div className="chips">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className={answers[q.id] === o ? 'primary small' : 'ghost small'}
                      aria-pressed={answers[q.id] === o}
                      onClick={() => set(o)}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              {q.multiline ? (
                <textarea
                  key={q.id}
                  rows={3}
                  aria-labelledby={`setup-${agent.id}`}
                  maxLength={MAX_SETUP_ANSWER_CHARS}
                  placeholder={q.placeholder}
                  value={answers[q.id] ?? ''}
                  onChange={(e) => set(e.target.value)}
                />
              ) : (
                <input
                  key={q.id}
                  aria-labelledby={`setup-${agent.id}`}
                  maxLength={MAX_SETUP_ANSWER_CHARS}
                  placeholder={q.options ? 'or type your own answer' : q.placeholder}
                  value={answers[q.id] ?? ''}
                  onChange={(e) => set(e.target.value)}
                />
              )}
            </>
          )}
          <div className="row-actions">
            <button type="submit" className="primary small">
              Next
            </button>
            <button type="button" className="ghost small" onClick={skip}>
              Skip
            </button>
            {at > 0 && (
              <button type="button" className="ghost small" onClick={() => setAt(at - 1)}>
                Back
              </button>
            )}
            <button type="button" className="ghost small" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="stack-tight">
          <pre className="setup-preview">
            {renderSetupSkill({
              agentName: agent.name,
              interview,
              answers: kept,
              version: '(next)',
            })}
          </pre>
          <div className="row-actions">
            <button
              type="button"
              className="primary small"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save skill'}
            </button>
            <button type="button" className="ghost small" onClick={() => setAt(at - 1)}>
              Back
            </button>
            <button type="button" className="ghost small" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** "Set up": the agent asks how you work and writes its own skill from the answers. */
export function AgentSetup({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const [state, setState] = useState<AgentSetupDto | null>(null);
  const [result, setResult] = useState<AgentSetupResultDto['github']>(null);
  const [error, setError] = useState('');
  const open = async () => {
    setError('');
    setResult(null);
    try {
      setState(await api.get<AgentSetupDto>(`/api/agents/${agent.id}/setup`));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (state) {
    return (
      <Wizard
        agent={agent}
        state={state}
        onClose={() => setState(null)}
        onSaved={(r) => {
          setState(null);
          setResult(r.github);
          onSaved();
        }}
      />
    );
  }
  return (
    <div className="small">
      <p className="runs-on">
        <span className="muted">Setup</span>{' '}
        <b>{agent.setup ? 'done' : "doesn't know how you work yet"}</b>
        {agent.githubConnectionId && <span className="muted"> · reads GitHub</span>}{' '}
        <button
          type="button"
          className={agent.setup ? 'ghost small' : 'primary small'}
          onClick={() => void open()}
        >
          {agent.setup ? 'Redo' : 'Set up'}
        </button>
      </p>
      {result && (
        <p className="ok-note" role="status">
          {result.reply}
          {result.warning && <span className="error"> {result.warning}</span>}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
