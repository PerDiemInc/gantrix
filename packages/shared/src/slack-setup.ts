/**
 * Everything the "Connect Slack" guide needs that isn't a screen: where to send people in Slack,
 * and checks for what they paste back. Kept here so the dashboard and its tests share it.
 */

export const SLACK_LINKS = {
  /** Opens Slack's "create an app" flow. */
  createApp: 'https://api.slack.com/apps?new_app=1',
  /** Your apps: open one, then Install App, OAuth & Permissions and Basic Information. */
  yourApps: 'https://api.slack.com/apps',
  /** Slack's own walkthrough of creating an app from a manifest. */
  manifestDocs: 'https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/',
  /** Socket Mode and the app-level token it needs. */
  socketModeDocs: 'https://docs.slack.dev/apis/events-api/using-socket-mode',
  /** Slack's help page for finding a member's ID. */
  memberIdHelp: 'https://slack.com/help/articles/360003827751-Create-a-link-to-a-members-profile',
} as const;

/**
 * Slack's "create an app" page with the manifest already filled in (the `manifest_yaml` query
 * parameter, URL-encoded), so no pasting is needed.
 */
export const slackManifestUrl = (manifestYaml: string): string =>
  `${SLACK_LINKS.createApp}&manifest_yaml=${encodeURIComponent(manifestYaml)}`;

export type SlackTokenKind = 'bot' | 'app';

export interface TokenCheck {
  state: 'empty' | 'ok' | 'wrong';
  hint: string;
}

const WHERE: Record<SlackTokenKind, string> = {
  bot: 'the Bot User OAuth Token (xoxb-…) under OAuth & Permissions, after Install to Workspace',
  app: 'the app-level token (xapp-…) under Basic Information → App-Level Tokens',
};

/**
 * Whether what was pasted looks like the token that was asked for, with a hint when it is
 * another kind of Slack secret (they all look alike, and the page offers several).
 */
export function checkSlackToken(kind: SlackTokenKind, raw: string): TokenCheck {
  const value = raw.trim();
  if (!value) return { state: 'empty', hint: '' };
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return { state: 'ok', hint: "Read from the worker's environment when it runs." };
  }
  const want = kind === 'bot' ? 'xoxb-' : 'xapp-';
  if (/\s/.test(value)) {
    return { state: 'wrong', hint: 'Paste only the token, without spaces or other text.' };
  }
  if (value.startsWith(want)) {
    return value.length < 20
      ? { state: 'wrong', hint: 'That looks cut off. Copy the whole token.' }
      : { state: 'ok', hint: 'Looks right.' };
  }
  if (value.startsWith('xoxb-')) {
    return { state: 'wrong', hint: `That is the bot token. Here you need ${WHERE.app}.` };
  }
  if (value.startsWith('xapp-')) {
    return { state: 'wrong', hint: `That is the app-level token. Here you need ${WHERE.bot}.` };
  }
  if (/^xox[pe]-/.test(value)) {
    return {
      state: 'wrong',
      hint: `That is a user token, not what Gantrix needs. Use ${WHERE[kind]}.`,
    };
  }
  return {
    state: 'wrong',
    hint: `A ${kind === 'bot' ? 'bot' : 'app-level'} token starts with ${want}. Use ${WHERE[kind]}.`,
  };
}

/** A Slack member ID: U… (or W… on Enterprise Grid), upper-case letters and digits. */
const MEMBER_ID = /^[UW][A-Z0-9]{8,}$/;

export interface MemberIds {
  ids: string[];
  /** Things that were pasted but aren't member IDs, so the person can fix them. */
  rejected: string[];
}

/**
 * Member IDs from whatever was pasted: a list separated by commas, spaces or lines, mentions
 * like `<@U01ABCDE2F>`, `@U01ABCDE2F`, or profile links ending in the ID.
 */
