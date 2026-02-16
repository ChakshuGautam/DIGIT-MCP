import type { ToolMetadata } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';

export function registerLocalizationTools(registry: ToolRegistry): void {
  registry.register({
    name: 'localization_search',
    group: 'localization',
    category: 'localization',
    risk: 'read',
    description:
      'Search localization messages for a tenant. Returns translated strings by locale and module. Useful for verifying that UI labels exist for departments, designations, complaint types, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to search localization for',
        },
        locale: {
          type: 'string',
          description: 'Locale code (default: "en_IN")',
        },
        module: {
          type: 'string',
          description: 'Module filter (e.g. "rainmaker-pgr", "rainmaker-common")',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const locale = (args.locale as string) || 'en_IN';
      const module = args.module as string | undefined;

      const messages = await digitApi.localizationSearch(tenantId, locale, module);

      return JSON.stringify(
        {
          success: true,
          tenantId,
          locale,
          module: module || '(all)',
          count: messages.length,
          messages: messages.slice(0, 100).map((m) => ({
            code: m.code,
            message: m.message,
            module: m.module,
          })),
          truncated: messages.length > 100,
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'localization_upsert',
    group: 'localization',
    category: 'localization',
    risk: 'write',
    description:
      'Create or update localization messages for a tenant. Upserts translated strings — if a code already exists it is updated, otherwise created. Use for adding UI labels for new departments, complaint types, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID',
        },
        locale: {
          type: 'string',
          description: 'Locale code (default: "en_IN")',
        },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Localization key (e.g. "DEPT_HEALTH")' },
              message: { type: 'string', description: 'Translated text' },
              module: { type: 'string', description: 'Module name (e.g. "rainmaker-common")' },
            },
            required: ['code', 'message', 'module'],
          },
          description: 'Array of localization messages to upsert',
        },
      },
      required: ['tenant_id', 'messages'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const locale = (args.locale as string) || 'en_IN';
      const messages = args.messages as { code: string; message: string; module: string }[];

      const result = await digitApi.localizationUpsert(tenantId, locale, messages);

      return JSON.stringify(
        {
          success: true,
          tenantId,
          locale,
          upserted: result.length,
          messages: result.map((m) => ({
            code: m.code,
            message: m.message,
            module: m.module,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);
}

async function ensureAuthenticated(): Promise<void> {
  if (digitApi.isAuthenticated()) return;
  const username = process.env.CRS_USERNAME;
  const password = process.env.CRS_PASSWORD;
  const tenantId = process.env.CRS_TENANT_ID || digitApi.getEnvironmentInfo().stateTenantId;
  if (!username || !password) {
    throw new Error('Not authenticated. Call the "configure" tool first, or set CRS_USERNAME/CRS_PASSWORD env vars.');
  }
  await digitApi.login(username, password, tenantId);
}
