const AUTO_APPROVED = new Set(['read_file', 'write_file', 'list_files']);
// A skill can't waive these, so importing someone else's skill can't unlock them:
// shell runs anything, and deploy_site publishes.
const NEVER_AUTO_APPROVED = new Set(['shell', 'deploy_site']);

export function requiresApproval(tool: string, autoApprove: ReadonlySet<string>): boolean {
  if (NEVER_AUTO_APPROVED.has(tool)) return true;
  return !AUTO_APPROVED.has(tool) && !autoApprove.has(tool);
}
