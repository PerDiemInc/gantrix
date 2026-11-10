/**
 * "@Name" in a chat note tags an agent. Names can hold spaces ("Lead Designer"), so we match
 * the known names rather than a word pattern, longest first: "@Lead Designer" is that agent,
 * not one called "Lead". An "@" glued to a word (an email address) isn't a mention.
 */
export function mentionedAgents<A extends { name: string }>(
  text: string,
  agents: readonly A[],
): A[] {
  const byLength = [...agents]
    .filter((a) => a.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const found: A[] = [];
  const lower = text.toLowerCase();
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_.]/u.test(lower[at - 1] ?? '')) continue;
    const rest = lower.slice(at + 1);
    const agent = byLength.find((a) => {
      const name = a.name.toLowerCase();
      return rest.startsWith(name) && !/[\p{L}\p{N}_]/u.test(rest[name.length] ?? '');
    });
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}
