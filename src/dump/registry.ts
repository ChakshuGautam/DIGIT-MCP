import type { RegistryRow } from './types.js';

export const REGISTRY_SCHEMA_CODE = 'mcp-dumps.DumpRegistry';

const REGISTRY_DEFINITION = {
  type: 'object',
  title: 'MCP Dump Registry',
  required: ['tenant_id', 'version', 'filestore_id', 'created_at', 'size_bytes', 'sha256', 'surfaces', 'include'],
  properties: {
    tenant_id: { type: 'string' },
    version: { type: 'string', pattern: '^v[0-9]+$' },
    filestore_id: { type: 'string' },
    created_at: { type: 'string' },
    size_bytes: { type: 'number' },
    sha256: { type: 'string', minLength: 64, maxLength: 64 },
    surfaces: { type: 'array', items: { type: 'string' } },
    include: { type: 'array', items: { type: 'string' } },
  },
};

interface Client {
  mdmsSchemaSearch(tenantId: string, codes?: string[]): Promise<Record<string, unknown>[]>;
  mdmsSchemaCreate(tenantId: string, code: string, description: string, definition: unknown): Promise<Record<string, unknown>>;
  mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown): Promise<unknown>;
  mdmsV2SearchRaw(tenantId: string, schemaCode: string): Promise<Record<string, unknown>[]>;
}

export async function ensureRegistrySchema(client: Client, rootTenantId: string): Promise<void> {
  const existing = await client.mdmsSchemaSearch(rootTenantId, [REGISTRY_SCHEMA_CODE]);
  if (existing.length > 0) return;
  await client.mdmsSchemaCreate(rootTenantId, REGISTRY_SCHEMA_CODE, 'MCP dump version index', REGISTRY_DEFINITION);
}

function rootOf(tenantId: string): string {
  return tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;
}

export async function listRegistryRows(client: Client, tenantId?: string): Promise<RegistryRow[]> {
  const rootForSearch = tenantId ? rootOf(tenantId) : '';
  const rows = await client.mdmsV2SearchRaw(rootForSearch || 'pg', REGISTRY_SCHEMA_CODE);
  const all = rows.map((r) => (r.data || r) as RegistryRow);
  if (!tenantId) return all;
  return all.filter((r) => r.tenant_id === tenantId);
}

/**
 * Compute the next monotonic version (`v1`, `v2`, …) for a tenant.
 *
 * NOT safe for concurrent calls — two simultaneous invocations against the
 * same tenant can compute the same next version, leading to a duplicate
 * `uniqueIdentifier` collision on write. Guarded by the single-operator
 * usage assumption (one human/agent runs `mdms_dump` at a time per tenant).
 * If concurrent dumps become a real workflow, replace with a server-side
 * sequence (e.g. an idgen-allocated counter) or an advisory DB lock.
 */
export async function nextVersion(client: Client, tenantId: string): Promise<string> {
  const existing = await listRegistryRows(client, tenantId);
  if (existing.length === 0) return 'v1';
  const numbers = existing
    .map((r) => r.version)
    .filter((v) => /^v[0-9]+$/.test(v))
    .map((v) => parseInt(v.slice(1), 10));
  const max = numbers.length === 0 ? 0 : Math.max(...numbers);
  return `v${max + 1}`;
}

export async function writeRegistryRow(client: Client, row: RegistryRow): Promise<void> {
  const root = rootOf(row.tenant_id);
  const uid = `${row.tenant_id}__${row.version}`;
  await client.mdmsV2Create(root, REGISTRY_SCHEMA_CODE, uid, row);
}
