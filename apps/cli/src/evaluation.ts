/** Deterministic checks of real model outputs, independent of the model's own judge. */
export interface WorkflowCase {
  id: string;
  goal: string;
  expected: Record<string, unknown>;
}

export const workflowCases: WorkflowCase[] = [
  {
    id: 'sales-reconciliation',
    goal:
      'Reconcile a cafe daily sales export. Orders: A paid 1200 cents, B paid 800 cents, ' +
      'C cancelled 1500 cents, D paid 2000 cents with a 500 cent refund. Exclude cancelled ' +
      'orders; subtract refunds. Write report.json with exactly the JSON keys paidOrders, ' +
      'grossCents, refundCents, netCents. Use only file tools, no shell or network. ' +
      'The final report must be valid JSON, not Markdown. Assign only one step to write report.json.',
    expected: { paidOrders: 3, grossCents: 4000, refundCents: 500, netCents: 3500 },
  },
  {
    id: 'release-readiness',
    goal:
      'Assess release readiness from these records: iOS build 42 passed tests but is awaiting ' +
      'store review. Android build 31 is approved but checkout smoke test failed. ' +
      'Write report.json with exactly the keys ready (boolean), iosBlocker (one of review, tests, none), ' +
      'androidBlocker (one of review, tests, none), and nextActions (array of action codes). ' +
      'Choose actions from wait_ios_review, fix_android_checkout, deploy_both. ' +
      'A platform is ready only after review approval and passing tests. ' +
      'Use only file tools, no shell or network. Write valid JSON, not Markdown. ' +
      'Assign only one step to write report.json.',
    expected: {
      ready: false,
      iosBlocker: 'review',
      androidBlocker: 'tests',
      nextActions: ['wait_ios_review', 'fix_android_checkout'],
    },
  },
];

export function gradeOutput(raw: string, expected: Record<string, unknown>) {
  let actual: unknown;
  try {
    actual = JSON.parse(raw);
  } catch {
    return { passed: false, checks: { validJson: false } };
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return { passed: false, checks: { validJsonObject: false } };
  }
  const record = actual as Record<string, unknown>;
  const checks = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? Array.isArray(record[key]) &&
          JSON.stringify([...record[key]].sort()) === JSON.stringify([...value].sort())
        : record[key] === value,
    ]),
  );
  checks.exactKeys =
    Object.keys(record).sort().join(',') === Object.keys(expected).sort().join(',');
  return { passed: Object.values(checks).every(Boolean), checks };
}

/** Fail rather than silently grade a stale, ambiguous, or dependency snapshot artifact. */
export function findReport(files: string[], completedStepIds: string[]): string | null {
  const paths = files.filter(
    (path) =>
      path === 'report.json' || completedStepIds.some((id) => path === `steps/${id}/report.json`),
  );
  return paths.length === 1 ? (paths[0] ?? null) : null;
}
