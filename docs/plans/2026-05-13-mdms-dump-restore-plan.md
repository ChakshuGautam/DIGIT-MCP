# MDMS Dump / Restore Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `mdms_dump`, `mdms_restore`, `mdms_dumps_list` MCP tools so a tenant's MDMS-shaped config (schemas, data, localization, workflow, boundary, access control) can be snapshotted to a versioned zip in DIGIT filestore and re-applied. Validate end-to-end on Bomet.

**Architecture:** Six per-surface modules under `src/dump/surfaces/` each expose `dump()` / `restore()`. `engine.ts` orchestrates them, writes a zip with `jszip`, uploads via the existing `filestoreUpload()`, and records a row in a new `mcp-dumps.DumpRegistry` MDMS schema. Three thin tool wrappers expose the verbs. Same-root cross-tenant only; cross-root is v2.

**Tech Stack:** TypeScript / Node 22 / `jszip` (already in node_modules) / existing `DigitApiClient` from `src/services/digit-api.ts` / `tsx` runner / `c8` coverage / existing MCP `ToolRegistry`.

**Design doc:** `docs/plans/2026-05-13-mdms-dump-restore-design.md`
**Task tracker:** `/root/outputs/TASK-029-mdms-dump-restore.md`

---

## Conventions for the executor

- Run `npm run build` after any TS change to surface type errors fast.
- Use `tsx` directly for unit tests (`tsx test-mdms-dump-restore.ts`) — no jest, no vitest. Match the style of `test-validator.ts`.
- Tests assert with plain `assert` from `node:assert/strict`.
- Commit after every task. Subject line: `feat(dumps): <thing>` or `test(dumps): <thing>`. Body cites the task number in this plan.
- Do NOT touch `src/services/digit-api.ts` except for one tiny addition in Task 5 (a `filestoreDownload` helper). That's the only file we modify outside the new `src/dump/` tree.
- All new code uses `.js` import suffixes (this repo is ESM with `tsc` emitting `.js`).
- The new tool group `dumps` is added to the `ToolGroup` union *before* any tool registration.
- Each surface module is independently testable with a stub `DigitApiClient` — see Task 7 for the pattern.

---

### Task 1: Add `dumps` tool group

**Files:**
- Modify: `src/types/index.ts:8` (extend `ToolGroup` union)
- Modify: `src/types/index.ts:10` (extend `ALL_GROUPS` array)
- Modify: `src/tools/discover-tools.ts` (add `dumps` to the `enable_tools` description)

**Step 1: Edit the union**

`src/types/index.ts` line 8 — change:

```ts
export type ToolGroup = 'core' | 'mdms' | 'boundary' | 'masters' | 'employees' | 'localization' | 'pgr' | 'admin' | 'idgen' | 'location' | 'encryption' | 'docs' | 'monitoring' | 'tracing';
```

to:

```ts
export type ToolGroup = 'core' | 'mdms' | 'boundary' | 'masters' | 'employees' | 'localization' | 'pgr' | 'admin' | 'idgen' | 'location' | 'encryption' | 'docs' | 'monitoring' | 'tracing' | 'dumps';
```

and line 10 — append `'dumps'` to `ALL_GROUPS`.

**Step 2: Edit `enable_tools` description**

`src/tools/discover-tools.ts` — find the `description` block listing groups and append:

```
dumps (mdms_dump / mdms_restore / mdms_dumps_list — versioned tenant config snapshots)
```

**Step 3: Build**

```bash
cd /root/DIGIT-MCP && npm run build
```

Expected: clean exit, no TS errors.

**Step 4: Commit**

```bash
git add src/types/index.ts src/tools/discover-tools.ts
git commit -m "feat(dumps): add 'dumps' tool group (TASK-029 #1)"
```

---

### Task 2: Pin `jszip` as an explicit dependency

`jszip` is already present transitively. Make it explicit so the production build doesn't break if the transitive dep goes away.

**Files:** `package.json`

**Step 1: Inspect**

```bash
npm ls jszip
```

Note the version.

**Step 2: Pin**

```bash
npm install --save jszip@^3
```

**Step 3: Build**

```bash
npm run build
```

Expected: clean.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(dumps): pin jszip as explicit dependency (TASK-029 #2)"
```

---

### Task 3: Dump types module

**Files:**
- Create: `src/dump/types.ts`

**Step 1: Write `src/dump/types.ts`**

```ts
export type SurfaceName =
  | 'mdms-schemas'
  | 'mdms-data'
  | 'localization'
  | 'workflow'
  | 'boundary'
  | 'access-control';

export const ALL_SURFACES: SurfaceName[] = [
  'mdms-schemas',
  'mdms-data',
  'localization',
  'workflow',
  'boundary',
  'access-control',
];

export type IncludeScope = 'self' | 'root' | 'children';

export type ConflictPolicy = 'skip' | 'overwrite' | 'fail';

export interface Manifest {
  version: string;                            // "v1", "v2", ...
  tenant_id: string;
  include: IncludeScope[];
  created_at: string;                         // ISO 8601
  created_by: string;
  source_env: string;
  surfaces: SurfaceName[];
  counts: Record<SurfaceName, number>;
  sha256: string;
  schema_version: 1;
}

export interface DumpOpts {
  tenantIds: string[];                        // already-resolved scope
  include: IncludeScope[];
}

export interface RestoreOpts {
  onConflict: ConflictPolicy;
  dryRun: boolean;
}

export interface SurfaceReport {
  surface: SurfaceName;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ identifier: string; message: string }>;
  abortedAt?: { identifier: string };
}

export interface ApplyReport {
  ok: boolean;
  partial: boolean;
  surfaces: SurfaceReport[];
  totals: { created: number; updated: number; skipped: number; failed: number };
  warning?: string;
  error?: string;
}

