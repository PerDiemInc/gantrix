/** What to call a project: its name, else the first line of its description or goal. */
export function projectTitle(p: {
  name: string | null;
  description: string | null;
  goal: string;
}): string {
  if (p.name?.trim()) return p.name.trim();
  const first = (p.description || p.goal).split('\n').find((l) => l.trim()) ?? p.goal;
  const line = first.replace(/^objective:\s*/i, '').trim();
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}
