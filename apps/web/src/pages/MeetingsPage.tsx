import type { AgentDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api.ts';
import { ModelPicker } from '../components/ModelPicker.tsx';

type Choice = { connectionId: string; model: string };
type Message = { speaker: string; text: string; model?: string };

export function MeetingsPage() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const latestChoices = useRef<Record<string, Choice>>({});
  const [history, setHistory] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState('');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    api.get<AgentDto[]>('/api/agents').then(setAgents, (e: Error) => setError(e.message));
    return () => active.current?.abort();
  }, []);

  function choose(id: string, value: Choice | undefined) {
    const next = { ...latestChoices.current };
    if (value) next[id] = value;
    else delete next[id];
    latestChoices.current = next;
    setChoices(next);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (active.current || !draft.trim() || !picked.length) return;
    const team = agents.filter((a) => picked.includes(a.id) && (!target || a.id === target));
    if (!team.length) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    let transcript: Message[] = [...history, { speaker: 'You', text: draft.trim() }];
    setHistory(transcript);
    setDraft('');
    try {
      for (const agent of team) {
        if (controller.signal.aborted) break;
        const choice = latestChoices.current[agent.id];
        setSpeaking(agent.name);
        setPartial('');
        const response = await fetch('/api/meetings/turn', {
          method: 'POST',
          headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            agentId: agent.id,
            ...(choice ? { override: { connectionId: choice.connectionId || null, model: choice.model.trim() || null } } : {}),
            history: transcript.slice(-40).map((m) => ({ speaker: m.speaker, text: m.text.slice(0, 16000) })),
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Turn failed (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        let complete = false;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              const item = JSON.parse(line) as { text?: string; error?: string; done?: boolean };
              if (item.error) throw new Error(item.error);
              if (item.done) complete = true;
              if (item.text) {
                text += item.text;
                setPartial(text);
              }
              newline = buffer.indexOf('\n');
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (!complete || controller.signal.aborted) break;
        transcript = [...transcript, { speaker: agent.name, text: text || 'No response.', model: choice?.model || (!choice ? agent.model : null) || 'default' }];
        setHistory(transcript);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (active.current === controller) active.current = null;
      setBusy(false);
      setSpeaking('');
      setPartial('');
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h1>Meetings</h1>
        <p className="muted">Choose agents and their models. Changes apply to their next turn, without changing the saved agent. Selected agents see the shared transcript. Choosing a cloud model sends it the transcript and that agent's skill instructions.</p>
        <p className="muted small">Discussion only: tools are not executed here. Meetings are kept in this tab until you leave or reset.</p>
        <ul className="cards">
          {agents.map((agent) => (
            <li className="item" key={agent.id}>
              <label className="inline">
                <input type="checkbox" checked={picked.includes(agent.id)} disabled={busy} onChange={(e) => {
                  setPicked((prev) => e.target.checked ? [...prev, agent.id] : prev.filter((id) => id !== agent.id));
                  if (!e.target.checked && target === agent.id) setTarget('');
                }} />
                <strong>{agent.name}</strong>
              </label>
              <p>{agent.description}</p>
              <div className="chips">{agent.skills.map((skill) => <span className="chip" key={skill.id}>{skill.name}</span>)}</div>
              {picked.includes(agent.id) && (
                <div className="runs-on-edit">
                  <p className="small">Model: {choices[agent.id]?.model || (!choices[agent.id] ? agent.model : null) || 'default'}</p>
                  {choices[agent.id] ? <>
                    <ModelPicker connectionId={choices[agent.id]?.connectionId ?? ''} model={choices[agent.id]?.model ?? ''} onChange={(value) => choose(agent.id, value)} modelServersOnly />
                    <button type="button" className="ghost small" onClick={() => choose(agent.id, undefined)}>Use agent default</button>
                  </> : <button type="button" className="ghost small" onClick={() => choose(agent.id, { connectionId: '', model: '' })}>Change for meeting</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>Live discussion</h2>
        <div role="log" aria-live="polite">
          {history.map((message, i) => <div className="item" key={i}><strong>{message.speaker}</strong>{message.model && <span className="muted small"> · {message.model}</span>}<p style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p></div>)}
          {speaking && <div className="item"><strong>{speaking} · responding</strong><p style={{ whiteSpace: 'pre-wrap' }}>{partial}</p></div>}
        </div>
        <form className="stack" onSubmit={(event) => void send(event)}>
          <label>Address
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
              <option value="">Everyone</option>
              {agents.filter((a) => picked.includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label>Message<textarea rows={3} maxLength={16000} value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
          <div className="row-actions">
            <button className="primary" type="submit" disabled={busy || !picked.length || !draft.trim()}>Send</button>
            <button type="button" disabled={!busy} onClick={() => active.current?.abort()}>Interrupt</button>
            <button type="button" disabled={busy} onClick={() => { setHistory([]); setError(''); }}>Reset transcript</button>
          </div>
        </form>
        {error && <p role="alert" className="error">{error}</p>}
      </section>
    </div>
  );
}