export interface RegistryRow {
  tenant_id: string;
  version: string;
  filestore_id: string;
  created_at: string;
  size_bytes: number;
  sha256: string;
  surfaces: SurfaceName[];
  include: IncludeScope[];
}
```

**Step 2: Build**

```bash
npm run build
```

Expected: clean.

**Step 3: Commit**

```bash
git add src/dump/types.ts
git commit -m "feat(dumps): add type definitions (TASK-029 #3)"
```

---

### Task 4: Zip helper with round-trip test

**Files:**
- Create: `src/dump/zip.ts`
- Create: `test-mdms-dump-restore.ts` (root of repo, alongside `test-validator.ts`)

**Step 1: Write the failing test**

`test-mdms-dump-restore.ts`:

```ts
import assert from 'node:assert/strict';
import { createDumpZip, readDumpZip } from './src/dump/zip.js';
import type { Manifest } from './src/dump/types.js';

const manifest: Manifest = {
  version: 'v1',
  tenant_id: 'pwt.test',
  include: ['self'],
  created_at: '2026-05-13T00:00:00Z',
  created_by: 'ADMIN@pwt.test',
  source_env: 'unit-test',
  surfaces: ['mdms-schemas', 'mdms-data'],
  counts: { 'mdms-schemas': 0, 'mdms-data': 0, localization: 0, workflow: 0, boundary: 0, 'access-control': 0 },
  sha256: '',
  schema_version: 1,
};

async function testZipRoundTrip() {
  const lines = new Map<string, string[]>();
  lines.set('mdms-schemas.jsonl', ['{"code":"common-masters.Department"}', '{"code":"common-masters.Designation"}']);
  lines.set('mdms-data.jsonl', ['{"schemaCode":"common-masters.Department","uniqueIdentifier":"d1","tenantId":"pwt.test","data":{}}']);

  const buf = await createDumpZip(manifest, lines);
  assert.ok(buf.length > 0, 'zip buffer should be non-empty');

  const out = await readDumpZip(buf);
  assert.equal(out.manifest.tenant_id, 'pwt.test');
  assert.equal(out.manifest.sha256.length, 64, 'sha256 should be 64 hex chars');
  assert.deepEqual(Array.from(out.entries.keys()).sort(), ['mdms-data.jsonl', 'mdms-schemas.jsonl']);
  assert.equal(out.entries.get('mdms-schemas.jsonl')!.length, 2);
}

await testZipRoundTrip();
console.log('✓ zip round-trip');
```

**Step 2: Run, expect failure**

```bash
cd /root/DIGIT-MCP && npx tsx test-mdms-dump-restore.ts
```

Expected: ERR_MODULE_NOT_FOUND for `./src/dump/zip.js`.

**Step 3: Write `src/dump/zip.ts`**

```ts
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import type { Manifest } from './types.js';

const MANIFEST_FILE = 'manifest.json';

/**
 * Create a zip buffer from a manifest + per-entry content. `entries` maps
 * file name (e.g. "mdms-data.jsonl") to an array of lines (no trailing newline).
 * The sha256 in the manifest is computed over the concatenated entry bodies
 * in sorted-by-key order, then written into the manifest before the zip is
 * finalized.
 */
