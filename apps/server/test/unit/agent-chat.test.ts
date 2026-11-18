import { describe, expect, it } from 'vitest';
import { parseAgentMessage } from '../../src/slack/agent-chat.ts';

const agent = (name: string) => ({ name }) as never;
const team = [agent('writer'), agent('writer-pro'), agent('cto')];

describe('parseAgentMessage', () => {
  it('takes the agent name off the front and drops the bot mention', () => {
    const r = parseAgentMessage('<@UBOT> writer: draft the update', 'UBOT', team);
    expect(r.agent?.name).toBe('writer');
    expect(r.text).toBe('draft the update');
  });

  it('prefers the longest matching name', () => {
    const r = parseAgentMessage('writer-pro, tighten this', 'UBOT', team);
    expect(r.agent?.name).toBe('writer-pro');
    expect(r.text).toBe('tighten this');
  });

  it("doesn't match a name that is only a prefix of a word", () => {
    const r = parseAgentMessage('writers are great', 'UBOT', team);
    expect(r.agent).toBeNull();
    expect(r.text).toBe('writers are great');
  });

  it('returns the whole text when no agent is named', () => {
    expect(parseAgentMessage('<@UBOT> what is left?', 'UBOT', team)).toEqual({
      agent: null,
      text: 'what is left?',
    });
  });
});
