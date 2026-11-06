import type { AgentDto, StreamEvent, TaskDetailDto } from '@gantrix/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe } from './api.ts';

export type Route =
  | { page: 'projects' }
  | { page: 'project'; id: string }
  | { page: 'logs'; id: string; stepId?: string }
  | { page: 'agents' }
  | { page: 'skills' }
  | { page: 'connections' }
  | { page: 'approvals' };

function parseHash(hash: string): Route {
  const [, page, id, sub, stepId] = hash.replace(/^#/, '').split('/');
  // "tasks" is the old name; links from before the projects view keep working.
  const isProject = page === 'projects' || page === 'tasks';
  if (isProject && id && sub === 'logs') {
    return stepId ? { page: 'logs', id, stepId } : { page: 'logs', id };
  }
  if (isProject && id) return { page: 'project', id };
  if (page === 'agents' || page === 'skills' || page === 'connections' || page === 'approvals') {
    return { page };
  }
  return { page: 'projects' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const go = (hash: string) => {
  location.hash = hash;
};

/** Re-renders every `ms` while `active`, for live elapsed times and growing bars. */
export function useNow(ms: number, active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, active]);
  return now;
}

/** Calls `fn` at most once per `ms`, trailing, so a burst of events causes one reload. */
function useDebounced(fn: () => void, ms: number): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, ms);
  }, [ms]);
}

/** Loads with `load`, then reloads whenever the stream at `streamPath` delivers an event. */
export function useLive<T>(load: () => Promise<T>, streamPath: string, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const reload = useCallback(() => {
    load().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: Error) => setError(e),
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass their own deps
  }, deps);
  const debounced = useDebounced(reload, 250);
  useEffect(() => {
    reload();
    return subscribe(streamPath, debounced);
  }, [reload, debounced, streamPath]);
  return { data, error, reload };
}

/** A task with its events, kept current over the task's stream. */
export function useTask(id: string) {
  const [task, setTask] = useState<TaskDetailDto | null>(null);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const reload = useCallback(() => {
    api.get<TaskDetailDto>(`/api/tasks/${id}`).then(setTask, setError);
  }, [id]);
  const debounced = useDebounced(reload, 250);
  useEffect(() => {
    setTask(null);
    setEvents([]);
    reload();
    return subscribe(`/api/stream?taskId=${id}`, (e) => {
      setEvents((list) => (list.some((x) => x.id === e.id) ? list : [...list, e]));
      debounced();
    });
  }, [id, reload, debounced]);
  return { task, events, error, reload };
}

export function useAgents(): Map<string, AgentDto> {
  const [agents, setAgents] = useState(new Map<string, AgentDto>());
  useEffect(() => {
    api
      .get<AgentDto[]>('/api/agents')
      .then((list) => setAgents(new Map(list.map((a) => [a.id, a]))));
  }, []);
  return agents;
}
