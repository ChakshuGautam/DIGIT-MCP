import type { ToolMetadata } from '../types/index.js';
import { MDMS_SCHEMAS } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';
import { ENVIRONMENTS } from '../config/environments.js';

export function registerMdmsTenantTools(registry: ToolRegistry): void {
  // ──────────────────────────────────────────
  // core group
  // ──────────────────────────────────────────

  // configure — authenticate with a DIGIT environment
  registry.register({
    name: 'configure',
    group: 'core',
    category: 'environment',
    risk: 'read',
    description:
      'Connect to a DIGIT environment by logging in with credentials. This must be called before any tool that queries the DIGIT API. Accepts environment key, username, password, and tenant ID. If credentials are provided via CRS_USERNAME/CRS_PASSWORD env vars, those are used as defaults.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        environment: {
          type: 'string',
          description:
            'Environment to connect to. Available: ' +
            Object.keys(ENVIRONMENTS).join(', '),
        },
        username: {
          type: 'string',
          description: 'DIGIT username (default: CRS_USERNAME env var)',
        },
        password: {
          type: 'string',
          description: 'DIGIT password (default: CRS_PASSWORD env var)',
        },
        tenant_id: {
          type: 'string',
          description: 'Tenant ID for login (default: state tenant from environment config)',
        },
      },
    },
    handler: async (args) => {
      // Switch environment if requested
      if (args.environment) {
        digitApi.setEnvironment(args.environment as string);
      }

      const env = digitApi.getEnvironmentInfo();
      const username = (args.username as string) || process.env.CRS_USERNAME;
      const password = (args.password as string) || process.env.CRS_PASSWORD;
      const tenantId = (args.tenant_id as string) || process.env.CRS_TENANT_ID || env.stateTenantId;

      if (!username || !password) {
        return JSON.stringify(
          {
            success: false,
            error: 'Username and password are required. Provide them as arguments or set CRS_USERNAME/CRS_PASSWORD env vars.',
            environment: env,
          },
          null,
          2
        );
      }

      try {
        await digitApi.login(username, password, tenantId);
        const auth = digitApi.getAuthInfo();

        return JSON.stringify(
          {
            success: true,
            message: `Authenticated as "${username}" on ${env.name}`,
            environment: { name: env.name, url: env.url },
            user: auth.user
              ? {
                  userName: auth.user.userName,
                  name: auth.user.name,
                  tenantId: auth.user.tenantId,
                  roles: auth.user.roles?.map((r) => r.code),
                }
              : null,
          },
          null,
          2
        );
      } catch (error) {
        return JSON.stringify(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            environment: { name: env.name, url: env.url },
            hint: 'Check username/password and ensure the environment is reachable.',
          },
          null,
          2
        );
      }
    },
  } satisfies ToolMetadata);

  // get_environment_info — show current environment config
  registry.register({
    name: 'get_environment_info',
    group: 'core',
    category: 'environment',
    risk: 'read',
    description:
      'Show the current DIGIT environment configuration (name, URL, state tenant ID). Also lists all available environments that can be switched to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        switch_to: {
          type: 'string',
          description:
            'Optional: switch to a different environment before returning info. Available keys: ' +
            Object.keys(ENVIRONMENTS).join(', '),
        },
      },
    },
    handler: async (args) => {
      if (args.switch_to) {
        digitApi.setEnvironment(args.switch_to as string);
      }

      const env = digitApi.getEnvironmentInfo();
      return JSON.stringify(
        {
          success: true,
          current: env,
          available: Object.entries(ENVIRONMENTS).map(([key, e]) => ({
            key,
            name: e.name,
            url: e.url,
            stateTenantId: e.stateTenantId,
          })),
          authenticated: digitApi.isAuthenticated(),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // mdms_get_tenants — list tenants from MDMS
  registry.register({
    name: 'mdms_get_tenants',
    group: 'core',
    category: 'mdms',
    risk: 'read',
    description:
      'Fetch all tenant records from MDMS for the current environment. Returns tenant codes, names, and city info. Requires authentication — will attempt auto-login using CRS_USERNAME/CRS_PASSWORD env vars if not authenticated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state_tenant_id: {
          type: 'string',
          description: 'State-level tenant ID to query (default: from environment config)',
        },
      },
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const env = digitApi.getEnvironmentInfo();
      const stateTenantId = (args.state_tenant_id as string) || env.stateTenantId;

      const tenants = await digitApi.mdmsV2Search<Record<string, unknown>>(
        stateTenantId,
        MDMS_SCHEMAS.TENANT
      );

      return JSON.stringify(
        {
          success: true,
          environment: env.name,
          stateTenantId,
          count: tenants.length,
          tenants: tenants.map((t) => ({
            code: t.code,
            name: t.name,
            description: t.description,
            city: t.city,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // ──────────────────────────────────────────
  // mdms group
  // ──────────────────────────────────────────

  // validate_tenant — check if a tenant code exists
  registry.register({
    name: 'validate_tenant',
    group: 'mdms',
    category: 'validation',
    risk: 'read',
    description:
      'Validate that a tenant code exists in the MDMS tenant list. Returns the tenant details if found, or an error if not. Useful before running other validations that require a valid tenant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant code to validate (e.g. "pg.citya")',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const env = digitApi.getEnvironmentInfo();

      const tenants = await digitApi.mdmsV2Search<Record<string, unknown>>(
        env.stateTenantId,
        MDMS_SCHEMAS.TENANT,
      );

      const found = tenants.find((t) => t.code === tenantId);

      if (found) {
        return JSON.stringify(
          {
            success: true,
            valid: true,
            tenant: {
              code: found.code,
              name: found.name,
              description: found.description,
              city: found.city,
            },
          },
          null,
          2
        );
      }

      // Not found by unique identifier — try full list
      const allTenants = await digitApi.mdmsV2Search<Record<string, unknown>>(
        env.stateTenantId,
        MDMS_SCHEMAS.TENANT
      );

      const suggestions = allTenants
        .filter((t) => {
          const code = (t.code as string) || '';
          return code.includes(tenantId) || tenantId.includes(code);
        })
        .map((t) => t.code);

      return JSON.stringify(
        {
          success: true,
          valid: false,
          error: `Tenant "${tenantId}" not found`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          availableCount: allTenants.length,
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // mdms_search — generic MDMS search
  registry.register({
    name: 'mdms_search',
    group: 'mdms',
    category: 'mdms',
    risk: 'read',
    description:
      'Search MDMS v2 for records by schema code. Returns the data field of each record. Common schemas: ' +
      Object.entries(MDMS_SCHEMAS)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to search in',
        },
        schema_code: {
          type: 'string',
          description: 'MDMS schema code (e.g. "common-masters.Department")',
        },
        unique_identifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by specific unique identifiers',
        },
        limit: {
          type: 'number',
          description: 'Max records to return (default: 100)',
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default: 0)',
        },
      },
      required: ['tenant_id', 'schema_code'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const records = await digitApi.mdmsV2SearchRaw(
        args.tenant_id as string,
        args.schema_code as string,
        {
          limit: (args.limit as number) || 100,
          offset: (args.offset as number) || 0,
          uniqueIdentifiers: args.unique_identifiers as string[] | undefined,
        }
      );

      return JSON.stringify(
        {
          success: true,
          tenantId: args.tenant_id,
          schemaCode: args.schema_code,
          count: records.length,
          records: records.map((r) => ({
            uniqueIdentifier: r.uniqueIdentifier,
            data: r.data,
            isActive: r.isActive,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // mdms_create — create MDMS record
  registry.register({
    name: 'mdms_create',
    group: 'mdms',
    category: 'mdms',
    risk: 'write',
    description:
      'Create a new MDMS v2 record. Requires tenant ID, schema code, unique identifier, and the data object. Use mdms_search first to verify the record does not already exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to create in',
        },
        schema_code: {
          type: 'string',
          description: 'MDMS schema code',
        },
        unique_identifier: {
          type: 'string',
          description: 'Unique identifier for the record (usually the "code" field)',
        },
        data: {
          type: 'object',
          description: 'The data payload for the record',
        },
      },
      required: ['tenant_id', 'schema_code', 'unique_identifier', 'data'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const result = await digitApi.mdmsV2Create(
        args.tenant_id as string,
        args.schema_code as string,
        args.unique_identifier as string,
        args.data as Record<string, unknown>
      );

      return JSON.stringify(
        {
          success: true,
          message: `Created MDMS record: ${result.uniqueIdentifier}`,
          record: {
            id: result.id,
            tenantId: result.tenantId,
            schemaCode: result.schemaCode,
            uniqueIdentifier: result.uniqueIdentifier,
            data: result.data,
            isActive: result.isActive,
          },
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);
}

// Auto-login helper using environment variables
async function ensureAuthenticated(): Promise<void> {
  if (digitApi.isAuthenticated()) return;

  const username = process.env.CRS_USERNAME;
  const password = process.env.CRS_PASSWORD;
  const tenantId = process.env.CRS_TENANT_ID || digitApi.getEnvironmentInfo().stateTenantId;

  if (!username || !password) {
    throw new Error(
      'Not authenticated. Call the "configure" tool first with your username and password, or set CRS_USERNAME/CRS_PASSWORD env vars.'
    );
  }

  await digitApi.login(username, password, tenantId);
}
