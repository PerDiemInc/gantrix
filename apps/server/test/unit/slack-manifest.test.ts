import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Manifest {
  oauth_config: { scopes: { bot: string[] } };
  settings: { event_subscriptions: { bot_events: string[] }; socket_mode_enabled: boolean };
  features: { bot_user: { display_name: string } };
}

const manifest = parse(
  readFileSync(
    fileURLToPath(new URL('../../../../docs/slack-app-manifest.yml', import.meta.url)),
    'utf8',
  ),
) as Manifest;

describe('the Slack app manifest people create the app from', () => {
  const scopes = manifest.oauth_config.scopes.bot;
  const events = manifest.settings.event_subscriptions.bot_events;

  it('lists only real scopes, once each: events such as message.im are not scopes', () => {
    expect(new Set(scopes).size).toBe(scopes.length);
    for (const scope of scopes) expect(scope, scope).toMatch(/^[a-z_]+(\.[a-z_]+)?:[a-z_]+$/);
    expect(scopes).toEqual(
      expect.arrayContaining(['chat:write', 'im:history', 'app_mentions:read']),
    );
  });

  it('subscribes to the events the Slack chat and project threads listen for, once each', () => {
    expect(new Set(events).size).toBe(events.length);
    expect(events).toEqual(
      expect.arrayContaining(['app_mention', 'message.im', 'message.channels', 'message.groups']),
    );
  });

  it('has a scope for every message event it subscribes to', () => {
    const needs: Record<string, string> = {
      'message.im': 'im:history',
      'message.channels': 'channels:history',
      'message.groups': 'groups:history',
      app_mention: 'app_mentions:read',
    };
    for (const event of events) expect(scopes, event).toContain(needs[event]);
  });

  it('uses Socket Mode, so no public URL is needed, and names the bot Gantrix', () => {
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.features.bot_user.display_name).toBe('Gantrix');
  });
});
