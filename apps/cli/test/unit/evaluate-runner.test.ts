import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { workflowCases } from '../../src/evaluation.ts';

it('runs both workflows through the API with approvals enabled and reports independent checks', async () => {
  let created = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    const path = req.url ?? '';
    if (path.startsWith('/api/agents/'))
      return res.end(
        JSON.stringify({ id: 'agent', name: 'test', model: 'fake', connectionId: null }),
      );
    if (req.method === 'POST' && path === '/api/tasks') {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      return res.end(JSON.stringify({ id: String(created++) }));
    }
    const index = Number(path.split('/')[3]);
    if (path.endsWith('/files'))
      return res.end(JSON.stringify({ files: ['steps/step/report.json'] }));
    if (path.includes('/files/content')) {
      res.setHeader('content-type', 'text/plain');
      return res.end(JSON.stringify(workflowCases[index]?.expected));
    }
    return res.end(
      JSON.stringify({
        id: String(index),
        status: 'succeeded',
        approvals: [],
        steps: [{ id: 'step', status: 'succeeded', attempt: 1, tokensUsed: 20 }],
        tokensUsed: 50,
        replans: 0,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../src/evaluate.ts', import.meta.url)),
        '00000000-0000-4000-8000-000000000000',
      ],
      {
        env: {
          ...process.env,
          GANTRIX_TOKEN: 'test-token',
          GANTRIX_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });
    expect(code, stderr).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.approveAll === false && body.slack === false)).toBe(true);
    const report = JSON.parse(stdout);
    expect(
      report.reports.every(
        (r: { passed: boolean; costUsd: null }) => r.passed && r.costUsd === null,
      ),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
