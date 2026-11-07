const AUTO_APPROVED = new Set(['read_file', 'write_file', 'list_files']);
// A skill is data, not user authorization. Only read-only web fetch can be waived by one;
// shell, publication and unknown MCP tools (which may send/pay/delete) must still ask.
const SKILL_APPROVABLE = new Set(['web_fetch']);

export function requiresApproval(tool: string, autoApprove: ReadonlySet<string>): boolean {
  return !AUTO_APPROVED.has(tool) && !(SKILL_APPROVABLE.has(tool) && autoApprove.has(tool));
}