export async function createDumpZip(
  manifest: Manifest,
  entries: Map<string, string[]>,
): Promise<Buffer> {
  const zip = new JSZip();

  // Compute sha over entry bodies in deterministic order
  const sortedKeys = Array.from(entries.keys()).sort();
  const hash = createHash('sha256');
  for (const key of sortedKeys) {
    const body = entries.get(key)!.join('\n');
    hash.update(key);
    hash.update('\0');
    hash.update(body);
    hash.update('\0');
  }
  const sha256 = hash.digest('hex');

  const finalManifest: Manifest = { ...manifest, sha256 };
  zip.file(MANIFEST_FILE, JSON.stringify(finalManifest, null, 2));

  for (const key of sortedKeys) {
    zip.file(key, entries.get(key)!.join('\n'));
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Read a zip buffer. Verifies sha256 in the manifest against the recomputed
 * value over the entry bodies. Throws on mismatch.
 */
export async function readDumpZip(
  buf: Buffer,
): Promise<{ manifest: Manifest; entries: Map<string, string[]> }> {
  const zip = await JSZip.loadAsync(buf);
  const manifestRaw = zip.file(MANIFEST_FILE);
  if (!manifestRaw) throw new Error('zip is missing manifest.json');
  const manifest = JSON.parse(await manifestRaw.async('string')) as Manifest;

  const entries = new Map<string, string[]>();
  for (const [name, file] of Object.entries(zip.files)) {
    if (name === MANIFEST_FILE || file.dir) continue;
    const body = await file.async('string');
    entries.set(name, body === '' ? [] : body.split('\n'));
  }

  // Recompute sha over the same surface as createDumpZip
  const sortedKeys = Array.from(entries.keys()).sort();
  const hash = createHash('sha256');
  for (const key of sortedKeys) {
    const body = entries.get(key)!.join('\n');
    hash.update(key);
    hash.update('\0');
    hash.update(body);
    hash.update('\0');
  }
  const computed = hash.digest('hex');
  if (computed !== manifest.sha256) {
    throw new Error(`manifest_checksum_mismatch: expected ${manifest.sha256}, got ${computed}`);
  }

  return { manifest, entries };
}
```

**Step 4: Run, expect pass**

```bash
npx tsx test-mdms-dump-restore.ts
```

Expected: `✓ zip round-trip`.

**Step 5: Commit**

```bash
git add src/dump/zip.ts test-mdms-dump-restore.ts
git commit -m "feat(dumps): zip helper with manifest sha256 (TASK-029 #4)

Test asserts round-trip + checksum integrity."
```

---

### Task 5: Filestore download helper on DigitApiClient

The MCP only has `filestoreGetUrl` today (returns signed URLs). Restore needs to actually fetch the bytes. Add a helper.

**Files:**
- Modify: `src/services/digit-api.ts` — add one method near the existing `filestoreGetUrl` (around line 761).

**Step 1: Locate insertion point**

```bash
grep -n "filestoreGetUrl" src/services/digit-api.ts
```

Note the closing `}` of `filestoreGetUrl`.

**Step 2: Add `filestoreDownload`**

Immediately after the closing `}` of `filestoreGetUrl`, insert:

```ts
  /**
   * Download the raw bytes of a filestore entry by ID. Two-step internally:
   * first fetches the signed URL via `/filestore/v1/files/url`, then GETs that URL.
   */
  async filestoreDownload(
    tenantId: string,
    fileStoreId: string,
  ): Promise<Buffer> {
    const urls = await this.filestoreGetUrl(tenantId, [fileStoreId]);
    const entry = urls[0] as Record<string, unknown> | undefined;
    const url = entry?.url as string | undefined;
    if (!url) throw new Error(`filestore_url_not_found: ${fileStoreId}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`filestore_download_failed: ${response.status} for ${fileStoreId}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
```

**Step 3: Build**

```bash
npm run build
```

Expected: clean.

**Step 4: Smoke**

```bash
npx tsx -e "import('./src/services/digit-api.js').then(m => console.log(typeof m.digitApi.filestoreDownload))"
```

Expected: `function`.

**Step 5: Commit**

```bash
git add src/services/digit-api.ts
git commit -m "feat(dumps): add filestoreDownload helper on DigitApiClient (TASK-029 #5)"
```

---

### Task 6: Registry module — schema bootstrap

**Files:**
- Create: `src/dump/registry.ts`
- Modify: `test-mdms-dump-restore.ts` — append a stub-client test

**Step 1: Write the failing test**

Append to `test-mdms-dump-restore.ts`:

```ts
import { ensureRegistrySchema, nextVersion, writeRegistryRow, listRegistryRows, REGISTRY_SCHEMA_CODE } from './src/dump/registry.js';

async function testRegistry() {
  // Stub DigitApiClient — captures calls
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stubSchemas: Record<string, unknown>[] = [];
  const stubData: Record<string, unknown>[] = [];

  const client = {
    async mdmsSchemaSearch(tenantId: string, codes?: string[]) {
      calls.push({ method: 'mdmsSchemaSearch', args: [tenantId, codes] });
      if (codes?.includes(REGISTRY_SCHEMA_CODE)) {
        return stubSchemas.filter((s) => s.code === REGISTRY_SCHEMA_CODE);
      }
      return [];
    },
    async mdmsSchemaCreate(tenantId: string, code: string, description: string, definition: unknown) {
      calls.push({ method: 'mdmsSchemaCreate', args: [tenantId, code, description, definition] });
      stubSchemas.push({ code, tenantId });
      return { code };
    },
    async mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown) {
      calls.push({ method: 'mdmsV2Create', args: [tenantId, schemaCode, uniqueIdentifier, data] });
      stubData.push({ tenantId, schemaCode, uniqueIdentifier, data, isActive: true });
      return { id: 'x', schemaCode, tenantId, uniqueIdentifier, data };
    },
    async mdmsV2SearchRaw(tenantId: string, schemaCode: string) {
      calls.push({ method: 'mdmsV2SearchRaw', args: [tenantId, schemaCode] });
      return stubData.filter((d) => d.schemaCode === schemaCode);
    },
  } as never; // structural typing — registry.ts only uses these four methods

  // 1) ensureRegistrySchema is idempotent
  await ensureRegistrySchema(client, 'pwt.test');
  await ensureRegistrySchema(client, 'pwt.test');
  const createCalls = calls.filter((c) => c.method === 'mdmsSchemaCreate');
  assert.equal(createCalls.length, 1, 'schema should be created exactly once');

  // 2) nextVersion is monotonic
  const v1 = await nextVersion(client, 'pwt.test');
  assert.equal(v1, 'v1');
  await writeRegistryRow(client, {
    tenant_id: 'pwt.test', version: v1,
    filestore_id: 'fs-1', created_at: 'now', size_bytes: 100,
    sha256: 'a'.repeat(64), surfaces: ['mdms-data'], include: ['self'],
  });
  const v2 = await nextVersion(client, 'pwt.test');
  assert.equal(v2, 'v2');

  // 3) listRegistryRows returns rows
  const rows = await listRegistryRows(client, 'pwt.test');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 'v1');
}

await testRegistry();
console.log('✓ registry');
```

**Step 2: Run, expect failure**

```bash
npx tsx test-mdms-dump-restore.ts
```

Expected: ERR_MODULE_NOT_FOUND for `registry.js`.

**Step 3: Write `src/dump/registry.ts`**

```ts
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
```

**Step 4: Run, expect pass**

```bash
npx tsx test-mdms-dump-restore.ts
```

Expected: `✓ zip round-trip` then `✓ registry`.

**Step 5: Commit**

```bash
git add src/dump/registry.ts test-mdms-dump-restore.ts
git commit -m "feat(dumps): registry module with bootstrap + version monotonicity (TASK-029 #6)"
```

---

### Task 7: Surface — mdms-schemas (dump + restore + test)

Establish the **stub-client + per-surface test** pattern that subsequent surfaces follow.

**Files:**
- Create: `src/dump/surfaces/mdmsSchemas.ts`
- Modify: `test-mdms-dump-restore.ts`

**Step 1: Write the failing test**

Append:

```ts
import { mdmsSchemasSurface } from './src/dump/surfaces/mdmsSchemas.js';

async function testMdmsSchemasSurface() {
  const schemas = [
    { code: 'common-masters.Department', tenantId: 'pwt.test', description: 'D', definition: {} },
    { code: 'mcp-dumps.DumpRegistry',    tenantId: 'pwt.test', description: 'R', definition: {} },
  ];
  const client = {
    async mdmsSchemaSearch() { return schemas; },
    async mdmsSchemaCreate(_t: string, code: string) {
      return { code };
    },
  } as never;

  const lines: string[] = [];
  for await (const line of mdmsSchemasSurface.dump(client, 'pwt.test', { tenantIds: ['pwt.test'], include: ['self'] })) {
    lines.push(line);
  }
  // Excludes mcp-dumps.* prefix
  assert.equal(lines.length, 1);
  assert.match(lines[0], /common-masters\.Department/);

  // Restore: skip-on-exists when schema is in existing list
  async function* iter() { yield* lines; }
  const existing = [{ code: 'common-masters.Department' }];
  const skipClient = {
    async mdmsSchemaSearch() { return existing; },
    async mdmsSchemaCreate() { throw new Error('should not be called'); },
  } as never;
  const report = await mdmsSchemasSurface.restore(skipClient, iter(), 'pwt.test', { onConflict: 'skip', dryRun: false });
  assert.equal(report.skipped, 1);
  assert.equal(report.created, 0);
}

