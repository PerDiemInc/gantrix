// What a local agent CLI (Claude Code, Codex) may see of the worker's environment. An allowlist:
// .env holds the Gantrix token, database URLs, Slack tokens and every connection's API key, and
// with shell access the CLI could print any of them. An API key would also make the CLI bill
// that key instead of the user's own login.
const ALLOWED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'TERM',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR',
]);
const ALLOWED_PREFIXES = ['LC_', 'XDG_', 'CLAUDE_CODE_', 'CODEX_'];

export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => ALLOWED.has(k) || ALLOWED_PREFIXES.some((p) => k.startsWith(p)),
    ),
  );
}
