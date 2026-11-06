#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { accessToken, loadGoogleConfig, signIn } from './auth.ts';
import { createServer } from './server.ts';
import { SlidesApi } from './slides.ts';

const cfg = loadGoogleConfig();

if (process.argv[2] === 'auth') {
  try {
    await signIn(cfg);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else {
  // Starts even when Google isn't connected yet; each tool then explains the setup.
  const api = new SlidesApi(cfg.slidesApi, () => accessToken(cfg));
  await createServer(api).connect(new StdioServerTransport());
}
