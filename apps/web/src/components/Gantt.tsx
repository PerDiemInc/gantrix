import type { AgentDto, StepDto } from '@gantrix/shared';
import { useEffect, useRef, useState } from 'react';
import { duration, label } from '../format.ts';
import { useNow } from '../hooks.ts';

const ROW = 34;
const BAR = 18;
const LABEL_W = 230;
const AXIS_H = 26;
const RIGHT_PAD = 24;
const ACTIVE = new Set(['queued', 'running', 'judging', 'awaiting_approval']);
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

interface Props {
  steps: StepDto[];
  agents: Map<string, AgentDto>;
  finishedAt: string | null;
  selected: string | null;
  onSelect: (stepId: string) => void;
}

/**
 * One row per step. A faint bar is time spent queued, a solid bar is time running, coloured by
 * status. Arrows link each step to the steps it waits for. Active bars grow every second.
 */
export function Gantt({ steps, agents, finishedAt, selected, onSelect }: Props) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const live = !finishedAt && steps.some((s) => ACTIVE.has(s.status));
  const now = useNow(1000, live);
  if (!steps.length) return <div className="gantt-empty">Waiting for the plan…</div>;

  const start = Math.min(...steps.map((s) => ms(s.queuedAt) ?? ms(s.createdAt) ?? now));
  const end = Math.max(
    start + 5_000,
    ms(finishedAt) ?? 0,
    ...steps.map((s) => ms(s.finishedAt) ?? (ms(s.queuedAt) ? now : start)),
  );
  const chartW = Math.max(width - LABEL_W - RIGHT_PAD, 160);
  const x = (t: number) => LABEL_W + ((t - start) / (end - start)) * chartW;
  const tick = TICK_STEPS.find((s) => (end - start) / s <= 8) ?? 3_600_000;
  const ticks = Array.from({ length: Math.floor((end - start) / tick) + 1 }, (_, i) => i * tick);
  const height = AXIS_H + steps.length * ROW + 8;

  // Where each step's bar ends, for dependency arrows (the newest step with that key wins).
  const rowOf = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.status !== 'superseded' || !rowOf.has(s.key)) rowOf.set(s.key, i);
  });
  const finishX = (s: StepDto) =>
    x(ms(s.finishedAt) ?? (ms(s.startedAt) ? now : (ms(s.queuedAt) ?? start)));

  return (
    <div className="gantt" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="Task timeline">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 6 6"
            refX="5"
            refY="3"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 z" className="dep-head" />
          </marker>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={x(start + t)}
              x2={x(start + t)}
              y1={AXIS_H - 6}
              y2={height}
              className="grid"
            />
            <text x={x(start + t)} y={AXIS_H - 10} className="tick">
              {duration(t)}
            </text>
          </g>
        ))}
        {steps.map((s, i) =>
          s.dependsOn.map((dep) => {
            const from = rowOf.get(dep);
            const fromStep = from === undefined ? undefined : steps[from];
            if (!fromStep || s.status === 'superseded') return null;
            const x1 = finishX(fromStep);
            const y1 = AXIS_H + (from ?? 0) * ROW + ROW / 2;
            // A step not queued yet starts no earlier than its dependency finishes.
            const x2 = Math.max(x(ms(s.queuedAt) ?? start), x1 + 12) - 2;
            const y2 = AXIS_H + i * ROW + ROW / 2;
            const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 14));
            return (
              <path
                key={`${s.id}-${dep}`}
                d={`M${x1},${y1} H${mid} V${y2} H${x2}`}
                className="dep"
                markerEnd="url(#arrow)"
              />
            );
          }),
        )}
        {steps.map((s, i) => {
          const y = AXIS_H + i * ROW;
          const queued = ms(s.queuedAt);
          const started = ms(s.startedAt);
          const finished = ms(s.finishedAt) ?? (started ? now : null);
          const agent = s.agentId ? (agents.get(s.agentId)?.name ?? '…') : 'deleted agent';
          const took = started && finished ? duration(finished - started) : '';
          const tip = [
            s.title,
            `${label(s.status)} · ${agent}${s.attempt > 1 ? ` · try ${s.attempt}` : ''}`,
            took && `running ${took}`,
            s.dependsOn.length ? `after: ${s.dependsOn.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG row can't be a <button>
            <g
              key={s.id}
              className={`row ${s.id === selected ? 'selected' : ''} ${s.status === 'superseded' ? 'old' : ''}`}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(s.id)}
              tabIndex={0}
              role="button"
            >
              <title>{tip}</title>
              <rect x={0} y={y} width={width} height={ROW} className="row-bg" />
              <circle cx={12} cy={y + ROW / 2} r={5} className={`dot s-${s.status}`} />
              <text x={24} y={y + ROW / 2 + 4} className="row-label">
                {s.key.length > 26 ? `${s.key.slice(0, 25)}…` : s.key}
              </text>
              {queued !== null && (
                <rect
                  x={x(queued)}
                  y={y + (ROW - BAR) / 2}
                  width={Math.max(2, x(started ?? now) - x(queued))}
                  height={BAR}
                  rx={4}
                  className="bar-wait"
                />
              )}
              {started !== null && finished !== null && (
                <rect
                  x={x(started)}
                  y={y + (ROW - BAR) / 2}
                  width={Math.max(3, x(finished) - x(started))}
                  height={BAR}
                  rx={4}
                  className={`bar s-${s.status}`}
                />
              )}
              {started !== null && finished !== null && x(finished) - x(started) > 46 && (
                <text x={x(started) + 6} y={y + ROW / 2 + 4} className="bar-text">
                  {took}
                  {s.attempt > 1 ? ` ×${s.attempt}` : ''}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
