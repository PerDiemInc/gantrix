import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { discussionTurns, pickOwner, stripThinking } from '../../src/engine/discussion.ts';

const team = (...names: string[]) => names.map((name) => ({ name }));

describe('project owner', () => {
  it('is the product or project manager when the team has one', () => {
    expect(pickOwner(team('engineer', 'cpo', 'designer'))?.name).toBe('cpo');
    expect(pickOwner(team('engineer', 'Project-Manager'))?.name).toBe('Project-Manager');
    // cpo outranks the others when several are there.
    expect(pickOwner(team('owner', 'cpo'))?.name).toBe('cpo');
  });

  it('is nobody in particular when no agent fits, and the default model speaks', () => {
    expect(pickOwner(team('engineer', 'designer'))).toBeNull();
    expect(pickOwner([])).toBeNull();
    // A name that merely contains the word does not count.
    expect(pickOwner(team('cpo-assistant'))).toBeNull();
  });
});

describe('discussion turns', () => {
  const said = (role: 'user' | 'owner', text: string) => ({ role, text });

  it('replays the conversation as chat turns and ends with the new question', () => {
    const turns = discussionTurns(
      [said('user', 'Status?'), said('owner', 'Two of five done.')],
      'Why?',
    );
    expect(turns.map((t) => t.constructor)).toEqual([HumanMessage, AIMessage, HumanMessage]);
    expect(turns.map((t) => t.content)).toEqual(['Status?', 'Two of five done.', 'Why?']);
  });

  it('keeps only the latest turns so a small model is not flooded', () => {
    const long = Array.from({ length: 40 }, (_, i) => said(i % 2 ? 'owner' : 'user', `m${i}`));
    const turns = discussionTurns(long, 'now');
    expect(turns).toHaveLength(13);
    expect(turns[0]?.content).toBe('m28');
    expect(turns.at(-1)?.content).toBe('now');
  });

  it("removes a reasoning model's inline thinking from the answer", () => {
    expect(stripThinking('<think>hmm\nlet me see</think>\nWe are on track.')).toBe(
      'We are on track.',
    );
    expect(stripThinking('Plain answer.')).toBe('Plain answer.');
    expect(stripThinking('<think>only thoughts</think>')).toBe('');
  });
});
