import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from './tools/registry.js';
import { registerAllTools } from './tools/index.js';
import { ALL_GROUPS } from './types/index.js';

export interface CreateServerOptions {
  enableAllGroups?: boolean;
}

export function createServer(options?: CreateServerOptions): Server {
  const registry = new ToolRegistry();
  registerAllTools(registry);

  if (options?.enableAllGroups) {
    registry.enableGroups(ALL_GROUPS);
  }

  const server = new Server(
    {
      name: 'crs-validator-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    }
  );

  // Wire up the listChanged notification
  registry.setToolListChangedCallback(() => {
    server.sendToolListChanged().catch((err) => {
      console.error('Failed to send tool list changed notification:', err);
    });
  });

  // ListTools — only returns enabled tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.getEnabledTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // CallTool — dispatches to handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = registry.getTool(name);
    if (!tool) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }, null, 2),
          },
        ],
        isError: true,
      };
    }

    if (!registry.isToolEnabled(name)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: `Tool "${name}" is in the "${tool.group}" group which is not currently enabled. Call enable_tools to enable it.`,
                activeGroups: registry.getEnabledGroups(),
                toolGroup: tool.group,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler((args || {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