await testMdmsSchemasSurface();
console.log('✓ surface: mdms-schemas');
```

**Step 2: Run, expect failure**

```bash
npx tsx test-mdms-dump-restore.ts
```

Expected: module not found.

**Step 3: Write `src/dump/surfaces/mdmsSchemas.ts`**

```ts
import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

const REGISTRY_PREFIX = 'mcp-dumps.';

interface Client {
  mdmsSchemaSearch(tenantId: string, codes?: string[]): Promise<Record<string, unknown>[]>;
  mdmsSchemaCreate(tenantId: string, code: string, description: string, definition: unknown): Promise<Record<string, unknown>>;
}

export const mdmsSchemasSurface = {
  name: 'mdms-schemas' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const schemas = await client.mdmsSchemaSearch(tenantId);
    for (const s of schemas) {
      const code = String(s.code);
      if (code.startsWith(REGISTRY_PREFIX)) continue;
      yield JSON.stringify(s);
    }
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = {
      surface: 'mdms-schemas',
      created: 0, updated: 0, skipped: 0, failed: 0, errors: [],
    };
    const existing = new Set(
      (await client.mdmsSchemaSearch(target)).map((s) => String(s.code)),
    );

    for await (const line of lines) {
      const s = JSON.parse(line) as { code: string; description?: string; definition?: unknown };
      const code = s.code;
      const exists = existing.has(code);

      if (exists) {
        if (opts.onConflict === 'skip')      { report.skipped++; continue; }
        if (opts.onConflict === 'fail')      { report.abortedAt = { identifier: code }; return report; }
        // overwrite: MDMS schema create is upsert on code
      }

      if (opts.dryRun) {
        if (exists) report.updated++; else report.created++;
        continue;
      }

      try {
        await client.mdmsSchemaCreate(target, code, s.description || '', s.definition || {});
        if (exists) report.updated++; else report.created++;
        existing.add(code);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: code, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
```

**Step 4: Run, expect pass**

```bash
npx tsx test-mdms-dump-restore.ts
```

Expected: previous tests + `✓ surface: mdms-schemas`.

**Step 5: Commit**

```bash
git add src/dump/surfaces/mdmsSchemas.ts test-mdms-dump-restore.ts
git commit -m "feat(dumps): mdms-schemas surface — excludes mcp-dumps.* (TASK-029 #7)"
```

---

### Task 8: Surface — mdms-data

**Files:**
- Create: `src/dump/surfaces/mdmsData.ts`
- Modify: `test-mdms-dump-restore.ts`

**Step 1: Write the failing test**

Append:

```ts
import { mdmsDataSurface } from './src/dump/surfaces/mdmsData.js';

async function testMdmsDataSurface() {
  const allSchemas = [
    { code: 'common-masters.Department' },
    { code: 'mcp-dumps.DumpRegistry' },   // must be excluded
  ];
  const recordsBySchema: Record<string, Record<string, unknown>[]> = {
    'common-masters.Department': [
      { tenantId: 'pwt.test', schemaCode: 'common-masters.Department', uniqueIdentifier: 'd1', data: { code: 'ENG' }, isActive: true },
      { tenantId: 'pwt.test', schemaCode: 'common-masters.Department', uniqueIdentifier: 'd2', data: { code: 'OPS' }, isActive: true },
    ],
  };
  const createCalls: unknown[] = [];
  const client = {
    async mdmsSchemaSearch() { return allSchemas; },
    async mdmsV2SearchRaw(_t: string, schemaCode: string) {
      return recordsBySchema[schemaCode] || [];
    },
    async mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown) {
      createCalls.push({ tenantId, schemaCode, uniqueIdentifier, data });
      return { id: 'x' };
    },
  } as never;

  // Dump: emits 2 lines, both for Department (registry schema filtered out)
  const lines: string[] = [];
  for await (const line of mdmsDataSurface.dump(client, 'pwt.test', { tenantIds: ['pwt.test'], include: ['self'] })) {
    lines.push(line);
  }
  assert.equal(lines.length, 2);

  // Restore onto empty target, on_conflict=skip — all created
  async function* iter() { yield* lines; }
  const emptyClient = {
    async mdmsV2SearchRaw() { return []; },
    async mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown) {
      createCalls.push({ tenantId, schemaCode, uniqueIdentifier, data });
      return { id: 'x' };
    },
  } as never;
  const report = await mdmsDataSurface.restore(emptyClient, iter(), 'pwt.test', { onConflict: 'skip', dryRun: false });
  assert.equal(report.created, 2);
  assert.equal(report.skipped, 0);
}

await testMdmsDataSurface();
console.log('✓ surface: mdms-data');
```

**Step 2: Run, expect failure**

**Step 3: Write `src/dump/surfaces/mdmsData.ts`**

```ts
import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

const REGISTRY_PREFIX = 'mcp-dumps.';

interface Client {
  mdmsSchemaSearch(tenantId: string, codes?: string[]): Promise<Record<string, unknown>[]>;
  mdmsV2SearchRaw(tenantId: string, schemaCode: string, options?: { limit?: number; offset?: number }): Promise<Record<string, unknown>[]>;
  mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown): Promise<unknown>;
}

