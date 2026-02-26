#!/usr/bin/env node
import { createServer } from './server.js';
import { mcpLogger } from './logger.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const transportMode = process.env.MCP_TRANSPORT === 'http' ? 'http' : 'stdio';

if (transportMode === 'stdio') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const enableAll = process.env.MCP_ENABLE_ALL_GROUPS === '1' || process.env.MCP_ENABLE_ALL_GROUPS === 'true';
  const server = createServer(enableAll ? { enableAllGroups: true } : undefined);
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
} else {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const http = await import('node:http');

  const port = parseInt(process.env.MCP_PORT || '3000', 10);

  const httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';

    // Health check endpoint (used by K8s probes) — don't log
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'http', timestamp: new Date().toISOString() }));
      return;
    }

    // MCP endpoint — stateless mode for horizontal scaling
    if (url === '/mcp') {
      // Stash client info on the request for the logger to pick up in tool handlers
      const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
      const userAgent = req.headers['user-agent'] || '';
      mcpLogger.setRequestContext(String(clientIp).split(',')[0].trim(), userAgent);

      const server = createServer({ enableAllGroups: true });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(port, '0.0.0.0', () => {
    mcpLogger.log({ event: 'startup', port, logPath: mcpLogger.logPath });
    console.error(`DIGIT MCP server listening on http://0.0.0.0:${port}/mcp`);
    console.error(`Health check: http://0.0.0.0:${port}/healthz`);
    console.error(`Logging to: ${mcpLogger.logPath}`);
  });
}
