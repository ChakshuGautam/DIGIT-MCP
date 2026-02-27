#!/usr/bin/env node
import { createServer } from './server.js';
import { mcpLogger } from './logger.js';
import { sessionStore } from './services/session-store.js';
import { db } from './services/db.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const transportMode = process.env.MCP_TRANSPORT === 'http' ? 'http' : 'stdio';

if (transportMode === 'stdio') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const enableAll = process.env.MCP_ENABLE_ALL_GROUPS === '1' || process.env.MCP_ENABLE_ALL_GROUPS === 'true';
  const server = createServer(enableAll ? { enableAllGroups: true } : undefined);
  const transport = new StdioServerTransport();
  await sessionStore.ensureSession('stdio');
  server.connect(transport).catch(console.error);
} else {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const http = await import('node:http');

  const port = parseInt(process.env.MCP_PORT || '3000', 10);

  // --- Static file serving setup ---
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const UI_DIR = resolve(join(__dirname, '..', 'ui'));

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function parseQuery(url: string): Record<string, string> {
    const idx = url.indexOf('?');
    if (idx === -1) return {};
    const params: Record<string, string> = {};
    for (const part of url.slice(idx + 1).split('&')) {
      const [k, v] = part.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return params;
  }

  async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    const resolved = resolve(join(UI_DIR, filePath));

    // Path traversal protection
    if (!resolved.startsWith(UI_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    try {
      const info = await stat(resolved);
      if (!info.isFile()) throw new Error('Not a file');

      const ext = extname(resolved);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await readFile(resolved);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }

  // Initialize DB for API endpoints (best-effort, same as session-store)
  await db.initialize();

  // --- HTTP server ---

  const httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const pathname = url.split('?')[0];

    // Health check endpoint (used by K8s probes) — don't log
    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'http', timestamp: new Date().toISOString() }));
      return;
    }

    // MCP endpoint — stateless mode for horizontal scaling
    if (pathname === '/mcp') {
      await sessionStore.ensureSession('http');
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

    // --- API endpoints ---

    if (req.method === 'GET' && pathname === '/api/stats') {
      if (!db.isHealthy()) {
        jsonResponse(res, 200, { error: 'Database not available', total_sessions: 0, total_tools: 0, total_errors: 0, total_checkpoints: 0 });
        return;
      }
      try {
        const rows = await db.query(
          `SELECT count(*) as total_sessions, coalesce(sum(tool_count),0) as total_tools,
                  coalesce(sum(error_count),0) as total_errors, coalesce(sum(checkpoint_count),0) as total_checkpoints
           FROM sessions`
        );
        const row = rows[0] || {};
        jsonResponse(res, 200, {
          total_sessions: parseInt(String(row.total_sessions || '0'), 10),
          total_tools: parseInt(String(row.total_tools || '0'), 10),
          total_errors: parseInt(String(row.total_errors || '0'), 10),
          total_checkpoints: parseInt(String(row.total_checkpoints || '0'), 10),
        });
      } catch (err) {
        jsonResponse(res, 200, { error: String(err), total_sessions: 0, total_tools: 0, total_errors: 0, total_checkpoints: 0 });
      }
      return;
    }

    // Events endpoint (must be before /api/sessions to avoid prefix match)
    const eventsMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/events$/);
    if (req.method === 'GET' && eventsMatch) {
      const sessionId = eventsMatch[1];
      if (!db.isHealthy()) {
        jsonResponse(res, 200, { error: 'Database not available', session_id: sessionId, events: [] });
        return;
      }
      try {
        // Fetch session metadata
        const sessionRows = await db.query(
          `SELECT id, started_at, environment, transport, tool_count, checkpoint_count, error_count,
                  last_checkpoint_summary, updated_at, user_name, user_purpose
           FROM sessions WHERE id = $1`,
          [sessionId]
        );
        const session = sessionRows[0] || null;

        const events = await db.query(
          `SELECT seq, ts, type, tool, args, duration_ms, is_error, result_summary,
                  error_message, summary, recent_tools
           FROM events WHERE session_id = $1
           ORDER BY seq ASC, CASE type WHEN 'tool_call' THEN 0 WHEN 'tool_result' THEN 1 WHEN 'checkpoint' THEN 2 END`,
          [sessionId]
        );

        const messages = await db.query(
          `SELECT turn, role, content, ts FROM messages WHERE session_id = $1 ORDER BY turn ASC`,
          [sessionId]
        );

        jsonResponse(res, 200, { session_id: sessionId, session, events, messages });
      } catch (err) {
        jsonResponse(res, 200, { error: String(err), session_id: sessionId, events: [] });
      }
      return;
    }

    // POST messages endpoint
    const messagesMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/messages$/);
    if (req.method === 'POST' && messagesMatch) {
      const sessionId = messagesMatch[1];
      if (!db.isHealthy()) {
        jsonResponse(res, 503, { error: 'Database not available' });
        return;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const messages = body.messages;
        if (!Array.isArray(messages)) {
          jsonResponse(res, 400, { error: 'messages must be an array' });
          return;
        }
        // Count tools and errors from message content blocks
        let toolCount = 0;
        let errorCount = 0;
        const toolSequence: string[] = [];
        for (const msg of messages) {
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of blocks) {
            if (block.type === 'tool_use') {
              toolCount++;
              const name = (block.name || '').replace(/^mcp__\w+__/, '');
              if (name) toolSequence.push(name);
            }
            if (block.type === 'tool_result' && block.is_error) {
              errorCount++;
            }
          }
        }

        // Auto-create session if it doesn't exist, otherwise update counters
        db.execute(
          `INSERT INTO sessions (id, started_at, environment, transport, tool_count, error_count, tool_sequence, updated_at)
           VALUES ($1, NOW(), $2, 'http', $3, $4, $5, NOW())
           ON CONFLICT (id) DO UPDATE SET
             tool_count = sessions.tool_count + $3,
             error_count = sessions.error_count + $4,
             tool_sequence = array_cat(sessions.tool_sequence, $5),
             updated_at = NOW()`,
          [sessionId, body.environment || 'agent-test', toolCount, errorCount, toolSequence]
        );

        for (const msg of messages) {
          db.execute(
            `INSERT INTO messages (session_id, turn, role, content, ts)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (session_id, turn) DO UPDATE SET role=EXCLUDED.role, content=EXCLUDED.content, ts=EXCLUDED.ts`,
            [sessionId, msg.turn, msg.role, JSON.stringify(msg.content)]
          );
        }
        jsonResponse(res, 200, { session_id: sessionId, inserted: messages.length, tools: toolCount });
      } catch (err) {
        jsonResponse(res, 400, { error: String(err) });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      if (!db.isHealthy()) {
        jsonResponse(res, 200, { error: 'Database not available', sessions: [], total: 0, limit: 50, offset: 0 });
        return;
      }
      try {
        const q = parseQuery(url);
        const limit = Math.min(parseInt(q.limit || '50', 10) || 50, 200);
        const offset = parseInt(q.offset || '0', 10) || 0;

        const countRows = await db.query('SELECT count(*) as total FROM sessions');
        const total = parseInt(String(countRows[0]?.total || '0'), 10);

        const sessions = await db.query(
          `SELECT id, started_at, environment, transport, tool_count, checkpoint_count,
                  error_count, last_checkpoint_summary, updated_at, user_name, user_purpose
           FROM sessions ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        jsonResponse(res, 200, { sessions, total, limit, offset });
      } catch (err) {
        jsonResponse(res, 200, { error: String(err), sessions: [], total: 0, limit: 50, offset: 0 });
      }
      return;
    }

    // --- Static file serving (fallback for non-API GETs) ---
    if (req.method === 'GET') {
      await serveStatic(res, pathname);
      return;
    }

    // --- 404 ---
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(port, '0.0.0.0', () => {
    mcpLogger.log({ event: 'startup', port, logPath: mcpLogger.logPath });
    console.error(`DIGIT MCP server listening on http://0.0.0.0:${port}/mcp`);
    console.error(`Session viewer: http://0.0.0.0:${port}/`);
    console.error(`Health check: http://0.0.0.0:${port}/healthz`);
    console.error(`Logging to: ${mcpLogger.logPath}`);
  });
}
