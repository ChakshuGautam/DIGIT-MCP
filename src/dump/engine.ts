import type {
  SurfaceName,
  IncludeScope,
  Manifest,
  DumpOpts,
  RegistryRow,
  ApplyReport,
  SurfaceReport,
  ConflictPolicy,
} from './types.js';
import { ALL_SURFACES } from './types.js';
import { createDumpZip, readDumpZip } from './zip.js';
import { SURFACE_REGISTRY, RESTORE_ORDER } from './surfaces/index.js';
import {
  ensureRegistrySchema,
  nextVersion,
  writeRegistryRow,
  listRegistryRows,
} from './registry.js';

// Structural shape of the methods we need from DigitApiClient.
// Kept loose because each surface module has its own narrow Client interface;
// the real digitApi satisfies all of them.
export interface EngineClient {
  mdmsSchemaSearch(tenantId: string, codes?: string[]): Promise<Record<string, unknown>[]>;
  mdmsSchemaCreate(tenantId: string, code: string, description: string, definition: unknown): Promise<Record<string, unknown>>;
  mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown): Promise<unknown>;
  mdmsV2SearchRaw(tenantId: string, schemaCode: string, options?: { limit?: number; offset?: number }): Promise<Record<string, unknown>[]>;
  filestoreUpload(tenantId: string, module: string, fileBuffer: Buffer, fileName: string, contentType: string): Promise<Record<string, unknown>[]>;
  filestoreDownload(tenantId: string, fileStoreId: string): Promise<Buffer>;
  getAuthInfo(): { user?: { userName?: string } | null; [k: string]: unknown };
  getEnvironmentInfo(): { name?: string; [k: string]: unknown };
  // Plus each surface's own methods — relied on structurally
  [extra: string]: unknown;
}

interface DumpTenantArgs {
  tenant_id: string;
  include?: IncludeScope[];
  surfaces?: SurfaceName[];
}

interface DumpTenantResult {
  version: string;
  filestore_id: string;
  size_bytes: number;
  sha256: string;
  counts: Record<SurfaceName, number>;
}

function rootOf(tenantId: string): string {
  return tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;
}

async function resolveScope(
  client: EngineClient,
  tenantId: string,
  include: IncludeScope[],
): Promise<string[]> {
  const tenants = new Set<string>();
  if (include.includes('self')) tenants.add(tenantId);
  if (include.includes('root')) tenants.add(rootOf(tenantId));
  if (include.includes('children')) {
    const root = rootOf(tenantId);
    const rows = await client.mdmsV2SearchRaw(root, 'tenant.tenants');
    for (const row of rows) {
      const data = row.data as Record<string, unknown> | undefined;
      const code = String(data?.code ?? row.code ?? '');
      if (code && code.startsWith(`${tenantId}.`)) tenants.add(code);
    }
  }
  return Array.from(tenants);
}

type SurfaceModule = {
  name: SurfaceName;
  dump(client: unknown, tenantId: string, opts: DumpOpts): AsyncIterable<string>;
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
}

export async function dumpTenant(
  client: EngineClient,
  args: DumpTenantArgs,
): Promise<DumpTenantResult> {
  const tenantId = args.tenant_id;
  const include = args.include && args.include.length > 0 ? args.include : (['self', 'root'] as IncludeScope[]);
  const surfaces = args.surfaces && args.surfaces.length > 0 ? args.surfaces : [...ALL_SURFACES];

  // 1. Make sure the registry schema exists
  await ensureRegistrySchema(client, rootOf(tenantId));

  // 2. Resolve scope (returns 1..N tenantIds)
  const tenantIds = await resolveScope(client, tenantId, include);

  // 3. Iterate enabled surfaces against each scoped tenant, collecting jsonl entries
  const entries = new Map<string, string[]>();
  const counts: Record<SurfaceName, number> = {
    'mdms-schemas': 0,
    'mdms-data': 0,
    localization: 0,
    workflow: 0,
    boundary: 0,
    'access-control': 0,
  };

  for (const surfaceName of surfaces) {
    const surface = SURFACE_REGISTRY[surfaceName] as SurfaceModule;
    const lines: string[] = [];
    for (const t of tenantIds) {
      for await (const line of surface.dump(client, t, { tenantIds, include })) {
        lines.push(line);
        counts[surfaceName]++;
      }
    }
    // Filename convention: jsonl for streaming surfaces, .json for atomic (workflow, boundary, access-control)
    const ext = (surfaceName === 'workflow' || surfaceName === 'boundary' || surfaceName === 'access-control')
      ? '.json'
      : '.jsonl';
    entries.set(`${surfaceName}${ext}`, lines);
  }

  // 4. Build the manifest + zip
  const version = await nextVersion(client, tenantId);
  const manifest: Manifest = {
    version,
    tenant_id: tenantId,
    include,
    created_at: new Date().toISOString(),
    created_by: client.getAuthInfo()?.user?.userName || 'unknown',
    source_env: client.getEnvironmentInfo()?.name || 'unknown',
    surfaces,
    counts,
    sha256: '',  // overwritten by createDumpZip
    schema_version: 1,
  };

  const zipBuf = await createDumpZip(manifest, entries);

  // 5. Upload to filestore
  const fileName = `${tenantId}-${version}-${timestamp()}.zip`;
  const upload = await client.filestoreUpload(tenantId, 'mcp-dumps', zipBuf, fileName, 'application/zip');
  const filestoreId = String(upload[0]?.fileStoreId ?? '');
  if (!filestoreId) throw new Error('filestore_upload_returned_no_id');

  // 6. Recover the actual sha256 the zip ended up with by re-parsing the manifest.
  // createDumpZip writes the final sha into the in-zip manifest but does not return it;
  // we read it back here rather than re-running the hash. Acknowledged minor wart.
  const { manifest: writtenManifest } = await readDumpZip(zipBuf);
  const sha256 = writtenManifest.sha256;

  // 7. Write the registry row
  const row: RegistryRow = {
    tenant_id: tenantId,
    version,
    filestore_id: filestoreId,
    created_at: manifest.created_at,
    size_bytes: zipBuf.length,
    sha256,
    surfaces,
    include,
  };
  await writeRegistryRow(client, row);

  return {
    version,
    filestore_id: filestoreId,
    size_bytes: zipBuf.length,
    sha256,
    counts,
  };
}

