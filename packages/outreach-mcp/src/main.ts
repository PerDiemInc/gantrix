#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTransport } from 'nodemailer';
import { loadConfig } from './config.ts';
import { createServer, type SendFn } from './server.ts';

const config = loadConfig();
// stderr reaches the Gantrix worker log. The server still starts so agents can check contacts
// and keep drafting; send_email explains the setup.
if (config.problem) console.error(`gantrix-outreach-mcp: ${config.problem}`);

let transport: ReturnType<typeof createTransport> | undefined;
const send: SendFn = async (email) => {
  if (!config.settings) throw new Error('Outreach is not configured.');
  transport ??= createTransport(config.settings.SMTP_URL);
  const info = await transport.sendMail(email);
  return { messageId: info.messageId };
};

await createServer(config, send).connect(new StdioServerTransport());