export const mdmsDataSurface = {
  name: 'mdms-data' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const schemas = (await client.mdmsSchemaSearch(tenantId))
      .map((s) => String(s.code))
      .filter((c) => !c.startsWith(REGISTRY_PREFIX));

    for (const schemaCode of schemas) {
      // Naive pagination: keep fetching until empty page
      let offset = 0;
      const limit = 500;
      while (true) {
        const page = await client.mdmsV2SearchRaw(tenantId, schemaCode, { limit, offset });
        if (page.length === 0) break;
        for (const row of page) yield JSON.stringify(row);
        if (page.length < limit) break;
        offset += limit;
      }
    }
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = {
      surface: 'mdms-data',
      created: 0, updated: 0, skipped: 0, failed: 0, errors: [],
    };
    // Cache existence per (schemaCode, uniqueIdentifier)
    const existsCache = new Map<string, Set<string>>();

    async function exists(schemaCode: string, uid: string): Promise<boolean> {
      let set = existsCache.get(schemaCode);
      if (!set) {
        const rows = await client.mdmsV2SearchRaw(target, schemaCode);
        set = new Set(rows.map((r) => String(r.uniqueIdentifier ?? '')));
        existsCache.set(schemaCode, set);
      }
      return set.has(uid);
    }

    for await (const line of lines) {
      const row = JSON.parse(line) as { schemaCode: string; uniqueIdentifier: string; data: unknown };
      const uid = String(row.uniqueIdentifier);
      const present = await exists(row.schemaCode, uid);

      if (present) {
        if (opts.onConflict === 'skip')     { report.skipped++; continue; }
        if (opts.onConflict === 'fail')     { report.abortedAt = { identifier: `${row.schemaCode}/${uid}` }; return report; }
      }

      if (opts.dryRun) {
        if (present) report.updated++; else report.created++;
        continue;
      }

      try {
        await client.mdmsV2Create(target, row.schemaCode, uid, row.data);
        if (present) report.updated++; else report.created++;
        existsCache.get(row.schemaCode)!.add(uid);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: `${row.schemaCode}/${uid}`, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
```

**Step 4: Run, expect pass**

**Step 5: Commit**

```bash
git add src/dump/surfaces/mdmsData.ts test-mdms-dump-restore.ts
git commit -m "feat(dumps): mdms-data surface with skip/overwrite/fail (TASK-029 #8)"
```

---

### Task 9: Surface — localization

**Files:**
- Create: `src/dump/surfaces/localization.ts`
- Modify: `test-mdms-dump-restore.ts`

Pattern matches Task 8. Localization is upsert by `(locale, code)` so `overwrite` and `skip` produce the same wire result; report counts differ.

Known locales discovered via `mdmsV2SearchRaw(tenantId, 'common-masters.StateInfo')` first (per `tenant_bootstrap` precedent), then for each locale we call `localizationSearch(tenantId, locale, undefined)` to get all modules.

**Step 1: Test** — fixtures: 2 locales (`en_IN`, `sw_KE`), 3 messages each. Restore against an empty target → 6 created. Restore again under `skip` → 6 skipped.

**Step 2–5:** Mirror Task 8 structure. Implementation calls `localizationSearch` for dump and `localizationUpsert` for restore.

```ts
// src/dump/surfaces/localization.ts — skeleton
import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

const DEFAULT_LOCALES = ['en_IN', 'en_US'];   // baseline; extended via StateInfo if present

interface Client {
  mdmsV2SearchRaw(tenantId: string, schemaCode: string): Promise<Record<string, unknown>[]>;
  localizationSearch(tenantId: string, locale: string, module?: string): Promise<Record<string, unknown>[]>;
  localizationUpsert(tenantId: string, locale: string, messages: { code: string; message: string; module: string }[]): Promise<Record<string, unknown>[]>;
}

export const localizationSurface = {
  name: 'localization' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const locales = new Set<string>(DEFAULT_LOCALES);
    const stateInfo = await client.mdmsV2SearchRaw(tenantId.includes('.') ? tenantId.split('.')[0] : tenantId, 'common-masters.StateInfo');
    for (const row of stateInfo) {
      const data = (row.data || row) as { languages?: Array<{ value?: string }> };
      for (const l of data.languages || []) if (l.value) locales.add(l.value);
    }

    for (const locale of locales) {
      const messages = await client.localizationSearch(tenantId, locale);
      for (const m of messages) {
        yield JSON.stringify({ locale, ...m });
      }
    }
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = { surface: 'localization', created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };
    // Batch per (locale, module) for efficiency
    const byBucket = new Map<string, { code: string; message: string; module: string }[]>();
    const allLines: { locale: string; code: string; message: string; module: string }[] = [];
    for await (const line of lines) {
      const row = JSON.parse(line) as { locale: string; code: string; message: string; module: string };
      allLines.push(row);
      const key = `${row.locale}::${row.module}`;
      if (!byBucket.has(key)) byBucket.set(key, []);
      byBucket.get(key)!.push({ code: row.code, message: row.message, module: row.module });
    }

    // Existence map per (locale, module, code)
    const existing = new Set<string>();
    const localeModulePairs = new Set([...byBucket.keys()]);
    for (const key of localeModulePairs) {
      const [locale, module] = key.split('::');
      const live = await client.localizationSearch(target, locale, module);
      for (const m of live) existing.add(`${locale}::${module}::${String(m.code)}`);
    }

    for (const row of allLines) {
      const key = `${row.locale}::${row.module}::${row.code}`;
      const present = existing.has(key);

      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: key }; return report; }

      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }

      try {
        await client.localizationUpsert(target, row.locale, [{ code: row.code, message: row.message, module: row.module }]);
        if (present) report.updated++; else report.created++;
        existing.add(key);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: key, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
```

Test mirrors Task 8. Commit: `feat(dumps): localization surface with upsert semantics (TASK-029 #9)`.

---

### Task 10: Surface — workflow

`workflowBusinessServiceSearch(tenantId)` returns an array. Dump emits one JSON document (the whole array, as a single line since this surface uses `.json` not `.jsonl` in the zip — keep it consistent by serializing the array on dump and parsing once on restore).

Restore order: existing services indexed by `businessService` (the code). For each in the dump:
- exists + `skip` → skipped
- exists + `overwrite` → `workflowBusinessServiceUpdate`
- exists + `fail` → abort
- not exists → `workflowBusinessServiceCreate`

Test fixture: 2 services in source, 1 already exists in target. Under `skip`: 1 created, 1 skipped. Under `overwrite`: 1 created, 1 updated.

File: `src/dump/surfaces/workflow.ts`. Commit: `feat(dumps): workflow surface (TASK-029 #10)`.

---

### Task 11: Surface — boundary

Three-step fetch on dump: `boundaryHierarchySearch`, `boundarySearch`, `boundaryRelationshipTreeSearch`. Emit as one JSON: `{ hierarchies, entities, relationships }`.

Three-step restore in fixed order: hierarchies → entities → relationships. Conflict policy applies per-resource. Cache existing codes per resource type to avoid re-querying.

Test fixture: synthetic hierarchy "ADMIN" with 1 parent + 1 child. Round-trip onto empty target → all three created.

File: `src/dump/surfaces/boundary.ts`. Commit: `feat(dumps): boundary surface — 3-stage create order (TASK-029 #11)`.

---

### Task 12: Surface — access-control

`accessRolesSearch(tenantId)` → emit each role as JSONL. Role-actions deliberately skipped (matches `tenant_bootstrap`'s comment about `x-ref-schema` deps).

Restore: there's no `accessRoleCreate` on the client today — roles are created via MDMS schema `ACCESSCONTROL-ROLES.roles`. Use `mdmsV2Create` against that schema. Cite the precedent in code comments.

Test: 3 roles in dump, 1 already at target → 2 created, 1 skipped under `skip`.

File: `src/dump/surfaces/accessControl.ts`. Commit: `feat(dumps): access-control roles surface (TASK-029 #12)`.

---

### Task 13: Surfaces index + ordering

**Files:**
- Create: `src/dump/surfaces/index.ts`

```ts
import { mdmsSchemasSurface } from './mdmsSchemas.js';
import { mdmsDataSurface } from './mdmsData.js';
import { localizationSurface } from './localization.js';
import { workflowSurface } from './workflow.js';
import { boundarySurface } from './boundary.js';
import { accessControlSurface } from './accessControl.js';
import type { SurfaceName } from '../types.js';

export const SURFACE_REGISTRY = {
  'mdms-schemas': mdmsSchemasSurface,
  'mdms-data':    mdmsDataSurface,
  'localization': localizationSurface,
  'workflow':     workflowSurface,
  'boundary':     boundarySurface,
  'access-control': accessControlSurface,
} as const;

// Restore order — dependencies first
export const RESTORE_ORDER: SurfaceName[] = [
  'mdms-schemas',
  'mdms-data',
  'localization',
  'workflow',
  'boundary',
  'access-control',
];
```

Commit: `feat(dumps): surface registry + restore ordering (TASK-029 #13)`.

---

### Task 14: Engine — `dumpTenant`

**Files:**
- Create: `src/dump/engine.ts`

Stitches: `resolveScope` → `ensureRegistrySchema` → iterate surfaces, collect lines into Map → `createDumpZip` → `filestoreUpload` → `nextVersion` → `writeRegistryRow`.

Per-tenant scope resolution from `include`:
- `["self"]` → `[tenantId]`
- `["self", "root"]` → `[tenantId, rootOf(tenantId)]` (deduped if already root)
- `["self", "children"]` → `[tenantId, ...children]` (children resolved via `mdms_get_tenants` filtered by `code.startsWith(tenantId + ".")`)
- All three → union, deduped

Test: integration test deferred to Task 19 (against live DIGIT). Unit test mocks the surfaces to assert orchestration: assert all 6 surfaces called, manifest has correct counts, filestore_id returned, registry row written.

Commit: `feat(dumps): engine.dumpTenant orchestrator (TASK-029 #14)`.

---

### Task 15: Engine — `restoreFromFilestore`

**Files:** modify `src/dump/engine.ts`.

Stitches: resolve filestore_id (via registry if `version`, direct if `filestore_id`) → download via `filestoreDownload` → `readDumpZip` (verifies sha) → cross-root check → iterate `RESTORE_ORDER`, call each `surface.restore()` → accumulate ApplyReport → optionally wait for persister lag.

Cross-root check:

```ts
const sourceRoot = rootOf(manifest.tenant_id);
const targetRoot = rootOf(target);
if (sourceRoot !== targetRoot) {
  return { ok: false, partial: false, ...empty totals,
    error: `cross_root_restore_not_supported: source=${sourceRoot} target=${targetRoot}` };
}
```

Unit test: stub all 6 surfaces' `restore` to return canned reports; assert totals roll up correctly and cross-root rejection works.

Commit: `feat(dumps): engine.restoreFromFilestore with cross-root guard (TASK-029 #15)`.

---

### Task 16: Engine — `listDumps`

Trivial wrapper around `listRegistryRows`, sorted by version desc. One-line implementation + one unit test.

Commit: `feat(dumps): engine.listDumps (TASK-029 #16)`.

---

### Task 17: MCP tool wrappers

**Files:**
- Create: `src/tools/mdms-dump-restore.ts`

Three tools registered in one file via `registerMdmsDumpRestoreTools(registry)`:

```ts
import type { ToolMetadata, ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';
import { dumpTenant, restoreFromFilestore, listDumps } from '../dump/engine.js';
import { ALL_SURFACES } from '../dump/types.js';

export function registerMdmsDumpRestoreTools(registry: ToolRegistry): void {
  registry.register({
    name: 'mdms_dump',
    group: 'dumps',
    description: 'Snapshot a tenant\'s MDMS-shaped config (schemas, data, localization, workflow, boundary, access control) to a versioned zip in DIGIT filestore. Returns { filestore_id, version, sha256, counts }.',
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Tenant to dump' },
        include:   { type: 'array', items: { type: 'string', enum: ['self', 'root', 'children'] }, description: 'Scope. Default: [self, root]' },
        surfaces:  { type: 'array', items: { type: 'string', enum: ALL_SURFACES }, description: 'Subset of surfaces. Default: all.' },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();
      const result = await dumpTenant(digitApi, {
        tenantId: String(args.tenant_id),
        include: (args.include as ('self'|'root'|'children')[]) || ['self', 'root'],
        surfaces: (args.surfaces as never) || ALL_SURFACES,
      });
      return JSON.stringify({ success: true, ...result }, null, 2);
    },
  } satisfies ToolMetadata);

  // mdms_restore — similar shape, accepts version OR filestore_id, on_conflict, dry_run, surfaces, wait_for_persist
  // mdms_dumps_list — accepts optional tenant_id
}

async function ensureAuthenticated() {
  if (digitApi.isAuthenticated()) return;
  const u = process.env.CRS_USERNAME, p = process.env.CRS_PASSWORD;
  const t = process.env.CRS_TENANT_ID || digitApi.getEnvironmentInfo().stateTenantId;
  if (!u || !p) throw new Error('Not authenticated. Call "configure" first.');
  await digitApi.login(u, p, t);
}
```

Then modify `src/tools/index.ts` to import + call `registerMdmsDumpRestoreTools(registry);`.

Build + assert tool list contains all three via:

```bash
npx tsx -e "
import { ToolRegistry } from './src/tools/registry.js';
import { registerAllTools } from './src/tools/index.js';
const r = new ToolRegistry();
registerAllTools(r);
r.enableGroup('dumps');
const tools = r.getEnabledTools().map(t => t.name);
console.log(tools.filter(n => n.startsWith('mdms_d')));
"
```

Expected: `[ 'mdms_dump', 'mdms_restore', 'mdms_dumps_list' ]`.

Commit: `feat(dumps): mcp tool wrappers + registration (TASK-029 #17)`.

---

### Task 18: Integration round-trip against local DIGIT

**Files:**
- Create: `test-mdms-dump-restore-integration.ts`

Use a unique throwaway tenant `pwt.dump-roundtrip-<ts>`. Steps inside the test:

```
1. configure ADMIN against local DIGIT (env-driven, fail-fast if not reachable)
2. tenant_bootstrap target=pwt.dump-roundtrip-<ts> source=pg
3. capture pre-counts: schemas/data/localization for 3 sentinel codes
4. mdms_dump tenant=pwt.dump-roundtrip-<ts> include=[self, root]
5. assert filestore_id non-empty, sha256.length=64, counts > 0 across all surfaces
6. mdms_dumps_list tenant=<same> → assert v1 present
7. tenant_cleanup → soft-delete all data (NOT schemas)
8. assert pre-counts now zero for sentinels
9. mdms_restore tenant=<same> version=latest on_conflict=skip
10. assert post-counts match pre-counts
```

Run gate: `npm run test:dumps:integration`. Add script in `package.json`:

```json
"test:dumps:integration": "tsx test-mdms-dump-restore-integration.ts"
```

Run:

```bash
npm run test:dumps:integration
```

Expected: all 10 steps log `OK`. If any fails, surface the failing step's diff before exiting non-zero.

Commit: `test(dumps): integration round-trip against local DIGIT (TASK-029 #18)`.

---

### Task 19: Conflict matrix test

**Files:**
- Extend: `test-mdms-dump-restore-integration.ts`

3 × 3 matrix:
- Pre-seed one record per surface in target.
- Restore dump with each of `skip`, `overwrite`, `fail` (no `dry_run`).
- Assert per-surface report counts match expectation.

Plus a `dry_run=true` pass that asserts the live DIGIT was NOT mutated (re-check pre-counts unchanged).

Commit: `test(dumps): conflict policy matrix + dry-run (TASK-029 #19)`.

---

### Task 20: Cross-root negative test

**Files:**
- Extend: `test-mdms-dump-restore-integration.ts`

After the round-trip, attempt `mdms_restore(target_tenant="pg.citya", filestore_id=<the v1 zip from step 4>)`. Assert response contains `cross_root_restore_not_supported` and no DIGIT writes happened.

Commit: `test(dumps): cross-root rejection (TASK-029 #20)`.

---

### Task 21: Build docker image, tag both `latest` and `pre-task-029-base`

```bash
cd /root/DIGIT-MCP
docker build -t digit-mcp:task-029 .
docker tag digit-mcp:task-029 digit-mcp:latest
```

Smoke-run locally on port 13102 (avoid collision with system MCP on 13101):

```bash
docker run --rm --network host -e MCP_TRANSPORT=http -e MCP_PORT=13102 \
  -e CRS_API_URL=http://localhost:18000 -e CRS_USERNAME=ADMIN -e CRS_PASSWORD=eGov@123 \
  -e CRS_TENANT_ID=pg --name digit-mcp-test digit-mcp:task-029 &
sleep 5
curl -s http://localhost:13102/healthz
```

Expected: `{"status":"ok",...}`. Kill the container.

Commit (image is local, no git): create a marker note in `outputs/TASK-029-sources/`:

```bash
docker images digit-mcp --format '{{.Tag}} {{.ID}} {{.CreatedAt}}' > /root/outputs/TASK-029-sources/local-image-tags.txt
```

No git commit needed.

---

### Task 22: Bomet pg_dump pre-snapshot (mandatory rollback floor)

```bash
ssh egov-bomet 'bash -s' <<'EOF'
mkdir -p /root/dumps
TS=$(date -u +%Y%m%dT%H%M%SZ)
docker exec docker-postgres pg_dump -U egov -d egov --no-owner --clean --if-exists \
  | gzip > /root/dumps/egov-pre-task-029-$TS.sql.gz
ls -lh /root/dumps/egov-pre-task-029-$TS.sql.gz
echo "/root/dumps/egov-pre-task-029-$TS.sql.gz" > /root/dumps/latest-pre-task-029.txt
zcat /root/dumps/egov-pre-task-029-$TS.sql.gz | head -50
EOF

scp egov-bomet:/root/dumps/latest-pre-task-029.txt /tmp/
LATEST=$(cat /tmp/latest-pre-task-029.txt)
scp "egov-bomet:$LATEST" /root/outputs/TASK-029-sources/
ls -lh /root/outputs/TASK-029-sources/*.sql.gz
```

Expected: pg_dump produces hundreds of MB. `head -50` shows PostgreSQL SQL preamble + `CREATE SCHEMA`. The file lands in `outputs/TASK-029-sources/`.

If pg_dump fails or the file is suspiciously small (<10 MB), **stop the entire deploy** and investigate. No deploy without a verified backup.

---

### Task 23: Deploy patched MCP to Bomet

```bash
# Save current image as rollback tag
ssh egov-bomet "docker tag digit-mcp:latest digit-mcp:pre-task-029 && docker images digit-mcp"

# Save new image to tarball, scp, load on Bomet
docker save digit-mcp:task-029 | gzip > /tmp/digit-mcp-task-029.tar.gz
scp /tmp/digit-mcp-task-029.tar.gz egov-bomet:/tmp/
ssh egov-bomet "zcat /tmp/digit-mcp-task-029.tar.gz | docker load && docker tag digit-mcp:task-029 digit-mcp:latest"

# Restart the container
ssh egov-bomet "docker restart digit-mcp && sleep 8 && docker logs --tail 30 digit-mcp"

# Verify
ssh egov-bomet "curl -s http://127.0.0.1:13101/healthz"
ssh egov-bomet "curl -sS -X POST http://127.0.0.1:13101/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'" | grep -o 'mdms_d[a-z_]*'
```

Expected: healthz green, tools list contains `mdms_dump`, `mdms_restore`, `mdms_dumps_list`.

If anything fails, run the **Task 25 rollback ladder** immediately.

---

### Task 24: Bomet validation steps 3–10

Run from this dev box, talking to `egov-bomet`'s MCP via SSH tunnel:

```bash
ssh -fN -L 13201:127.0.0.1:13101 egov-bomet   # tunnel
# call the MCP via http://localhost:13201/mcp using the same jsonrpc envelope
```

Steps (each as a small script under `outputs/TASK-029-sources/bomet-validation/`):

3. **Pre-flight snapshot** of `ke.bomet`:
   - `mdms_get_tenants` count
   - `mdms_search` count for: `common-masters.Department`, `RAINMAKER-PGR.ServiceDefs`, `egov-hrms.Designation`
   - `localization_search(locale=en_IN, module=rainmaker-pgr)` count
   - `workflow_business_services(ke.bomet)` count
   - `boundary_hierarchy_search(ke.bomet)` count
   - Save as `bomet-pre-snapshot.json`.

4. **Dump**: `mdms_dump(tenant_id="ke.bomet", include=["self","root"])` → save full response as `bomet-dump-v1.json` (includes filestore_id, version, sha).

5. **List**: `mdms_dumps_list(tenant_id="ke.bomet")` → assert v1 row present.

6. **Dry-run restore** onto same tenant → `bomet-dryrun-v1.json`. Assert all surfaces report `created=0, updated=0, skipped=count_from_dump, failed=0`.

7. **Selective deletion**: pick one row from `RAINMAKER-PGR.ServiceDefs` (the sentinel: a complaint subtype), soft-delete via `mdmsV2Update(isActive=false)`. Re-run dry-run → assert exactly one surface reports `updated=1`.

8. **Real restore** with `on_conflict=overwrite` → assert the previously-deactivated record is active again. Verify via `mdms_search`.

9. **Negative**: `mdms_restore(tenant_id="pg.citya", filestore_id=<v1>)` → assert response contains `cross_root_restore_not_supported`.

10. **Post-flight snapshot** matching step 3 → diff against pre-flight. Only diff allowed: `auditDetails.lastModifiedTime` on the one record from step 7.

Each step writes a numbered file. Final consolidated log: `outputs/TASK-029-sources/bomet-validation-log.md`.

---

### Task 25: Rollback drill (one-time, not normally run)

Verify the rollback paths work BEFORE we need them in anger. Pick path (1) since it's the fastest:

```bash
ssh egov-bomet "docker tag digit-mcp:pre-task-029 digit-mcp:latest && docker restart digit-mcp && sleep 6 && curl -s http://127.0.0.1:13101/healthz"
ssh egov-bomet "curl -sS -X POST http://127.0.0.1:13101/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'" | grep -o 'mdms_dump' || echo 'OK: mdms_dump absent after rollback'
```

Expected: `OK: mdms_dump absent after rollback`. Then re-apply task-029:

```bash
ssh egov-bomet "docker tag digit-mcp:task-029 digit-mcp:latest && docker restart digit-mcp && sleep 6"
```

Confirm `mdms_dump` re-appears.

We do NOT drill path (3) (pg_restore) since it requires DIGIT downtime. Documented but only triggered in actual emergency.

---

### Task 26: Close TASK-029

**Files:**
- Modify: `/root/outputs/TASK-029-mdms-dump-restore.md` — fill Results section.
- Modify: `/root/outputs/outputs.csv` — add row.
- Modify: `/root/TODO.md` — move TASK-029 from Active to Completed.

Update `Status: [x] Completed`, fill Resources Created table with `filestore_id`s, `digit-mcp:task-029` image, Bomet image SHA. Note any deviations from this plan.

Commit on the DIGIT-MCP branch:

```bash
git add docs/plans/2026-05-13-mdms-dump-restore-plan.md
git commit -m "docs: implementation plan for TASK-029"
git push origin feat/mdms-dump-restore
```

Open PR titled: `feat: mdms_dump / mdms_restore / mdms_dumps_list (TASK-029)` with the design doc + plan + Bomet validation log linked from the description.

---

## Total tasks: 26

Estimated time: 4–6 hours focused. Bottleneck is Bomet's MDMS dataset size (~5–15 MB compressed dump), which is fast on the live API. The build + tarball-ship to Bomet is the largest single step (image is ~150–200 MB).

**Plan complete and saved to `docs/plans/2026-05-13-mdms-dump-restore-plan.md`. Two execution options:**

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
