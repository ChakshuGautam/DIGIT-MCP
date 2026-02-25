import type { ToolMetadata } from '../types/index.js';
import type { ToolRegistry } from './registry.js';

const MCP_ENDPOINT = 'https://docs.digit.org/platform/~gitbook/mcp';

interface McpResult {
  result?: {
    content?: Array<{ type: string; text: string }>;
  };
}

async function searchDocs(query: string): Promise<Array<{ title: string; link: string; content: string }>> {
  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'searchDocumentation',
        arguments: { query },
      },
    }),
  });

  const text = await response.text();
  const results: Array<{ title: string; link: string; content: string }> = [];

  // Parse SSE response
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(line.slice(6)) as McpResult;
      const content = data.result?.content;
      if (!Array.isArray(content)) continue;

      for (const item of content) {
        if (item.type !== 'text' || !item.text) continue;
        const lines = item.text.split('\n');
        const titleLine = lines.find((l: string) => l.startsWith('Title: '));
        const linkLine = lines.find((l: string) => l.startsWith('Link: '));
        const contentStart = lines.findIndex((l: string) => l.startsWith('Content: '));
        const contentText = contentStart >= 0
          ? lines.slice(contentStart).join('\n').replace(/^Content: /, '')
          : '';

        results.push({
          title: titleLine?.replace('Title: ', '') || '(untitled)',
          link: linkLine?.replace('Link: ', '') || '',
          content: contentText.slice(0, 500),
        });
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return results;
}

export function registerDocsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'docs_search',
    group: 'docs',
    category: 'docs',
    risk: 'read',
    description:
      'Search the DIGIT documentation (docs.digit.org) for guides, API references, configuration details, architecture docs, and how-to articles. Covers all DIGIT modules: platform, PGR, works, sanitation, health, local governance, and public finance. Returns titles, links, and content snippets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "persister configuration", "PGR complaint workflow", "MDMS schema setup")',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = args.query as string;
      if (!query?.trim()) {
        return JSON.stringify({ success: false, error: 'query is required' });
      }

      try {
        const results = await searchDocs(query.trim());

        if (results.length === 0) {
          return JSON.stringify({
            success: true,
            query,
            count: 0,
            results: [],
            hint: 'No results found. Try broader or different search terms.',
          }, null, 2);
        }

        return JSON.stringify({
          success: true,
          query,
          count: results.length,
          results: results.map((r, i) => ({
            rank: i + 1,
            title: r.title,
            url: r.link,
            snippet: r.content,
          })),
        }, null, 2);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          success: false,
          error: `Documentation search failed: ${message}`,
          hint: 'The docs.digit.org search service may be temporarily unavailable.',
        }, null, 2);
      }
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'docs_get',
    group: 'docs',
    category: 'docs',
    risk: 'read',
    description:
      'Fetch the full markdown content of a DIGIT documentation page. Use docs_search first to find the URL, then pass it here to read the complete page. Accepts any docs.digit.org URL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The docs.digit.org page URL (e.g. "https://docs.digit.org/platform/platform/core-services/mdms-v2-master-data-management-service")',
        },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const url = args.url as string;
      if (!url?.trim()) {
        return JSON.stringify({ success: false, error: 'url is required' });
      }

      // Ensure it's a docs.digit.org URL
      if (!url.includes('docs.digit.org')) {
        return JSON.stringify({
          success: false,
          error: 'URL must be a docs.digit.org page',
          hint: 'Use docs_search to find valid documentation URLs.',
        });
      }

      // Append .md if not already present, handling query strings correctly
      let mdUrl: string;
      try {
        const parsed = new URL(url);
        if (!parsed.pathname.endsWith('.md')) {
          parsed.pathname = `${parsed.pathname}.md`;
        }
        mdUrl = parsed.toString();
      } catch {
        // Fallback for malformed URLs — simple append
        mdUrl = url.endsWith('.md') ? url : `${url}.md`;
      }

      try {
        const response = await fetch(mdUrl);
        if (!response.ok) {
          return JSON.stringify({
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
            hint: 'The page may not exist. Use docs_search to find valid URLs.',
          }, null, 2);
        }

        const contentType = response.headers.get('content-type') || '';
        // Accept text/markdown, text/plain, text/html (gitbook sometimes returns html), and octet-stream
        const isTextContent = contentType.includes('text/') || contentType.includes('application/octet-stream');
        if (!isTextContent) {
          return JSON.stringify({
            success: false,
            error: `Unexpected content type: ${contentType}`,
            hint: 'The URL may not point to a documentation page. Use docs_search to find valid URLs.',
          }, null, 2);
        }

        const markdown = await response.text();
        // Return the original URL (not the .md one) so agents don't bypass docs_get
        const displayUrl = url.endsWith('.md') ? url.replace(/\.md$/, '') : url;
        return JSON.stringify({
          success: true,
          url: displayUrl,
          content: markdown,
        }, null, 2);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          success: false,
          error: `Failed to fetch page: ${message}`,
        }, null, 2);
      }
    },
  } satisfies ToolMetadata);
}
