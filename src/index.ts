#!/usr/bin/env node
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createServer();
const transport = new StdioServerTransport();

server.connect(transport).catch(console.error);
