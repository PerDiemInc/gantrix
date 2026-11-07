import { describe, expect, it } from 'vitest';
import { findReport, gradeOutput, workflowCases } from '../../src/evaluation.ts';

describe('workflow evaluation', () => {
  it('accepts each ground truth, independent of object and action ordering', () => {
    for (const scenario of workflowCases) {
      expect(gradeOutput(JSON.stringify(scenario.expected), scenario.expected).passed).toBe(true);
    }
    expect(gradeOutput('{"actions":["b","a"]}', { actions: ['a', 'b'] }).passed).toBe(true);
  });
  it('rejects model self-approval, malformed JSON, incorrect values and missing or extra fields', () => {
    for (const raw of [
      'Looks good!',
      'null',
      '[]',
      '{}',
      '{"count":"3"}',
      '{"count":3,"extra":1}',
    ]) {
      expect(gradeOutput(raw, { count: 3 }).passed).toBe(false);
    }
  });
  it('requires one artifact from a completed step, not a copied input or failed attempt', () => {
    expect(findReport(['steps/one/report.json', 'steps/two/inputs/one/report.json'], ['one'])).toBe(
      'steps/one/report.json',
    );
    expect(findReport(['steps/failed/report.json'], ['one'])).toBeNull();
    expect(
      findReport(['steps/one/report.json', 'steps/two/report.json'], ['one', 'two']),
    ).toBeNull();
    expect(findReport(['report.json'], [])).toBe('report.json');
  });
});
