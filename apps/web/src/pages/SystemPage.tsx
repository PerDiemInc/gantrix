import type { ContainerStatsDto, SystemDto } from '@gantrix/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { bytes, duration } from '../format.ts';

/** `docker stats` takes about two seconds per sample, so a faster poll would only queue up. */
const POLL_MS = 5_000;

type SortKey = 'memory' | 'cpu' | 'name';

const SORTS: Record<SortKey, (a: ContainerStatsDto, b: ContainerStatsDto) => number> = {
  memory: (a, b) => b.memUsedBytes - a.memUsedBytes,
  cpu: (a, b) => b.cpuPercent - a.cpuPercent,
  name: (a, b) => a.name.localeCompare(b.name),
};

/** Polls while the tab is visible, one request at a time. */
function useSystem() {
  const [data, setData] = useState<SystemDto | null>(null);
  const [error, setError] = useState('');
  const busy = useRef(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (busy.current || document.hidden) return;
      busy.current = true;
      try {
        const d = await api.get<SystemDto>('/api/system');
        if (live) {
          setData(d);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      busy.current = false;
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);
  return { data, error };
}

function Bar({ label, pct }: { label: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="meter-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div className={`meter-fill ${clamped > 85 ? 'hot' : ''}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function Stat({
  title,
  value,
  detail,
  pct,
}: {
  title: string;
  value: string;
  detail: string;
  pct: number;
}) {
  return (
    <section className="card stat">
      <h2>{title}</h2>
      <p className="stat-value num-tab">{value}</p>
      <Bar label={title} pct={pct} />
      <p className="muted small">{detail}</p>
    </section>
  );
}

function Containers({ containers }: { containers: ContainerStatsDto[] }) {
  const [sort, setSort] = useState<SortKey>('memory');
  const rows = [...containers].sort(SORTS[sort]);
  const head = (key: SortKey, title: string, className?: string) => (
    <th
      className={className}
      aria-sort={sort === key ? (key === 'name' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`sort ${sort === key ? 'active' : ''}`}
        onClick={() => setSort(key)}
      >
        {title}
      </button>
    </th>
  );
  if (!rows.length) return <p className="muted">No containers are running.</p>;
  return (
    <div className="table-scroll">
      <table className="list containers">
        <thead>
          <tr>
            {head('name', 'Container')}
            <th>Status</th>
            {head('cpu', 'CPU', 'w-meter')}
            {head('memory', 'Memory', 'w-meter')}
            <th className="num">PIDs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <div className="goal">{c.name}</div>
                <div className="muted small mono">
                  {c.project ? `${c.project} · ` : ''}
                  {c.image}
                </div>
              </td>
              <td className="small">{c.status}</td>
              <td>
                <div className="num-tab small">{c.cpuPercent.toFixed(1)}%</div>
                <Bar label={`${c.name} CPU`} pct={c.cpuPercent} />
              </td>
              <td>
                <div className="num-tab small">
                  {bytes(c.memUsedBytes)}
                  <span className="muted"> / {bytes(c.memLimitBytes)}</span>
                </div>
                <Bar label={`${c.name} memory`} pct={c.memPercent} />
              </td>
              <td className="num num-tab">{c.pids}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SystemPage() {
  const { data, error } = useSystem();
  const host = data?.host;
  const docker = data?.docker;
  const used = host ? host.memTotalBytes - host.memAvailableBytes : 0;
  const dockerMem = docker?.available
    ? docker.containers.reduce((sum, c) => sum + c.memUsedBytes, 0)
    : 0;
  const dockerCpu = docker?.available
    ? docker.containers.reduce((sum, c) => sum + c.cpuPercent, 0)
    : 0;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>System</h1>
          <p className="muted">
            Memory and CPU on this machine and its running Docker containers. Updates every{' '}
            {POLL_MS / 1000}s.
          </p>
        </div>
        {data && (
          <span className="muted small">
            <Icon name="clock" size={12} /> {new Date(data.sampledAt).toLocaleTimeString()}
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Measuring…</p>}

      {host && (
        <div className="stats">
          <Stat
            title="Memory"
            value={`${bytes(used)} / ${bytes(host.memTotalBytes)}`}
            detail={`${bytes(host.memAvailableBytes)} available · Gantrix API uses ${bytes(data.gantrix.rssBytes)}`}
            pct={(used / host.memTotalBytes) * 100}
          />
          <Stat
            title="CPU load"
            value={`${host.loadAvg[0].toFixed(2)} / ${host.cpus} cores`}
            detail={`5 min ${host.loadAvg[1].toFixed(2)} · 15 min ${host.loadAvg[2].toFixed(2)} · up ${duration(host.uptimeSeconds * 1000)}`}
            pct={(host.loadAvg[0] / host.cpus) * 100}
          />
          {docker?.available && (
            <>
              <Stat
                title="Docker memory"
                value={`${bytes(dockerMem)} / ${bytes(docker.memTotalBytes)}`}
                detail={`${docker.containers.length} running · Docker ${docker.version}`}
                pct={(dockerMem / docker.memTotalBytes) * 100}
              />
              <Stat
                title="Docker CPU"
                value={`${dockerCpu.toFixed(1)}%`}
                detail={`of ${docker.cpus * 100}% (${docker.cpus} CPUs)`}
                pct={dockerCpu / docker.cpus}
              />
            </>
          )}
        </div>
      )}

      {docker && (
        <section className="card">
          <h2>Containers</h2>
          {docker.available ? (
            <Containers containers={docker.containers} />
          ) : (
            <p className="muted">{docker.error}</p>
          )}
        </section>
      )}
    </div>
  );
}