export function parseSlackUserIds(text: string): MemberIds {
  const ids: string[] = [];
  const rejected: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const piece = raw
      .trim()
      .replace(/^<@/, '')
      .replace(/[>|].*$/, '')
      .replace(/^@/, '')
      .replace(/^.*\/team\//, '')
      .replace(/[/?#].*$/, '');
    if (!piece) continue;
    if (MEMBER_ID.test(piece)) {
      if (!ids.includes(piece)) ids.push(piece);
    } else rejected.push(raw.trim());
  }
  return { ids, rejected };
}

export interface SlackTestOutcome {
  ok: boolean;
  /** One sentence for the person. */
  summary: string;
  /** What to fix, when something is wrong; empty when all is well. */
  problems: { field: 'bot' | 'app'; message: string }[];
  bot: string | null;
  team: string | null;
  socketMode: boolean;
}

const EXPLAIN: Record<SlackTokenKind, Record<string, string>> = {
  bot: {
    invalid_auth:
      'Slack rejected the bot token. Copy it again from OAuth & Permissions → Bot User OAuth Token (it starts with xoxb-), after Install to Workspace.',
    not_authed: 'Slack got no bot token. Paste the Bot User OAuth Token (xoxb-…).',
    token_revoked: 'That bot token was revoked. Reinstall the app and copy the new token.',
    token_expired: 'That bot token expired. Reinstall the app and copy the new token.',
    account_inactive: 'The workspace or the app was deactivated. Reinstall the app.',
    not_allowed_token_type: 'That is not a bot token. Use the Bot User OAuth Token (xoxb-…).',
  },
  app: {
    invalid_auth:
      'Slack rejected the app-level token. Generate a new one under Basic Information → App-Level Tokens with the connections:write scope.',
    not_authed: 'Slack got no app-level token. Paste the token that starts with xapp-.',
    token_revoked: 'That app-level token was revoked. Generate a new one.',
    missing_scope:
      'The app-level token needs the connections:write scope. Generate a new token and add it.',
    not_allowed_token_type: 'That is not an app-level token. Use the one that starts with xapp-.',
    invalid_app_token: 'Slack rejected the app-level token. Generate a new one.',
  },
};

const explain = (field: SlackTokenKind, code: string) =>
  EXPLAIN[field][code] ??
  (code === 'ratelimited'
    ? 'Slack asked us to slow down. Wait a minute and test again.'
    : `Slack said: ${code}.`);

/**
 * Reads the result of testing a Slack connection (`POST /api/connections/:id/test`): it either
 * fails with "Slack said: <code>." for the bot token, or succeeds with "Bot <name> in <team>."
 * and says whether the app-level token opened Socket Mode.
 */
export function interpretSlackTest(result: {
  ok: boolean;
  reply?: string;
  error?: string;
}): SlackTestOutcome {
  const blank = { bot: null, team: null, socketMode: false };
  if (!result.ok) {
    const code = /Slack said: (\w+)/.exec(result.error ?? '')?.[1];
    const message = code ? explain('bot', code) : (result.error ?? 'The test failed.');
    return {
      ...blank,
      ok: false,
      summary: message,
      problems: [{ field: 'bot', message }],
    };
  }
  const reply = result.reply ?? '';
  const who = /^Bot (\S+) in (.+?)\./.exec(reply);
  const socketMode = reply.includes('Socket Mode works');
  const appCode = /App token: (\w+)/.exec(reply)?.[1];
  const problems: SlackTestOutcome['problems'] = [];
  if (appCode) problems.push({ field: 'app', message: explain('app', appCode) });
  else if (!socketMode) {
    problems.push({
      field: 'app',
      message: 'Add the app-level token so Gantrix can hear messages in Slack.',
    });
  }
  const bot = who?.[1] ?? null;
  const team = who?.[2] ?? null;
  return {
    ok: problems.length === 0,
    summary: problems.length
      ? problems.map((p) => p.message).join(' ')
      : `Connected as ${bot ?? 'the bot'}${team ? ` in ${team}` : ''}, and Socket Mode works.`,
    problems,
    bot,
    team,
    socketMode,
  };
}
