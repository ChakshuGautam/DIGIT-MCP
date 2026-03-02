import type { ToolMetadata } from '../types/index.js';
import { MDMS_SCHEMAS } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';
import { ENVIRONMENTS } from '../config/environments.js';
import { buildOrderedLevels } from './validators.js';

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
    } catch (err) {
      // Skip unreachable state tenants — log for debugging
      console.error(`[mdms_get_tenants] Failed to fetch tenants for state "${root}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return allResults;
}

/**
 * Copy workflow business service definitions from one tenant root to another.
 * Reusable by both tenant_bootstrap and city_setup.
 */
async function copyWorkflowDefinitions(
  sourceRoot: string,
  targetRoot: string,
): Promise<{ created: string[]; skipped: string[]; failed: string[] }> {
  const results = { created: [] as string[], skipped: [] as string[], failed: [] as string[] };

  const knownServices = ['PGR', 'PT.CREATE', 'PT.UPDATE', 'NewTL', 'NewWS1', 'NewSW1', 'FSM', 'BPAREG', 'BPA'];
  const sourceServices = await digitApi.workflowBusinessServiceSearch(sourceRoot, knownServices);
  if (sourceServices.length === 0) {
    results.failed.push(`No workflow services found in source "${sourceRoot}"`);
    return results;
  }

  const buildStateMap = (states: Record<string, unknown>[]): Map<string, string> => {
    const map = new Map<string, string>();
    for (const s of states) {
      if (s.uuid && s.state) map.set(s.uuid as string, s.state as string);
    }
    return map;
  };

  for (const bs of sourceServices) {
    const bsCode = bs.businessService as string;
    try {
      const existing = await digitApi.workflowBusinessServiceSearch(targetRoot, [bsCode]);
      if (existing.length > 0) {
        results.skipped.push(bsCode);
        continue;
      }

      const sourceStates = (bs.states || []) as Record<string, unknown>[];
      const stateMap = buildStateMap(sourceStates);

      const cleanStates = sourceStates.map((s) => ({
        state: s.state,
        applicationStatus: s.applicationStatus,
        docUploadRequired: s.docUploadRequired,
        isStartState: s.isStartState,
        isTerminateState: s.isTerminateState,
        isStateUpdatable: s.isStateUpdatable,
        actions: ((s.actions || []) as Record<string, unknown>[]).map((a) => {
          const nextState = a.nextState as string;
          const resolvedNext = stateMap.get(nextState) || nextState;
          return {
            action: a.action,
            nextState: resolvedNext,
            roles: a.roles,
            active: a.active,
          };
        }),
      }));

      const result = await digitApi.workflowBusinessServiceCreate(targetRoot, {
        businessService: bsCode,
        business: bs.business,
        businessServiceSla: bs.businessServiceSla,
        states: cleanStates,
      });

      if (result.uuid || result.businessService) {
        results.created.push(bsCode);
      } else {
        results.failed.push(`${bsCode}: API returned 200 but no data`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('DUPLICATE') || msg.includes('already exists') || msg.includes('unique')) {
        results.skipped.push(bsCode);
      } else {
        results.failed.push(`${bsCode}: ${msg}`);
      }
    }
  }

  return results;
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
      const explicitTenantId = (args.tenant_id as string) || (args.state_tenant as string);
      const defaultLoginTenant = process.env.CRS_TENANT_ID || env.stateTenantId;

      // Login tenant resolution:
      // If the user provides explicit credentials + tenant_id, use that tenant (or its root) for login.
      // Users created under a non-default root (e.g. "tenant") only exist in that root's user store.
      // Fall back to CRS_TENANT_ID / env default when no explicit tenant is given.
      const explicitRoot = explicitTenantId
        ? (explicitTenantId.includes('.') ? explicitTenantId.split('.')[0] : explicitTenantId)
        : null;
      const loginTenantId = explicitRoot || defaultLoginTenant;

      // Desired operational state tenant
      const desiredStateTenant = explicitRoot || null;

      if (!username || !password) {
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

      // Try login with multiple tenant candidates. DIGIT employees may only be findable
      // at the exact city-level tenant (e.g. "tenant.coimbatore"), the state root ("tenant"),
      // or the environment default ("pg"). Try all unique candidates in order.
      const loginCandidates: string[] = [];
      if (explicitRoot) loginCandidates.push(explicitRoot);
      if (explicitTenantId && explicitTenantId !== explicitRoot) loginCandidates.push(explicitTenantId);
      if (defaultLoginTenant && !loginCandidates.includes(defaultLoginTenant)) loginCandidates.push(defaultLoginTenant);
      if (loginCandidates.length === 0) loginCandidates.push(defaultLoginTenant);

      let loginError: string | null = null;
      let usedLoginTenant = loginCandidates[0];

      for (const candidate of loginCandidates) {
        try {
          await digitApi.login(username, password, candidate);
          usedLoginTenant = candidate;
          loginError = null;
          break;
        } catch (error) {
          loginError = error instanceof Error ? error.message : String(error);
        }
      }

      if (loginError) {
        const triedTenants = loginCandidates.map((t) => `"${t}"`).join(', ');
        return JSON.stringify(
          {
            success: false,
            error: 'Invalid login credentials',
            environment: { name: env.name, url: env.url },
            triedLoginTenants: triedTenants,
            hint: `Login failed against tenants: ${triedTenants}. ` +
              `IMPORTANT: HRMS employee usernames are the EMPLOYEE CODE (e.g. "EMP-LIVE-000057"), NOT the mobile number. ` +
              `Check the employee_create response for the "code" field and use that as the username. ` +
              `Default password is "eGov@123".`,
          },
          null,
          2
        );
      }

      // Set the operational state tenant
      if (desiredStateTenant) {
        digitApi.setStateTenant(desiredStateTenant);
      }

      // ── Cross-tenant role provisioning ──
      // If we fell back to a different tenant (e.g. logged in on "pg" but target is "tenant"),
      // the user lacks roles for the target root. Auto-add them so that direct API login
      // (e.g. from a frontend) also works for the target tenant.
      let rolesProvisioned: string[] | null = null;
      if (explicitRoot && usedLoginTenant !== explicitRoot && usedLoginTenant !== explicitTenantId) {
        try {
          const auth = digitApi.getAuthInfo();
          const searchTenant = auth.user?.tenantId || usedLoginTenant;
          const users = await digitApi.userSearch(searchTenant, { userName: username, limit: 1 });

          if (users.length > 0) {
            const user = users[0];
            const existingRoles = (user.roles || []) as Array<{ code: string; name: string; tenantId: string }>;
            const existingForTarget = new Set(
              existingRoles.filter((r) => r.tenantId === explicitRoot).map((r) => r.code),
            );

            const standardRoles = ['CITIZEN', 'EMPLOYEE', 'CSR', 'GRO', 'PGR_LME', 'DGRO', 'SUPERUSER'];
            const newRoles = standardRoles
              .filter((code) => !existingForTarget.has(code))
              .map((code) => ({ code, name: code, tenantId: explicitRoot }));

            if (newRoles.length > 0) {
              await digitApi.userUpdate({
                ...user,
                roles: [...existingRoles, ...newRoles],
              });
              rolesProvisioned = newRoles.map((r) => r.code);

              // Re-login with the target tenant now that roles exist
              try {
                await digitApi.login(username, password, explicitRoot);
                usedLoginTenant = explicitRoot;
              } catch (reloginErr) {
                console.error(`[configure] Re-login to "${explicitRoot}" failed after role provisioning: ${reloginErr instanceof Error ? reloginErr.message : String(reloginErr)}`);
              }
            }
          }
        } catch (provErr) {
          console.error(`[configure] Role provisioning failed: ${provErr instanceof Error ? provErr.message : String(provErr)}`);
        }
      }

      const auth = digitApi.getAuthInfo();
      const envAfterLogin = digitApi.getEnvironmentInfo();

      return JSON.stringify(
        {
          success: true,
          message: `Authenticated as "${username}" on ${envAfterLogin.name}`,
          environment: { name: envAfterLogin.name, url: envAfterLogin.url },
          stateTenantId: envAfterLogin.stateTenantId,
          loginTenantId: usedLoginTenant,
          ...(rolesProvisioned && {
            rolesProvisioned: {
              tenant: explicitRoot,
              roles: rolesProvisioned,
              note: `Added roles for "${explicitRoot}" so direct API login with this tenant now works.`,
            },
          }),
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
      'Copies: all schema definitions, IdFormat records, Department records, Designation records, StateInfo, and InboxQueryConfiguration. ' +
      'Also provisions an ADMIN user on the new tenant and copies workflow definitions (PGR, etc.) from source. ' +
      'After bootstrap, use city_setup to create city-level tenants. ' +
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

      // Step 2: Create the root tenant record under itself
      // CRITICAL: tenant.tenants records MUST exist under the tenant's own root,
      // because services like idgen resolve city codes via v1 MDMS using the tenant prefix as root.
      try {
        await digitApi.mdmsV2Create(target, 'tenant.tenants', target, {
          code: target,
          name: target,
          description: `State tenant root: ${target}`,
          city: {
            code: target.toUpperCase(),
            name: target,
            districtCode: target.toUpperCase(),
            districtName: target,
          },
        });
        results.data.copied.push(`tenant.tenants/${target} (root self-record)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('DUPLICATE') || msg.includes('already exists') || msg.includes('unique') || msg.includes('NON_UNIQUE')) {
          results.data.skipped.push(`tenant.tenants/${target} (root self-record)`);
        } else {
          results.data.failed.push(`tenant.tenants/${target}: ${msg}`);
        }
      }

      // Step 3: Copy essential MDMS data records
      // IMPORTANT: ACCESSCONTROL-ROLES.roles MUST be copied before user provisioning (Step 4),
      // because DIGIT's user service validates role codes against MDMS.
      const essentialSchemas = [
        'ACCESSCONTROL-ROLES.roles',
        // NOTE: ACCESSCONTROL-ROLEACTIONS.roleactions deliberately excluded — it has x-ref-schema
        // dependencies on ACCESSCONTROL-ACTIONS.actions (hundreds of records). Role *codes* are
        // enough for user provisioning; role-action mappings are shared via access-control service.
        'common-masters.IdFormat',
        'common-masters.Department',
        // DataSecurity schemas — required by services that embed egov-enc-service (inbox, PGR, user).
        // Without these, the encryption policy @PostConstruct init fails and the service won't start.
        'DataSecurity.DecryptionABAC',
        'DataSecurity.EncryptionPolicy',
        'DataSecurity.SecurityPolicy',
        'DataSecurity.MaskingPatterns',
        'common-masters.Designation',
        'common-masters.StateInfo',
        'common-masters.GenderType',
        'egov-hrms.EmployeeStatus',
        'egov-hrms.EmployeeType',
        'egov-hrms.DeactivationReason',
        'RAINMAKER-PGR.ServiceDefs',
        'Workflow.BusinessService',
        'INBOX.InboxQueryConfiguration',
      ];

      for (const schemaCode of essentialSchemas) {
        try {
          // Fetch source records and existing target records for this schema
          const sourceRecords = await digitApi.mdmsV2SearchRaw(source, schemaCode, { limit: 500 });
          const targetRecords = await digitApi.mdmsV2SearchRaw(target, schemaCode, { limit: 500 });
          const targetByUid = new Map(targetRecords.map((r) => [r.uniqueIdentifier, r]));

          for (const record of sourceRecords) {
            const existing = targetByUid.get(record.uniqueIdentifier);
            try {
              if (existing && existing.isActive) {
                // Already active — skip
                results.data.skipped.push(`${schemaCode}/${record.uniqueIdentifier}`);
              } else if (existing && !existing.isActive) {
                // Inactive (from cleanup) — re-activate via update
                await digitApi.mdmsV2Update(existing, true);
                results.data.copied.push(`${schemaCode}/${record.uniqueIdentifier} (reactivated)`);
              } else {
                // Doesn't exist — create
                await digitApi.mdmsV2Create(target, schemaCode, record.uniqueIdentifier, record.data);
                results.data.copied.push(`${schemaCode}/${record.uniqueIdentifier}`);
              }
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              results.data.failed.push(`${schemaCode}/${record.uniqueIdentifier}: ${msg}`);
            }
          }
        } catch (schemaErr) {
          // Schema might not have data in source — that's OK
          console.error(`[tenant_bootstrap] Schema "${schemaCode}" data copy skipped: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`);
        }
      }

      // Step 4: Provision ADMIN user on target tenant
      // DIGIT auth scopes user lookup by tenantId — a user created under "pg" can't be found
      // when a frontend tries tenantId=<target>. We create a matching ADMIN user on the target
      // so that direct API login works.
      let userProvisioned: { username: string; tenantId: string; roles: string[] } | null = null;
      let userProvisionError: string | null = null;
      try {
        const auth = digitApi.getAuthInfo();
        const currentUsername = auth.user?.userName || process.env.CRS_USERNAME || 'ADMIN';
        const currentPassword = process.env.CRS_PASSWORD || 'eGov@123';

        // Get full user details from source tenant
        const sourceTenantForSearch = auth.user?.tenantId || source;
        const existingUsers = await digitApi.userSearch(sourceTenantForSearch, {
          userName: currentUsername,
          limit: 1,
        });

        const sourceUser = existingUsers[0];
        const userName = (sourceUser?.userName as string) || currentUsername;
        const name = (sourceUser?.name as string) || 'Admin';
        const mobileNumber = (sourceUser?.mobileNumber as string) || '9999999999';

        // Standard roles needed for full platform operations on the new tenant
        const standardRoles = [
          { code: 'EMPLOYEE', name: 'Employee' },
          { code: 'CITIZEN', name: 'Citizen' },
          { code: 'CSR', name: 'CSR' },
          { code: 'GRO', name: 'Grievance Routing Officer' },
          { code: 'PGR_LME', name: 'PGR Last Mile Employee' },
          { code: 'DGRO', name: 'Department GRO' },
          { code: 'SUPERUSER', name: 'Super User' },
          // INTERNAL_MICROSERVICE_ROLE — required by services that do inter-service user lookups
          // (e.g. inbox's ElasticSearchService.initializeSystemuser() searches for a user with this
          // role on the state tenant). Without it, inbox crashes: "Service returned null while fetching user".
          { code: 'INTERNAL_MICROSERVICE_ROLE', name: 'Internal Microservice Role' },
        ].map((r) => ({ ...r, tenantId: target }));

        // Check if user already exists on the target tenant
        let alreadyExists = false;
        try {
          const targetUsers = await digitApi.userSearch(target, { userName: userName, limit: 1 });
          if (targetUsers.length > 0) {
            alreadyExists = true;
            // User exists — ensure they have all standard roles for this target
            const existingRoles = (targetUsers[0].roles || []) as Array<{ code: string; tenantId: string }>;
            const existingCodes = new Set(
              existingRoles.filter((r) => r.tenantId === target).map((r) => r.code),
            );
            const missingRoles = standardRoles.filter((r) => !existingCodes.has(r.code));
            if (missingRoles.length > 0) {
              await digitApi.userUpdate({
                ...targetUsers[0],
                roles: [...existingRoles, ...missingRoles],
              });
              userProvisioned = {
                username: userName,
                tenantId: target,
                roles: missingRoles.map((r) => r.code),
              };
            } else {
              userProvisioned = {
                username: userName,
                tenantId: target,
                roles: [],
              };
            }
          }
        } catch (userSearchErr) {
          console.error(`[tenant_bootstrap] User search on "${target}" failed, proceeding to create: ${userSearchErr instanceof Error ? userSearchErr.message : String(userSearchErr)}`);
        }

        if (!alreadyExists) {
          // Create user on the target tenant
          const newUser = {
            name,
            mobileNumber,
            userName,
            password: currentPassword,
            type: 'EMPLOYEE',
            active: true,
            emailId: (sourceUser?.emailId as string) || null,
            gender: (sourceUser?.gender as string) || null,
            roles: standardRoles,
            tenantId: target,
          };

          await digitApi.userCreate(newUser, target);
          userProvisioned = {
            username: userName,
            tenantId: target,
            roles: standardRoles.map((r) => r.code),
          };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        userProvisionError = msg;
      }

      // Step 5: Copy workflow definitions
      let workflowResults = { created: [] as string[], skipped: [] as string[], failed: [] as string[] };
      try {
        workflowResults = await copyWorkflowDefinitions(source, target);
      } catch (err) {
        workflowResults.failed.push(`workflow copy error: ${err instanceof Error ? err.message : String(err)}`);
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
          workflows_created: workflowResults.created.length,
          workflows_skipped: workflowResults.skipped.length,
          workflows_failed: workflowResults.failed.length,
        },
        ...(userProvisioned && {
          adminUser: {
            provisioned: true,
            ...userProvisioned,
            note: userProvisioned.roles.length > 0
              ? `ADMIN user "${userProvisioned.username}" provisioned on "${target}" with roles: ${userProvisioned.roles.join(', ')}. Direct login with tenantId="${target}" now works.`
              : `ADMIN user "${userProvisioned.username}" already exists on "${target}" with all required roles.`,
          },
        }),
        ...(userProvisionError && {
          adminUser: {
            provisioned: false,
            error: userProvisionError,
            hint: 'User provisioning failed. You can manually create an ADMIN user with user_create tool.',
          },
        }),
        results: {
          ...results,
          workflow: workflowResults,
        },
        nextSteps: [
          `Create a city tenant: use city_setup with tenant_id="${target}.yourcity" and a city name`,
          'NOTE: DIGIT Java services (PGR, HRMS, inbox) use STATE_LEVEL_TENANT_ID from their config. ' +
          'A new root tenant requires restarting these services. For testing, create cities under "pg" instead.',
        ],
      }, null, 2);
    },
  } satisfies ToolMetadata);

  // city_setup — set up a city-level tenant with everything needed for PGR
  registry.register({
    name: 'city_setup',
    group: 'mdms',
    category: 'mdms',
    risk: 'write',
    description:
      'Set up a city-level tenant under an existing root with everything needed for PGR. ' +
      'Creates tenant record, provisions dual-scoped ADMIN user, copies workflow definitions, and creates boundary hierarchy. ' +
      'Call tenant_bootstrap first to set up the root.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'City tenant ID e.g. "pg.newcity"',
        },
        city_name: {
          type: 'string',
          description: 'Human-readable city name',
        },
        source_tenant: {
          type: 'string',
          description: 'Source for workflow copy (default: root tenant, falls back to "pg")',
        },
        create_boundaries: {
          type: 'boolean',
          description: 'Create default boundary hierarchy (default: true)',
        },
        locality_codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom locality codes. Default: auto-generated LOC_<CITYCODE>_1',
        },
      },
      required: ['tenant_id', 'city_name'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const cityName = args.city_name as string;
      const sourceArg = args.source_tenant as string | undefined;
      const createBoundaries = (args.create_boundaries as boolean) ?? true;
      const localityCodes = args.locality_codes as string[] | undefined;

      // Validate city-level tenant ID
      if (!tenantId.includes('.')) {
        return JSON.stringify({
          success: false,
          error: `tenant_id "${tenantId}" must be a city-level ID containing a dot (e.g. "pg.newcity"). ` +
            'Use tenant_bootstrap for state-level root tenants.',
        }, null, 2);
      }

      const root = tenantId.split('.')[0];
      const cityCode = tenantId.split('.').slice(1).join('.').toUpperCase().replace(/\./g, '_');

      const steps: Record<string, unknown> = {};

      // Step 1: Validate root tenant exists
      try {
        const rootTenants = await digitApi.mdmsV2SearchRaw(root, 'tenant.tenants', {
          uniqueIdentifiers: [root],
          limit: 1,
        });
        if (rootTenants.length === 0) {
          // Also check if root exists in pg's MDMS (multi-root setup)
          const pgTenants = await digitApi.mdmsV2SearchRaw('pg', 'tenant.tenants', {
            uniqueIdentifiers: [root],
            limit: 1,
          });
          if (pgTenants.length === 0 && root !== 'pg') {
            return JSON.stringify({
              success: false,
              error: `Root tenant "${root}" not found. Run tenant_bootstrap with target_tenant="${root}" first.`,
            }, null, 2);
          }
        }
      } catch (err) {
        // If root MDMS search fails, root likely doesn't exist
        if (root !== 'pg') {
          return JSON.stringify({
            success: false,
            error: `Root tenant "${root}" not accessible: ${err instanceof Error ? err.message : String(err)}. ` +
              `Run tenant_bootstrap with target_tenant="${root}" first.`,
          }, null, 2);
        }
      }

      // Step 2: Create city tenant MDMS record
      try {
        const existing = await digitApi.mdmsV2SearchRaw(root, 'tenant.tenants', {
          uniqueIdentifiers: [`Tenant.${tenantId}`],
          limit: 1,
        });
        if (existing.length > 0 && existing[0].isActive) {
          steps.tenantRecord = 'already_exists';
        } else if (existing.length > 0 && !existing[0].isActive) {
          await digitApi.mdmsV2Update(existing[0], true);
          steps.tenantRecord = 'reactivated';
        } else {
          await digitApi.mdmsV2Create(root, 'tenant.tenants', `Tenant.${tenantId}`, {
            code: tenantId,
            name: cityName,
            tenantId,
            parent: root,
            city: {
              code: cityCode,
              name: cityName,
              districtName: root,
            },
          });
          steps.tenantRecord = 'created';
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('DUPLICATE') || msg.includes('already exists') || msg.includes('unique') || msg.includes('NON_UNIQUE')) {
          steps.tenantRecord = 'already_exists';
        } else {
          return JSON.stringify({
            success: false,
            error: `Failed to create city tenant record: ${msg}`,
            hint: `Ensure root "${root}" has tenant.tenants schema with x-unique. Run tenant_bootstrap if needed.`,
          }, null, 2);
        }
      }

      // Step 3: Provision dual-scoped ADMIN user
      const adminUserResult: { provisioned: boolean; dualScoped: boolean; rolesAdded: number; error?: string } = {
        provisioned: false,
        dualScoped: false,
        rolesAdded: 0,
      };
      try {
        const auth = digitApi.getAuthInfo();
        const currentUsername = auth.user?.userName || process.env.CRS_USERNAME || 'ADMIN';
        const currentPassword = process.env.CRS_PASSWORD || 'eGov@123';

        const standardRoles = ['EMPLOYEE', 'CITIZEN', 'CSR', 'GRO', 'PGR_LME', 'DGRO', 'SUPERUSER', 'INTERNAL_MICROSERVICE_ROLE'];

        // Build dual-scoped roles (both root and city)
        const dualRoles = standardRoles.flatMap(code => [
          { code, name: code, tenantId: root },
          { code, name: code, tenantId: tenantId },
        ]);

        // Search for ADMIN user on root tenant
        const sourceTenantForSearch = auth.user?.tenantId || root;
        const rootUsers = await digitApi.userSearch(sourceTenantForSearch, {
          userName: currentUsername,
          limit: 1,
        });

        const sourceUser = rootUsers[0];
        const userName = (sourceUser?.userName as string) || currentUsername;
        const name = (sourceUser?.name as string) || 'Admin';
        const mobileNumber = (sourceUser?.mobileNumber as string) || '9999999999';

        // Check if user exists on city tenant
        let userOnCity: Record<string, unknown> | null = null;
        try {
          const cityUsers = await digitApi.userSearch(tenantId, { userName: userName, limit: 1 });
          if (cityUsers.length > 0) userOnCity = cityUsers[0];
        } catch (_) {
          // City user search may fail if city tenant is brand new
        }

        if (userOnCity) {
          // User exists — ensure dual-scoped roles
          const existingRoles = (userOnCity.roles || []) as Array<{ code: string; tenantId: string }>;
          const existingSet = new Set(existingRoles.map(r => `${r.code}@${r.tenantId}`));
          const missingRoles = dualRoles.filter(r => !existingSet.has(`${r.code}@${r.tenantId}`));
          if (missingRoles.length > 0) {
            await digitApi.userUpdate({
              ...userOnCity,
              roles: [...existingRoles, ...missingRoles],
            });
            adminUserResult.rolesAdded = missingRoles.length;
          }
          adminUserResult.provisioned = true;
          adminUserResult.dualScoped = true;
        } else {
          // Create user on city tenant with dual-scoped roles
          await digitApi.userCreate({
            name,
            mobileNumber,
            userName,
            password: currentPassword,
            type: 'EMPLOYEE',
            active: true,
            emailId: (sourceUser?.emailId as string) || null,
            gender: (sourceUser?.gender as string) || null,
            roles: dualRoles,
            tenantId,
          }, tenantId);
          adminUserResult.provisioned = true;
          adminUserResult.dualScoped = true;
          adminUserResult.rolesAdded = dualRoles.length;
        }

        // Also ensure the root-level user has city-scoped roles
        if (sourceUser) {
          const rootExistingRoles = (sourceUser.roles || []) as Array<{ code: string; tenantId: string }>;
          const rootExistingSet = new Set(rootExistingRoles.map(r => `${r.code}@${r.tenantId}`));
          const cityRoles = standardRoles
            .map(code => ({ code, name: code, tenantId }))
            .filter(r => !rootExistingSet.has(`${r.code}@${r.tenantId}`));
          if (cityRoles.length > 0) {
            await digitApi.userUpdate({
              ...sourceUser,
              roles: [...rootExistingRoles, ...cityRoles],
            });
            adminUserResult.rolesAdded += cityRoles.length;
          }
        }
      } catch (err) {
        adminUserResult.error = err instanceof Error ? err.message : String(err);
      }
      steps.adminUser = adminUserResult;

      // Step 4: Copy workflow definitions (idempotent)
      let workflowResult = { created: [] as string[], skipped: [] as string[], failed: [] as string[] };
      try {
        // Determine source for workflow: explicit arg > root (if it has workflows) > "pg"
        let workflowSource = sourceArg || root;
        if (!sourceArg) {
          try {
            const rootWorkflows = await digitApi.workflowBusinessServiceSearch(root, ['PGR']);
            if (rootWorkflows.length === 0 && root !== 'pg') {
              workflowSource = 'pg';
            }
          } catch (_) {
            if (root !== 'pg') workflowSource = 'pg';
          }
        }
        workflowResult = await copyWorkflowDefinitions(workflowSource, root);
      } catch (err) {
        workflowResult.failed.push(`workflow copy error: ${err instanceof Error ? err.message : String(err)}`);
      }
      steps.workflow = workflowResult;

      // Step 5: Create boundary hierarchy + entities
      if (createBoundaries) {
        const boundaryResult: {
          hierarchyReused: boolean;
          entitiesCreated: number;
          localityCodes: string[];
          error?: string;
        } = {
          hierarchyReused: false,
          entitiesCreated: 0,
          localityCodes: [],
        };

        try {
          // Check if hierarchy exists on root
          let hierarchyLevels: string[] = [];
          try {
            const existing = await digitApi.boundaryHierarchySearch(root, 'ADMIN');
            if (existing.length > 0) {
              const hier = existing[0] as { boundaryHierarchy?: { boundaryType: string; parentBoundaryType?: string }[] };
              if (hier.boundaryHierarchy) {
                hierarchyLevels = buildOrderedLevels(hier.boundaryHierarchy);
                boundaryResult.hierarchyReused = true;
              }
            }
          } catch (_) {
            // No hierarchy on root
          }

          if (hierarchyLevels.length === 0) {
            hierarchyLevels = ['Country', 'State', 'District', 'City', 'Ward', 'Locality'];
          }

          // Create hierarchy on root if needed
          const levels = hierarchyLevels.map((type, i) => ({
            boundaryType: type,
            parentBoundaryType: i === 0 ? null : hierarchyLevels[i - 1],
            active: true,
          }));

          try {
            await digitApi.boundaryHierarchyCreate(root, 'ADMIN', levels);
          } catch (herr) {
            const msg = herr instanceof Error ? herr.message : String(herr);
            if (!msg.includes('DUPLICATE') && !msg.includes('already exists') && !msg.includes('unique')) {
              console.error(`[city_setup] hierarchy create on root "${root}" failed: ${msg}`);
            }
          }

          // Create hierarchy on city tenant too
          try {
            await digitApi.boundaryHierarchyCreate(tenantId, 'ADMIN', levels);
          } catch (herr) {
            const msg = herr instanceof Error ? herr.message : String(herr);
            if (!msg.includes('DUPLICATE') && !msg.includes('already exists') && !msg.includes('unique')) {
              console.error(`[city_setup] hierarchy create on city "${tenantId}" failed: ${msg}`);
            }
          }

          // Build boundary entities
          const locs = (localityCodes && localityCodes.length > 0)
            ? localityCodes
            : [`LOC_${cityCode}_1`];
          boundaryResult.localityCodes = locs;

          const countryCode = `COUNTRY_${cityCode}`;
          const stateCode = `STATE_${cityCode}`;
          const districtCode = `DISTRICT_${cityCode}`;
          const cityBndCode = `CITY_${cityCode}`;

          const boundaries: { code: string; type: string; parent?: string }[] = [
            { code: countryCode, type: 'Country' },
            { code: stateCode, type: 'State', parent: countryCode },
            { code: districtCode, type: 'District', parent: stateCode },
            { code: cityBndCode, type: 'City', parent: districtCode },
          ];

          // Create one Ward + Locality per locality code
          for (let i = 0; i < locs.length; i++) {
            const wardCode = `WARD_${cityCode}_${i + 1}`;
            boundaries.push(
              { code: wardCode, type: 'Ward', parent: cityBndCode },
              { code: locs[i], type: 'Locality', parent: wardCode },
            );
          }

          // Create boundary entities
          for (const b of boundaries) {
            try {
              await digitApi.boundaryCreate(tenantId, [{ code: b.code, tenantId }]);
              boundaryResult.entitiesCreated++;
            } catch (berr) {
              const msg = berr instanceof Error ? berr.message : String(berr);
              if (!msg.includes('DUPLICATE') && !msg.includes('already exists') && !msg.includes('unique')) {
                console.error(`[city_setup] boundary entity create "${b.code}" failed: ${msg}`);
              } else {
                boundaryResult.entitiesCreated++; // count skipped as "exists"
              }
            }
          }

          // Create relationships (top-down order is already correct)
          for (const b of boundaries) {
            try {
              await digitApi.boundaryRelationshipCreate(
                tenantId,
                b.code,
                'ADMIN',
                b.type,
                b.parent || null,
              );
            } catch (rerr) {
              const msg = rerr instanceof Error ? rerr.message : String(rerr);
              if (!msg.includes('DUPLICATE') && !msg.includes('already exists') && !msg.includes('unique')) {
                console.error(`[city_setup] boundary relationship "${b.code}" failed: ${msg}`);
              }
            }
          }
        } catch (err) {
          boundaryResult.error = err instanceof Error ? err.message : String(err);
        }
        steps.boundaries = boundaryResult;
      }

      return JSON.stringify({
        success: true,
        cityTenant: tenantId,
        root,
        steps,
        nextSteps: [
          `Create employees: employee_create with tenant_id="${tenantId}"`,
          `Verify setup: validate_complaint_types, validate_employees with tenant_id="${tenantId}"`,
          `Create complaints: pgr_create with tenant_id="${tenantId}"`,
        ],
      }, null, 2);
    },
  } satisfies ToolMetadata);

  // tenant_cleanup — soft-delete all MDMS data and deactivate users for a tenant
  registry.register({
    name: 'tenant_cleanup',
    group: 'mdms',
    category: 'mdms',
    risk: 'write',
    description:
      'Clean up a tenant by soft-deleting all MDMS data (isActive=false) and deactivating users. ' +
      'Follows the dataloader pattern: MDMS records are deactivated via the v2 _update API, not hard-deleted. ' +
      'Schema definitions are left in place (harmless without data). ' +
      'Use this to tear down test tenants created by tenant_bootstrap.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to clean up (e.g. "testroot"). WARNING: This deactivates ALL MDMS data for this tenant.',
        },
        deactivate_users: {
          type: 'boolean',
          description: 'Also deactivate users on this tenant (default: true)',
        },
        schemas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: only clean up specific schema codes. If omitted, cleans ALL schemas.',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const deactivateUsers = (args.deactivate_users as boolean) ?? true;
      const schemaFilter = args.schemas as string[] | undefined;

      const results = {
        mdms: { deleted: 0, skipped: 0, failed: 0, schemas: {} as Record<string, number> },
        users: { deactivated: 0, failed: 0 },
      };

      // Step 1: Search all MDMS data for the tenant
      // Paginate through all records (MDMS search is capped at limit per call)
      const allRecords: Array<{
        id: string; tenantId: string; schemaCode: string;
        uniqueIdentifier: string; data: Record<string, unknown>;
        isActive: boolean; auditDetails?: Record<string, unknown>;
      }> = [];
      let offset = 0;
      const pageSize = 500;

      while (true) {
        const schemaCode = schemaFilter && schemaFilter.length === 1 ? schemaFilter[0] : '';
        const data = await digitApi.mdmsV2SearchRaw(tenantId, schemaCode, { limit: pageSize, offset });

        if (data.length === 0) break;
        allRecords.push(...data.map((r) => ({
          id: r.id,
          tenantId: r.tenantId,
          schemaCode: r.schemaCode,
          uniqueIdentifier: r.uniqueIdentifier,
          data: r.data,
          isActive: r.isActive,
          auditDetails: r.auditDetails as Record<string, unknown> | undefined,
        })));
        if (data.length < pageSize) break;
        offset += pageSize;
      }

      // Filter by schemas if multiple were specified
      const filteredRecords = schemaFilter && schemaFilter.length > 1
        ? allRecords.filter((r) => schemaFilter.includes(r.schemaCode))
        : allRecords;

      // Step 2: Soft-delete each active record
      for (const record of filteredRecords) {
        if (!record.isActive) {
          results.mdms.skipped++;
          continue;
        }

        try {
          await digitApi.mdmsV2Update(
            record as Parameters<typeof digitApi.mdmsV2Update>[0],
            false
          );
          results.mdms.deleted++;
          results.mdms.schemas[record.schemaCode] = (results.mdms.schemas[record.schemaCode] || 0) + 1;
        } catch (delErr) {
          console.error(`[tenant_cleanup] Failed to deactivate ${record.schemaCode}/${record.uniqueIdentifier}: ${delErr instanceof Error ? delErr.message : String(delErr)}`);
          results.mdms.failed++;
        }
      }

      // Step 3: Deactivate users on this tenant
      if (deactivateUsers) {
        try {
          const users = await digitApi.userSearch(tenantId, { limit: 100 });
          for (const user of users) {
            if (!(user.active as boolean)) continue;
            try {
              await digitApi.userUpdate({ ...user, active: false });
              results.users.deactivated++;
            } catch (userErr) {
              console.error(`[tenant_cleanup] Failed to deactivate user ${user.userName}: ${userErr instanceof Error ? userErr.message : String(userErr)}`);
              results.users.failed++;
            }
          }
        } catch (userSearchErr) {
          console.error(`[tenant_cleanup] User search failed for "${tenantId}": ${userSearchErr instanceof Error ? userSearchErr.message : String(userSearchErr)}`);
        }
      }

      return JSON.stringify({
        success: results.mdms.failed === 0 && results.users.failed === 0,
        tenantId,
        summary: {
          mdms_records_found: filteredRecords.length,
          mdms_deleted: results.mdms.deleted,
          mdms_already_inactive: results.mdms.skipped,
          mdms_failed: results.mdms.failed,
          users_deactivated: results.users.deactivated,
          users_failed: results.users.failed,
        },
        schemas_affected: results.mdms.schemas,
        note: 'MDMS records soft-deleted (isActive=false). Schema definitions are left in place. Users deactivated.',
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
      const uniqueIdentifier = args.unique_identifier as string;

      try {
        // Check if a record with this identifier already exists (may be inactive)
        const existing = await digitApi.mdmsV2SearchRaw(tenantId, schemaCode, {
          uniqueIdentifiers: [uniqueIdentifier],
          limit: 1,
        });

        if (existing.length > 0 && existing[0].isActive) {
          return JSON.stringify({
            success: true,
            message: `Record already exists and is active: ${uniqueIdentifier}`,
            alreadyExisted: true,
            record: {
              id: existing[0].id,
              tenantId: existing[0].tenantId,
              schemaCode: existing[0].schemaCode,
              uniqueIdentifier: existing[0].uniqueIdentifier,
              data: existing[0].data,
              isActive: existing[0].isActive,
            },
          }, null, 2);
        }

        if (existing.length > 0 && !existing[0].isActive) {
          // Re-activate the inactive record instead of creating (MDMS _create returns phantom 200 for inactive dupes)
          const reactivated = await digitApi.mdmsV2Update(existing[0], true);
          return JSON.stringify({
            success: true,
            message: `Reactivated inactive record: ${uniqueIdentifier}`,
            reactivated: true,
            record: {
              id: reactivated.id,
              tenantId: reactivated.tenantId,
              schemaCode: reactivated.schemaCode,
              uniqueIdentifier: reactivated.uniqueIdentifier,
              data: reactivated.data,
              isActive: reactivated.isActive,
            },
          }, null, 2);
        }

        // No existing record — create new
        const result = await digitApi.mdmsV2Create(
          tenantId,
          schemaCode,
          uniqueIdentifier,
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
