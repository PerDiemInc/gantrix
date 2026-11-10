import { describe, expect, it } from 'vitest';
import { mentionedAgents } from '../src/mentions.ts';

const team = [
  { id: 'a', name: 'Lead' },
  { id: 'b', name: 'Lead Designer' },
  { id: 'c', name: 'Researcher' },
];
const names = (text: string) => mentionedAgents(text, team).map((a) => a.name);

describe('mentionedAgents', () => {
  it('finds a tag anywhere in the note, case-insensitively', () => {
    expect(names('@researcher check the prices')).toEqual(['Researcher']);
    expect(names('(from Slack) please @Researcher, check it')).toEqual(['Researcher']);
  });
  it('prefers the longest name, so names with spaces work', () => {
    expect(names('@Lead Designer redo the logo')).toEqual(['Lead Designer']);
    expect(names('@Lead decide')).toEqual(['Lead']);
  });
  it('lists each tagged agent once, in order', () => {
    expect(names('@Researcher then @Lead, and @researcher again')).toEqual(['Researcher', 'Lead']);
  });
  it('ignores emails, partial names and unknown names', () => {
    expect(names('mail bob@researcher.com')).toEqual([]);
    expect(names('@Researchers and @Nobody')).toEqual([]);
    expect(names('no tags here')).toEqual([]);
  });
});
