import type { ToolRegistry } from './registry.js';
import type { ToolMetadata } from '../types/index.js';
import { digitApi } from '../services/digit-api.js';
import { dumpTenant, restoreFromFilestore, listDumps } from '../dump/engine.js';
import { ALL_SURFACES } from '../dump/types.js';
import type { SurfaceName, IncludeScope, ConflictPolicy } from '../dump/types.js';

async function ensureAuthenticated(): Promise<void> {
  if (digitApi.isAuthenticated()) return;
  const u = process.env.CRS_USERNAME, p = process.env.CRS_PASSWORD;
  const t = process.env.CRS_TENANT_ID || digitApi.getEnvironmentInfo().stateTenantId;
  if (!u || !p) {
    throw new Error('Not authenticated. Call "configure" first, or set CRS_USERNAME/CRS_PASSWORD env vars.');
  }
  await digitApi.login(u, p, t);
}

export function registerMdmsDumpRestoreTools(registry: ToolRegistry): void {
  registry.register({
    name: 'mdms_dump',
    group: 'dumps',
    category: 'dumps',
    risk: 'write',
    description:
      'Snapshot a tenant\'s MDMS-shaped configuration (schemas, data, localization, ' +
      'workflow, boundary, access-control roles) into a versioned zip uploaded to ' +
      'DIGIT filestore. Records the version in the mcp-dumps.DumpRegistry MDMS schema. ' +
      'Returns { filestore_id, version, size_bytes, sha256, counts }.',
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Tenant to dump (e.g. "ke.bomet")' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['self', 'root', 'children'] },
          description: 'Tenant scope for the dump. Default: ["self", "root"].',
        },
        surfaces: {
          type: 'array',
          items: { type: 'string', enum: [...ALL_SURFACES] },
          description: 'Subset of surfaces to include. Default: all.',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();
      const result = await dumpTenant(digitApi as never, {
        tenant_id: String(args.tenant_id),
        include: (args.include as IncludeScope[]) || ['self', 'root'],
        surfaces: (args.surfaces as SurfaceName[]) || [...ALL_SURFACES],
      });
      return JSON.stringify({ success: true, ...result }, null, 2);
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'mdms_restore',
    group: 'dumps',
    category: 'dumps',
    risk: 'write',
    description:
      'Apply a previously-dumped tenant configuration onto a tenant. Specify either ' +
      'version ("latest" or "v3") or filestore_id directly. Cross-root restores are ' +
      'rejected. dry_run produces an ApplyReport without writes. on_conflict controls ' +
      'behavior when records already exist at the target.',
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Target tenant' },
        version: { type: 'string', description: 'Dump version to restore. "latest" or e.g. "v3". Ignored if filestore_id is given.' },
        filestore_id: { type: 'string', description: 'Direct filestore UUID. Bypasses registry lookup.' },
        on_conflict: { type: 'string', enum: ['skip', 'overwrite', 'fail'], description: 'Default: skip' },
        dry_run: { type: 'boolean', description: 'If true, no writes are performed. Default: false.' },
        surfaces: { type: 'array', items: { type: 'string', enum: [...ALL_SURFACES] }, description: 'Subset to restore. Default: all from manifest.' },
        wait_for_persist: { type: 'boolean', description: 'After applying, optionally wait for the DIGIT persister Kafka lag to hit zero. Default: true. Not yet implemented; flag is reserved.' },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();
      const report = await restoreFromFilestore(digitApi as never, {
        tenant_id: String(args.tenant_id),
        version: args.version as string | undefined,
        filestore_id: args.filestore_id as string | undefined,
        on_conflict: args.on_conflict as ConflictPolicy | undefined,
        dry_run: args.dry_run as boolean | undefined,
        surfaces: args.surfaces as SurfaceName[] | undefined,
        wait_for_persist: args.wait_for_persist as boolean | undefined,
      });
      return JSON.stringify(report, null, 2);
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'mdms_dumps_list',
    group: 'dumps',
    category: 'dumps',
    risk: 'read',
    description:
      'List all dumps recorded in the mcp-dumps.DumpRegistry, sorted by version ' +
      'descending. Filter by tenant_id (optional).',
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Filter by tenant. Omit to list all.' },
      },
    },
    handler: async (args) => {
      await ensureAuthenticated();
      const dumps = await listDumps(digitApi as never, args.tenant_id as string | undefined);
      return JSON.stringify({ count: dumps.length, dumps }, null, 2);
    },
  } satisfies ToolMetadata);
}