/**
 * List all dumps for a tenant (or all tenants if undefined), sorted by version desc.
 */
export async function listDumps(client: EngineClient, tenantId?: string): Promise<RegistryRow[]> {
  const rows = await listRegistryRows(client, tenantId);
  return [...rows].sort((a, b) => {
    const an = parseInt(a.version.replace(/\D/g, ''), 10) || 0;
    const bn = parseInt(b.version.replace(/\D/g, ''), 10) || 0;
    return bn - an;
  });
}

interface RestoreArgs {
  tenant_id: string;                   // target
  version?: string;                    // 'latest' | 'v3'
  filestore_id?: string;
  on_conflict?: ConflictPolicy;
  dry_run?: boolean;
  surfaces?: SurfaceName[];
  wait_for_persist?: boolean;
}

type SurfaceModuleFull = {
  name: SurfaceName;
  dump(client: unknown, tenantId: string, opts: DumpOpts): AsyncIterable<string>;
  restore(client: unknown, lines: AsyncIterable<string>, target: string, opts: { onConflict: ConflictPolicy; dryRun: boolean }): Promise<SurfaceReport>;
};

async function* linesOf(arr: string[]): AsyncIterable<string> {
  for (const line of arr) yield line;
}

export async function restoreFromFilestore(
  client: EngineClient,
  args: RestoreArgs,
): Promise<ApplyReport> {
  const target = args.tenant_id;
  const onConflict: ConflictPolicy = args.on_conflict || 'skip';
  const dryRun = args.dry_run === true;

  const emptyTotals = { created: 0, updated: 0, skipped: 0, failed: 0 };

  // 1. Resolve filestore_id
  let filestoreId = args.filestore_id;
  if (!filestoreId) {
    const versionWanted = args.version || 'latest';
    const rows = await listRegistryRows(client, target);
    if (rows.length === 0) {
      return { ok: false, partial: false, surfaces: [], totals: { ...emptyTotals }, error: `no_dumps_for_tenant: ${target}` };
    }
    if (versionWanted === 'latest') {
      // sort by version desc
      const sorted = [...rows].sort((a, b) => {
        const an = parseInt(a.version.replace(/\D/g, ''), 10) || 0;
        const bn = parseInt(b.version.replace(/\D/g, ''), 10) || 0;
        return bn - an;
      });
      filestoreId = sorted[0].filestore_id;
    } else {
      const match = rows.find((r) => r.version === versionWanted);
      if (!match) {
        return { ok: false, partial: false, surfaces: [], totals: { ...emptyTotals }, error: `version_not_found: ${versionWanted}` };
      }
      filestoreId = match.filestore_id;
    }
  }

  // 2. Download and unzip
  const buf = await client.filestoreDownload(target, filestoreId);
  let manifestEntries: { manifest: Manifest; entries: Map<string, string[]> };
  try {
    manifestEntries = await readDumpZip(buf);
  } catch (err) {
    return { ok: false, partial: false, surfaces: [], totals: { ...emptyTotals }, error: err instanceof Error ? err.message : String(err) };
  }
  const { manifest, entries } = manifestEntries;

  // 3. Cross-root guard
  const sourceRoot = rootOf(manifest.tenant_id);
  const targetRoot = rootOf(target);
  if (sourceRoot !== targetRoot) {
    return {
      ok: false, partial: false, surfaces: [], totals: { ...emptyTotals },
      error: `cross_root_restore_not_supported: source=${sourceRoot} target=${targetRoot}`,
    };
  }

  // 4. Apply each surface in RESTORE_ORDER (filtered by args.surfaces if given)
  const enabledSurfaces = args.surfaces && args.surfaces.length > 0 ? new Set(args.surfaces) : null;
  const reports: SurfaceReport[] = [];
  const totals = { ...emptyTotals };
  let aborted = false;

  for (const surfaceName of RESTORE_ORDER) {
    if (enabledSurfaces && !enabledSurfaces.has(surfaceName)) continue;

    // Find entries for this surface (try .jsonl first, then .json)
    const surfaceEntries = entries.get(`${surfaceName}.jsonl`) ?? entries.get(`${surfaceName}.json`);
    if (!surfaceEntries) {
      // empty report
      reports.push({ surface: surfaceName, created: 0, updated: 0, skipped: 0, failed: 0, errors: [] });
      continue;
    }

    const surface = SURFACE_REGISTRY[surfaceName] as SurfaceModuleFull;
    const report = await surface.restore(client, linesOf(surfaceEntries), target, { onConflict, dryRun });
    reports.push(report);
    totals.created += report.created;
    totals.updated += report.updated;
    totals.skipped += report.skipped;
    totals.failed += report.failed;
    if (report.abortedAt) { aborted = true; break; }
  }

  // 5. Wait for persist — only if the client supports kafkaLag and dryRun is false.
  // TODO: wire up client.kafkaLag('egov-infra-persist') poll loop (30s timeout) once
  // DigitApiClient exposes a structural kafkaLag method on the EngineClient interface.

  return {
    ok: !aborted,
    partial: aborted,
    surfaces: reports,
    totals,
  };
}
