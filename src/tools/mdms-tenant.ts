import type { ToolMetadata } from '../types/index.js';
import { MDMS_SCHEMAS } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';
import { ENVIRONMENTS } from '../config/environments.js';

/**
 * Search for MDMS records across all state tenants.
 * First queries the default state tenant to discover all root-level tenants,
 * then queries each discovered root to get the complete set.
 */
async function searchAllStateTenants(
  defaultStateTenantId: string,
  schemaCode: string,
  filterState?: string
): Promise<Record<string, unknown>[]> {
  // If filtering to a specific state, just search that one
  if (filterState) {
    return digitApi.mdmsV2Search<Record<string, unknown>>(filterState, schemaCode);
  }

  // First search under the default state tenant
  const defaultResults = await digitApi.mdmsV2Search<Record<string, unknown>>(
    defaultStateTenantId,
    schemaCode
  );

  // Discover all state-level tenant roots from:
  // 1. The default state tenant
  // 2. Tenant codes found in the default search results
  // 3. Tenant IDs from the logged-in user's roles (covers cross-tenant admins)
  const knownRoots = new Set<string>();
  knownRoots.add(defaultStateTenantId);
  for (const t of defaultResults) {
    const code = t.code as string;
    if (code) {
      const root = code.includes('.') ? code.split('.')[0] : code;
      knownRoots.add(root);
    }
  }
  // Also check roles — the user may have roles on state tenants not in pg's MDMS
  const auth = digitApi.getAuthInfo();
  if (auth.user?.roles) {
    for (const role of auth.user.roles) {
      if (role.tenantId) {
        const root = role.tenantId.includes('.') ? role.tenantId.split('.')[0] : role.tenantId;
        knownRoots.add(root);
      }
    }
  }

  // Query each discovered root that differs from the default
  const allResults = [...defaultResults];
  const seenCodes = new Set(defaultResults.map((t) => t.code as string));

  for (const root of knownRoots) {
    if (root === defaultStateTenantId) continue;
    try {
      const results = await digitApi.mdmsV2Search<Record<string, unknown>>(root, schemaCode);
      for (const t of results) {
        if (!seenCodes.has(t.code as string)) {
          allResults.push(t);
          seenCodes.add(t.code as string);
        }
      }
    } catch {
      // Skip unreachable state tenants
    }
  }

  return allResults;
}

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
          description: 'Set the operational state tenant (e.g. "statea", "pg"). ' +
            'This controls which tenant context is used for MDMS queries, role assignments, and API operations. ' +
            'Login always uses the user\'s home tenant to preserve the full role set.',
        },
        state_tenant: {
          type: 'string',
          description: 'Explicitly set the root state tenant for all subsequent operations. ' +
            'This overrides the environment default (e.g. switch from "pg" to "statea"). ' +
            'All MDMS queries, role assignments, and tenant lookups will use this as the root.',
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

      // Login always uses the user's home tenant (CRS_TENANT_ID or env default)
      // to ensure the correct user record and full role set is returned.
      // tenant_id and state_tenant only affect the operational context.
      const loginTenantId = process.env.CRS_TENANT_ID || env.stateTenantId;

      // Determine the desired operational state tenant:
      // explicit state_tenant > tenant_id > current default
      const desiredStateTenant = (args.state_tenant as string)
        || (args.tenant_id as string)
        || null;

      if (!username || !password) {
        // Apply state tenant even without login
        if (desiredStateTenant) {
          digitApi.setStateTenant(desiredStateTenant);
        }
        const currentEnv = digitApi.getEnvironmentInfo();
        return JSON.stringify(
          {
            success: false,
            error: 'Username and password are required. Provide them as arguments or set CRS_USERNAME/CRS_PASSWORD env vars.',
            environment: currentEnv,
            stateTenantId: currentEnv.stateTenantId,
          },
          null,
          2
        );
      }

      try {
        await digitApi.login(username, password, loginTenantId);

        // Set the operational state tenant (overrides auto-detection from login)
        if (desiredStateTenant) {
          digitApi.setStateTenant(desiredStateTenant);
        }

        const auth = digitApi.getAuthInfo();
        const envAfterLogin = digitApi.getEnvironmentInfo();

        return JSON.stringify(
          {
            success: true,
            message: `Authenticated as "${username}" on ${envAfterLogin.name}`,
            environment: { name: envAfterLogin.name, url: envAfterLogin.url },
            stateTenantId: envAfterLogin.stateTenantId,
            loginTenantId,
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
            stateTenantId: env.stateTenantId,
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
      'Show the current DIGIT environment configuration (name, URL, state tenant ID). Also lists all available environments. ' +
      'Can switch environment or change the active state tenant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        switch_to: {
          type: 'string',
          description:
            'Optional: switch to a different environment before returning info. Available keys: ' +
            Object.keys(ENVIRONMENTS).join(', '),
        },
        state_tenant: {
          type: 'string',
          description: 'Optional: override the root state tenant (e.g. switch from "pg" to "statea")',
        },
      },
    },
    handler: async (args) => {
      if (args.switch_to) {
        digitApi.setEnvironment(args.switch_to as string);
      }
      if (args.state_tenant) {
        digitApi.setStateTenant(args.state_tenant as string);
      }

      const env = digitApi.getEnvironmentInfo();
      const auth = digitApi.getAuthInfo();
      return JSON.stringify(
        {
          success: true,
          current: {
            name: env.name,
            url: env.url,
            stateTenantId: env.stateTenantId,
          },
          authenticated: auth.authenticated,
          user: auth.user ? { userName: auth.user.userName, tenantId: auth.user.tenantId } : null,
          available: Object.entries(ENVIRONMENTS).map(([key, e]) => ({
            key,
            name: e.name,
            url: e.url,
            defaultStateTenantId: e.stateTenantId,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // mdms_get_tenants — list tenants from MDMS (all state tenants)
  registry.register({
    name: 'mdms_get_tenants',
    group: 'core',
    category: 'mdms',
    risk: 'read',
    description:
      'Fetch all tenant records from MDMS across all state tenants. Returns tenant codes, names, and city info. Requires authentication — will attempt auto-login using CRS_USERNAME/CRS_PASSWORD env vars if not authenticated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state_tenant_id: {
          type: 'string',
          description: 'Filter to a specific state tenant (default: return all)',
        },
      },
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const env = digitApi.getEnvironmentInfo();
      const filterState = args.state_tenant_id as string | undefined;

      // Search across all state tenants to get the full picture
      const allTenants = await searchAllStateTenants(
        env.stateTenantId,
        MDMS_SCHEMAS.TENANT,
        filterState
      );

      return JSON.stringify(
        {
          success: true,
          environment: env.name,
          count: allTenants.length,
          tenants: allTenants.map((t) => ({
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

      // Search across all state tenants to find this tenant
      const allTenants = await searchAllStateTenants(
        env.stateTenantId,
        MDMS_SCHEMAS.TENANT
      );

      const found = allTenants.find((t) => t.code === tenantId);

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

  // mdms_schema_search — search schema definitions
  registry.register({
    name: 'mdms_schema_search',
    group: 'mdms',
    category: 'mdms',
    risk: 'read',
    description:
      'Search MDMS v2 schema definitions for a tenant. Shows what schemas are registered and available for creating data records. ' +
      'If mdms_create fails with "Schema definition not found", use this to check which tenant root has the schema.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID (typically the state-level root, e.g. "pg", "statea", "tenant")',
        },
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: filter by specific schema codes (e.g. ["RAINMAKER-PGR.ServiceDefs"])',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const codes = args.codes as string[] | undefined;
      const schemas = await digitApi.mdmsSchemaSearch(tenantId, codes);

      return JSON.stringify(
        {
          success: true,
          tenantId,
          count: schemas.length,
          schemas: schemas.map((s) => ({
            code: s.code,
            description: s.description,
            tenantId: s.tenantId,
            isActive: s.isActive,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // mdms_schema_create — register a schema definition
  registry.register({
    name: 'mdms_schema_create',
    group: 'mdms',
    category: 'mdms',
    risk: 'write',
    description:
      'Register a new MDMS v2 schema definition for a tenant. Schemas must exist at the state-level root tenant before data records can be created. ' +
      'Use mdms_schema_search on an existing tenant (e.g. "pg") to find the schema definition to copy, then register it on the new tenant root. ' +
      'You can also provide a custom JSON Schema definition.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to register the schema under (state-level root, e.g. "tenant", "statea")',
        },
        code: {
          type: 'string',
          description: 'Schema code (e.g. "RAINMAKER-PGR.ServiceDefs", "common-masters.Department")',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of the schema',
        },
        definition: {
          type: 'object',
          description: 'JSON Schema definition object. Must include "type", "properties", and optionally "required", "x-unique".',
        },
        copy_from_tenant: {
          type: 'string',
          description: 'Optional: copy the schema definition from another tenant (e.g. "pg"). If provided, "definition" is ignored.',
        },
      },
      required: ['tenant_id', 'code'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const code = args.code as string;
      const description = (args.description as string) || code;
      const copyFrom = args.copy_from_tenant as string | undefined;
      let definition = args.definition as Record<string, unknown> | undefined;

      // Copy schema from another tenant if requested
      if (copyFrom) {
        const schemas = await digitApi.mdmsSchemaSearch(copyFrom, [code]);
        if (schemas.length === 0) {
          return JSON.stringify({
            success: false,
            error: `Schema "${code}" not found in tenant "${copyFrom}". Use mdms_schema_search to list available schemas.`,
          }, null, 2);
        }
        definition = schemas[0].definition as Record<string, unknown>;
      }

      if (!definition) {
        return JSON.stringify({
          success: false,
          error: 'Either "definition" or "copy_from_tenant" must be provided.',
        }, null, 2);
      }

      try {
        const result = await digitApi.mdmsSchemaCreate(tenantId, code, description, definition);
        return JSON.stringify({
          success: true,
          message: `Schema "${code}" registered for tenant "${tenantId}"`,
          schema: {
            id: result.id,
            tenantId: result.tenantId,
            code: result.code,
            isActive: result.isActive,
          },
        }, null, 2);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('DUPLICATE') || msg.includes('already exists') || msg.includes('unique')) {
          return JSON.stringify({
            success: true,
            message: `Schema "${code}" already exists for tenant "${tenantId}"`,
            alreadyExists: true,
          }, null, 2);
        }
        throw error;
      }
    },
  } satisfies ToolMetadata);

  // tenant_bootstrap — copy ALL schemas + essential data from an existing tenant root to a new one
  registry.register({
    name: 'tenant_bootstrap',
    group: 'mdms',
    category: 'mdms',
    risk: 'write',
    description:
      'Bootstrap a new state-level tenant root by copying ALL schemas and essential MDMS data from an existing tenant (e.g. "pg"). ' +
      'This is REQUIRED before creating employees, PGR complaints, or any service under a new tenant root. ' +
      'Copies: all schema definitions, IdFormat records, Department records, Designation records, and StateInfo. ' +
      'Call this ONCE when you create a new tenant root (e.g. "tenant", "ke") before doing anything else under it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_tenant: {
          type: 'string',
          description: 'The new tenant root to bootstrap (e.g. "tenant", "ke")',
        },
        source_tenant: {
          type: 'string',
          description: 'Existing tenant root to copy from (default: "pg")',
        },
      },
      required: ['target_tenant'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const target = args.target_tenant as string;
      const source = (args.source_tenant as string) || 'pg';

      const results: {
        schemas: { copied: string[]; skipped: string[]; failed: string[] };
        data: { copied: string[]; skipped: string[]; failed: string[] };
      } = {
        schemas: { copied: [], skipped: [], failed: [] },
        data: { copied: [], skipped: [], failed: [] },
      };

      // Step 1: Copy ALL schemas from source to target
      const sourceSchemas = await digitApi.mdmsSchemaSearch(source);
      for (const schema of sourceSchemas) {
        const code = schema.code as string;
        const definition = schema.definition as Record<string, unknown>;
        const description = (schema.description as string) || code;
        try {
          await digitApi.mdmsSchemaCreate(target, code, description, definition);
          results.schemas.copied.push(code);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('DUPLICATE') || msg.includes('already exists') || msg.includes('unique')) {
            results.schemas.skipped.push(code);
          } else {
            results.schemas.failed.push(`${code}: ${msg}`);
          }
        }
      }

      // Step 2: Copy essential MDMS data records
      const essentialSchemas = [
        'common-masters.IdFormat',
        'common-masters.Department',
        'common-masters.Designation',
        'common-masters.StateInfo',
        'common-masters.GenderType',
        'egov-hrms.EmployeeStatus',
        'egov-hrms.EmployeeType',
        'egov-hrms.DeactivationReason',
        'RAINMAKER-PGR.ServiceDefs',
        'Workflow.BusinessService',
      ];

      for (const schemaCode of essentialSchemas) {
        try {
          const records = await digitApi.mdmsV2SearchRaw(source, schemaCode, { limit: 500 });
          for (const record of records) {
            try {
              await digitApi.mdmsV2Create(
                target,
                schemaCode,
                record.uniqueIdentifier,
                record.data
              );
              results.data.copied.push(`${schemaCode}/${record.uniqueIdentifier}`);
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              if (msg.includes('DUPLICATE') || msg.includes('already exists') || msg.includes('unique') || msg.includes('NON_UNIQUE')) {
                results.data.skipped.push(`${schemaCode}/${record.uniqueIdentifier}`);
              } else {
                results.data.failed.push(`${schemaCode}/${record.uniqueIdentifier}: ${msg}`);
              }
            }
          }
        } catch {
          // Schema might not have data in source — that's OK
        }
      }

      return JSON.stringify({
        success: results.schemas.failed.length === 0 && results.data.failed.length === 0,
        source,
        target,
        summary: {
          schemas_copied: results.schemas.copied.length,
          schemas_skipped: results.schemas.skipped.length,
          schemas_failed: results.schemas.failed.length,
          data_copied: results.data.copied.length,
          data_skipped: results.data.skipped.length,
          data_failed: results.data.failed.length,
        },
        results,
      }, null, 2);
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

      const tenantId = args.tenant_id as string;
      const schemaCode = args.schema_code as string;

      try {
        const result = await digitApi.mdmsV2Create(
          tenantId,
          schemaCode,
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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const stateRoot = tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;

        let hint: string;
        if (msg.includes('Schema definition') && msg.includes('not found')) {
          hint = `Schema "${schemaCode}" is not registered for the "${stateRoot}" tenant root. ` +
            `FIX: Call tenant_bootstrap with target_tenant="${stateRoot}" to copy all schemas and data from pg. ` +
            `Or call mdms_schema_create with tenant_id="${stateRoot}", code="${schemaCode}", copy_from_tenant="pg".`;
        } else if (msg.includes('NON_UNIQUE') || msg.includes('DUPLICATE') || msg.includes('already exists')) {
          hint = `Record already exists. Use mdms_search to find it.`;
        } else {
          hint = `MDMS create failed. Verify the tenant "${stateRoot}" has all required schemas registered. ` +
            `Call tenant_bootstrap with target_tenant="${stateRoot}" if this is a new tenant root.`;
        }

        return JSON.stringify({ success: false, error: msg, hint }, null, 2);
      }
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
