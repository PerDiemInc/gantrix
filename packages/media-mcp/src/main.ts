#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { ComfyUI } from './providers/comfyui.ts';
import { licenseWarning } from './registry.ts';
import { createServer } from './server.ts';
import type { Provider } from './types.ts';

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  // stderr reaches the Gantrix worker log; the skill then fails to start with this message.
  console.error(`gantrix-media-mcp: ${(error as Error).message}`);
  process.exit(1);
}
for (const m of config.models) {
  const warning = licenseWarning(m);
  if (warning) console.error(warning);
}

const once = <T>(make: () => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};
const providers: Record<'comfyui', () => Provider> = {
  comfyui: once(() => new ComfyUI(config)),
};

await createServer(config, providers).connect(new StdioServerTransport());
