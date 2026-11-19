import { describe, expect, it } from 'vitest';
import {
  checkSlackToken,
  interpretSlackTest,
  parseSlackUserIds,
  SLACK_LINKS,
  slackManifestUrl,
} from '../src/slack-setup.ts';

const BOT = `xoxb-${'1'.repeat(40)}`;
const APP = `xapp-1-${'A'.repeat(40)}`;

describe('slack token checks', () => {
  it('accepts the right kind of token, or an env reference', () => {
    expect(checkSlackToken('bot', BOT).state).toBe('ok');
    expect(checkSlackToken('app', ` ${APP}\n`).state).toBe('ok');
    expect(checkSlackToken('bot', 'env:SLACK_BOT_TOKEN').state).toBe('ok');
    expect(checkSlackToken('app', '')).toEqual({ state: 'empty', hint: '' });
  });

  it('says which token was pasted when it is the other one', () => {
    expect(checkSlackToken('bot', APP)).toMatchObject({
      state: 'wrong',
      hint: expect.stringContaining('That is the app-level token'),
    });
    expect(checkSlackToken('app', BOT).hint).toContain('That is the bot token');
    expect(checkSlackToken('bot', 'xoxp-1-2-3-abcdef').hint).toContain('user token');
  });

  it('catches a cut-off token, stray text and secrets that are not tokens', () => {
    expect(checkSlackToken('bot', 'xoxb-123').hint).toContain('cut off');
    expect(checkSlackToken('bot', `${BOT} and more`).hint).toContain('without spaces');
    expect(checkSlackToken('app', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4').hint).toContain('xapp-');
  });
});

describe('slack member ids', () => {
  it('reads ids separated by commas, spaces or lines, once each', () => {
    expect(parseSlackUserIds('U01ABCDE2F, U02ZZZZZZZZ\nU01ABCDE2F')).toEqual({
      ids: ['U01ABCDE2F', 'U02ZZZZZZZZ'],
      rejected: [],
    });
  });

  it('understands mentions and profile links', () => {
    const { ids } = parseSlackUserIds(
      '<@U01ABCDE2F> <@U02ZZZZZZZZ|doron> https://acme.slack.com/team/W03YYYYYYYY @U04XXXXXXXX',
    );
    expect(ids).toEqual(['U01ABCDE2F', 'U02ZZZZZZZZ', 'W03YYYYYYYY', 'U04XXXXXXXX']);
  });

  it('hands back what is not an id, such as a name, so it can be fixed', () => {
    expect(parseSlackUserIds('U01ABCDE2F @doron general')).toEqual({
      ids: ['U01ABCDE2F'],
      rejected: ['@doron', 'general'],
    });
    expect(parseSlackUserIds('')).toEqual({ ids: [], rejected: [] });
  });
});

describe('slack test results', () => {
  it('reports a working connection', () => {
    expect(
      interpretSlackTest({ ok: true, reply: 'Bot gantrix in Acme Co. Socket Mode works.' }),
    ).toMatchObject({
      ok: true,
      bot: 'gantrix',
      team: 'Acme Co',
      socketMode: true,
      problems: [],
      summary: 'Connected as gantrix in Acme Co, and Socket Mode works.',
    });
  });

  it('points at the bot token when Slack rejects it', () => {
    const r = interpretSlackTest({ ok: false, error: 'Slack said: invalid_auth.' });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      { field: 'bot', message: expect.stringContaining('OAuth & Permissions') },
    ]);
  });

  it('points at the app-level token when only that one fails', () => {
    const r = interpretSlackTest({
      ok: true,
      reply: 'Bot gantrix in Acme Co. App token: invalid_auth.',
    });
    expect(r.ok).toBe(false);
    expect(r.bot).toBe('gantrix');
    expect(r.problems[0]).toMatchObject({ field: 'app' });
    expect(r.problems[0]?.message).toContain('connections:write');
    expect(
      interpretSlackTest({ ok: true, reply: 'Bot gantrix in Acme Co.' }).problems[0]?.field,
    ).toBe('app');
  });

  it('passes an error it does not know through, and explains rate limits', () => {
    expect(interpretSlackTest({ ok: false, error: 'Slack said: weird_thing.' }).summary).toBe(
      'Slack said: weird_thing.',
    );
    expect(interpretSlackTest({ ok: false, error: 'fetch failed' }).summary).toBe('fetch failed');
  });
});

describe('opening Slack with the manifest filled in', () => {
  it('puts the encoded manifest in the create-app link', () => {
    const url = slackManifestUrl('display_information:\n  name: Gantrix\n');
    expect(url.startsWith(`${SLACK_LINKS.createApp}&manifest_yaml=`)).toBe(true);
    expect(new URL(url).searchParams.get('manifest_yaml')).toBe(
      'display_information:\n  name: Gantrix\n',
    );
    expect(new URL(url).searchParams.get('new_app')).toBe('1');
  });
});
