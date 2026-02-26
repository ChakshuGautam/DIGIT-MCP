import type { ToolMetadata } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { sessionStore } from '../services/session-store.js';

export function registerSessionTools(registry: ToolRegistry): void {
  // session_checkpoint — core group, always visible
  registry.register({
    name: 'session_checkpoint',
    group: 'core',
    category: 'sessions',
    risk: 'write',
    description:
      'Record a checkpoint summarizing your progress so far. Call this periodically (every 5-10 tool calls) to capture what you accomplished. The summary is persisted across sessions and searchable later.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description:
            'What you accomplished since the last checkpoint (or session start). Be specific: mention tenants, services, errors resolved.',
        },
        messages: {
          type: 'array',
          description:
            'Conversation turns to persist. Each has: turn (sequence number), role (user|assistant|tool_result), content (array of Anthropic content blocks).',
          items: {
            type: 'object',
            properties: {
              turn: { type: 'integer' },
              role: { type: 'string' },
              content: { type: 'array' },
            },
            required: ['turn', 'role', 'content'],
          },
        },
      },
      required: ['summary'],
    },
    handler: async (args) => {
      const summary = args.summary as string;
      if (!summary || summary.trim().length === 0) {
        return JSON.stringify({ success: false, error: 'Summary is required' }, null, 2);
      }

      const messages = Array.isArray(args.messages) ? args.messages as Array<{turn: number; role: string; content: unknown}> : undefined;
      const checkpoint = sessionStore.recordCheckpoint(summary.trim(), messages);
      const session = sessionStore.getSession();

      return JSON.stringify(
        {
          success: true,
          checkpoint: {
            sessionId: checkpoint.sessionId,
            seq: checkpoint.seq,
            ts: checkpoint.ts,
            summary: checkpoint.summary,
            recentTools: checkpoint.recentTools,
          },
          session: session
            ? {
                toolCount: session.toolCount,
                checkpointCount: session.checkpointCount,
                errorCount: session.errorCount,
              }
            : null,
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

}
