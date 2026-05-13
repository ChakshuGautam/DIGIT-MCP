import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createDumpZip, readDumpZip } from './src/dump/zip.js';
import type { Manifest } from './src/dump/types.js';
import { ensureRegistrySchema, nextVersion, writeRegistryRow, listRegistryRows, REGISTRY_SCHEMA_CODE } from './src/dump/registry.js';

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

  // negative: tampering with an entry body must fail verification
  const tamperZip = await JSZip.loadAsync(buf);
  tamperZip.file('mdms-schemas.jsonl', '{"tampered":true}');
  const corrupted = await tamperZip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(readDumpZip(corrupted), /manifest_checksum_mismatch/, 'tampered zip must fail integrity check');

  // negative: zip without manifest.json must fail
  const noManifest = new JSZip();
  noManifest.file('mdms-data.jsonl', '{}');
  const noManifestBuf = await noManifest.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(readDumpZip(noManifestBuf), /missing manifest/i, 'zip without manifest must fail');
}

await testZipRoundTrip();
console.log('✓ zip round-trip');

async function testRegistry() {
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
  } as never;

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

import { localizationSurface } from './src/dump/surfaces/localization.js';

async function testLocalizationSurface() {
  const stateInfo = [{ data: { languages: [{ value: 'en_IN' }, { value: 'sw_KE' }] } }];
  const messagesByLocale: Record<string, Record<string, unknown>[]> = {
    en_IN: [
      { code: 'HOME', message: 'Home', module: 'rainmaker-common' },
      { code: 'COMPLAINT', message: 'Complaint', module: 'rainmaker-pgr' },
      { code: 'SETTINGS', message: 'Settings', module: 'rainmaker-common' },
    ],
    sw_KE: [
      { code: 'HOME', message: 'Nyumbani', module: 'rainmaker-common' },
      { code: 'COMPLAINT', message: 'Lalamiko', module: 'rainmaker-pgr' },
      { code: 'SETTINGS', message: 'Mipangilio', module: 'rainmaker-common' },
    ],
  };
  const upserts: unknown[] = [];

  const client = {
    async mdmsV2SearchRaw(_t: string, schemaCode: string) {
      return schemaCode === 'common-masters.StateInfo' ? stateInfo : [];
    },
    async localizationSearch(_t: string, locale: string, _module?: string) {
      return messagesByLocale[locale] || [];
    },
    async localizationUpsert(_t: string, locale: string, messages: { code: string; message: string; module: string }[]) {
      upserts.push({ locale, messages });
      return messages;
    },
  } as never;

  // Dump: 6 messages (2 locales × 3 messages each)
  const lines: string[] = [];
  for await (const line of localizationSurface.dump(client, 'pwt.test', { tenantIds: ['pwt.test'], include: ['self'] })) {
    lines.push(line);
  }
  assert.equal(lines.length, 6, `expected 6 message lines, got ${lines.length}`);

  // Restore against an empty target — all created
  async function* iter() { yield* lines; }
  const emptyClient = {
    async localizationSearch() { return []; },     // nothing present at target
    async localizationUpsert(_t: string, locale: string, messages: { code: string; message: string; module: string }[]) {
      upserts.push({ locale, messages });
      return messages;
    },
  } as never;
  const report = await localizationSurface.restore(emptyClient, iter(), 'pwt.test', { onConflict: 'skip', dryRun: false });
  assert.equal(report.created, 6);
  assert.equal(report.skipped, 0);
}

await testLocalizationSurface();
console.log('✓ surface: localization');

import { workflowSurface } from './src/dump/surfaces/workflow.js';

async function testWorkflowSurface() {
  const sourceServices = [
    { businessService: 'PGR', tenantId: 'pwt.test', states: [{ state: 'NEW' }], actions: ['APPLY'] },
    { businessService: 'TL', tenantId: 'pwt.test', states: [{ state: 'INIT' }], actions: ['SUBMIT'] },
  ];
  const targetServices = [
    { businessService: 'PGR', tenantId: 'pwt.test' },  // exists at target
  ];
  const createCalls: unknown[] = [];
  const updateCalls: unknown[] = [];

  const client = {
    async workflowBusinessServiceSearch() { return sourceServices; },
  } as never;

  // Dump emits 2 JSONL lines
  const lines: string[] = [];
  for await (const line of workflowSurface.dump(client, 'pwt.test', { tenantIds: ['pwt.test'], include: ['self'] })) {
    lines.push(line);
  }
  assert.equal(lines.length, 2);

  // Restore under skip — TL created, PGR skipped
  async function* iter() { yield* lines; }
  const restoreClient = {
    async workflowBusinessServiceSearch() { return targetServices; },
    async workflowBusinessServiceCreate(t: string, svc: { businessService: string }) {
      createCalls.push({ tenant: t, code: svc.businessService });
      return svc;
    },
    async workflowBusinessServiceUpdate(t: string, svc: { businessService: string }) {
      updateCalls.push({ tenant: t, code: svc.businessService });
      return svc;
    },
  } as never;
  const report = await workflowSurface.restore(restoreClient, iter(), 'pwt.test', { onConflict: 'skip', dryRun: false });
  assert.equal(report.created, 1);
  assert.equal(report.skipped, 1);
  assert.equal(createCalls.length, 1);
  assert.equal(updateCalls.length, 0);

  // Restore under overwrite — TL created, PGR updated
  async function* iter2() { yield* lines; }
  const report2 = await workflowSurface.restore(restoreClient, iter2(), 'pwt.test', { onConflict: 'overwrite', dryRun: false });
  assert.equal(report2.created, 1);
  assert.equal(report2.updated, 1);
  assert.equal(updateCalls.length, 1);
}

await testWorkflowSurface();
console.log('✓ surface: workflow');

import { boundarySurface } from './src/dump/surfaces/boundary.js';

async function testBoundarySurface() {
  const sourceHierarchies = [{ hierarchyType: 'ADMIN', boundaryHierarchy: [{ boundaryType: 'State', parentBoundaryType: null }, { boundaryType: 'City', parentBoundaryType: 'State' }] }];
  const sourceEntities = [
    { code: 'pwt.test', tenantId: 'pwt.test', hierarchyType: 'ADMIN', boundaryType: 'State' },
    { code: 'pwt.test.city1', tenantId: 'pwt.test', hierarchyType: 'ADMIN', boundaryType: 'City' },
  ];
  const sourceRelTree = [{ code: 'pwt.test', parent: null, children: [{ code: 'pwt.test.city1', parent: 'pwt.test' }] }];

  const client = {
    async boundaryHierarchySearch() { return sourceHierarchies; },
    async boundarySearch() { return sourceEntities; },
    async boundaryRelationshipTreeSearch() { return sourceRelTree; },
  } as never;

  // Dump emits 1 JSON line (single document)
  const lines: string[] = [];
  for await (const line of boundarySurface.dump(client, 'pwt.test', { tenantIds: ['pwt.test'], include: ['self'] })) {
    lines.push(line);
  }
  assert.equal(lines.length, 1);
  const doc = JSON.parse(lines[0]) as { hierarchies: unknown[]; entities: unknown[]; relationships: unknown[] };
  assert.equal(doc.hierarchies.length, 1);
  assert.equal(doc.entities.length, 2);
  assert.ok(doc.relationships.length >= 1);

  // Restore onto empty target — 1 hierarchy + 2 entities + relationships created
  const hierarchyCreates: unknown[] = [];
  const entityCreates: unknown[] = [];
  const relCreates: unknown[] = [];

  async function* iter() { yield* lines; }
  const restoreClient = {
    async boundaryHierarchySearch() { return []; },
    async boundarySearch() { return []; },
    async boundaryRelationshipTreeSearch() { return []; },
    async boundaryHierarchyCreate(_t: string, ht: string, _bh: unknown[]) { hierarchyCreates.push(ht); return { hierarchyType: ht }; },
    async boundaryCreate(_t: string, bs: unknown[]) { entityCreates.push(...bs); return bs; },
    async boundaryRelationshipCreate(_t: string, code: string) { relCreates.push(code); return { code }; },
  } as never;

  const report = await boundarySurface.restore(restoreClient, iter(), 'pwt.test', { onConflict: 'skip', dryRun: false });
  assert.ok(report.created >= 3, `expected >= 3 creates, got ${report.created}`);
  assert.equal(hierarchyCreates.length, 1);
  assert.equal(entityCreates.length, 2);
  assert.ok(relCreates.length >= 1);
}

await testBoundarySurface();
console.log('✓ surface: boundary');

import { accessControlSurface } from './src/dump/surfaces/accessControl.js';

async function testAccessControlSurface() {
  const sourceRoles = [
    { code: 'GRO',  name: 'Complaint Assessor', tenantId: 'pwt.test' },
    { code: 'PGR_LME', name: 'Complaint Resolver', tenantId: 'pwt.test' },
    { code: 'CITIZEN', name: 'Citizen', tenantId: 'pwt.test' },
  ];
  const targetExisting = [
    { uniqueIdentifier: 'CITIZEN', data: { code: 'CITIZEN' } },  // exists at target
  ];
  const createCalls: unknown[] = [];

  const client = {
    async accessRolesSearch() { return sourceRoles; },
  } as never;

  const lines: string[] = [];
  for await (const line of accessControlSurface.dump(client, 'pwt.test', { tenantIds: ['pwt.test'], include: ['self'] })) {
    lines.push(line);
  }
  assert.equal(lines.length, 3, 'expected 3 role lines');

  async function* iter() { yield* lines; }
  const restoreClient = {
    async mdmsV2SearchRaw() { return targetExisting; },
    async mdmsV2Create(t: string, schema: string, uid: string, data: unknown) {
      createCalls.push({ t, schema, uid, data });
      return { id: 'x' };
    },
  } as never;

  const report = await accessControlSurface.restore(restoreClient, iter(), 'pwt.test', { onConflict: 'skip', dryRun: false });
  // CITIZEN exists at target → skipped. GRO + PGR_LME created.
  assert.equal(report.created, 2);
  assert.equal(report.skipped, 1);
  assert.equal(createCalls.length, 2);
  // Verify mdms_create was hit against the role schema
  for (const c of createCalls) {
    assert.equal((c as { schema: string }).schema, 'ACCESSCONTROL-ROLES.roles');
  }
}

await testAccessControlSurface();
console.log('✓ surface: access-control');

import { dumpTenant } from './src/dump/engine.js';
import type { SurfaceName } from './src/dump/types.js';

async function testEngineDumpTenant() {
  // Mock client with minimum surface to satisfy all six surface dumpers + registry.
  // Each surface returns an empty result so we exercise orchestration, not data movement.
  const filestoreUploads: unknown[] = [];
  const registryWrites: unknown[] = [];

  const client = {
    // Registry needs schema search + create
    async mdmsSchemaSearch(_t: string, codes?: string[]) {
      if (codes?.includes('mcp-dumps.DumpRegistry')) return [];   // first dump: registry schema doesn't exist
      return [];                                                  // surfaces: empty schemas to dump
    },
    async mdmsSchemaCreate(_t: string, code: string) { return { code }; },
    async mdmsV2Create(_t: string, schemaCode: string, uid: string, data: unknown) {
      if (schemaCode === 'mcp-dumps.DumpRegistry') registryWrites.push({ uid, data });
      return { id: 'x' };
    },
    async mdmsV2SearchRaw(_t: string, schemaCode: string) {
      if (schemaCode === 'mcp-dumps.DumpRegistry') return registryWrites.map((w) => ({ data: (w as { data: unknown }).data }));
      return [];
    },

    // Surfaces — all return empty
    async localizationSearch() { return []; },
    async workflowBusinessServiceSearch() { return []; },
    async boundaryHierarchySearch() { return []; },
    async boundarySearch() { return []; },
    async boundaryRelationshipTreeSearch() { return []; },
    async accessRolesSearch() { return []; },

    // Filestore
    async filestoreUpload(tenantId: string, module: string, buf: Buffer, fileName: string, contentType: string) {
      filestoreUploads.push({ tenantId, module, size: buf.length, fileName, contentType });
      return [{ fileStoreId: `fs-${filestoreUploads.length}`, tenantId }];
    },

    // Auth/env info
    getAuthInfo() { return { user: { userName: 'ADMIN' }, authenticated: true, stateTenantId: 'pwt', token: 'tok' }; },
    getEnvironmentInfo() { return { name: 'unit-test', url: 'http://test', stateTenantId: 'pwt' }; },
  } as never;

  const result = await dumpTenant(client, {
    tenant_id: 'pwt.test',
    include: ['self', 'root'],
  });

  assert.equal(result.version, 'v1');
  assert.ok(result.filestore_id.startsWith('fs-'));
  assert.equal(result.sha256.length, 64);
  assert.ok(result.size_bytes > 0);
  assert.equal(filestoreUploads.length, 1);
  assert.equal(registryWrites.length, 1);

  // Second dump should produce v2
  const result2 = await dumpTenant(client, { tenant_id: 'pwt.test', include: ['self'] });
  assert.equal(result2.version, 'v2');
}

await testEngineDumpTenant();
console.log('✓ engine: dumpTenant');

import { restoreFromFilestore } from './src/dump/engine.js';

async function testEngineRestore() {
  // First create a small dump via dumpTenant, then restore it onto a fresh target.
  // We reuse the test client pattern. To stay simple, the source has nothing
  // (empty surfaces), so restore is a no-op apply that exercises the orchestration.

  const filestoreStore = new Map<string, Buffer>();
  const registryRows: Record<string, unknown>[] = [];

  function buildClient() {
    return {
      async mdmsSchemaSearch(_t: string, codes?: string[]) {
        if (codes?.includes('mcp-dumps.DumpRegistry')) {
          return registryRows.length > 0 ? [{ code: 'mcp-dumps.DumpRegistry' }] : [];
        }
        return [];
      },
      async mdmsSchemaCreate(_t: string, code: string) { return { code }; },
      async mdmsV2Create(_t: string, schemaCode: string, _uid: string, data: unknown) {
        if (schemaCode === 'mcp-dumps.DumpRegistry') registryRows.push(data as Record<string, unknown>);
        return { id: 'x' };
      },
      async mdmsV2SearchRaw(_t: string, schemaCode: string) {
        if (schemaCode === 'mcp-dumps.DumpRegistry') return registryRows.map((d) => ({ data: d }));
        return [];
      },
      async localizationSearch() { return []; },
      async localizationUpsert() { return []; },
      async workflowBusinessServiceSearch() { return []; },
      async workflowBusinessServiceCreate() { return {}; },
      async workflowBusinessServiceUpdate() { return {}; },
      async boundaryHierarchySearch() { return []; },
      async boundarySearch() { return []; },
      async boundaryRelationshipTreeSearch() { return []; },
      async boundaryHierarchyCreate() { return {}; },
      async boundaryCreate() { return []; },
      async boundaryRelationshipCreate() { return {}; },
      async accessRolesSearch() { return []; },
      async filestoreUpload(_t: string, _m: string, buf: Buffer, _fn: string, _ct: string) {
        const id = `fs-${filestoreStore.size + 1}`;
        filestoreStore.set(id, buf);
        return [{ fileStoreId: id, tenantId: _t }];
      },
      async filestoreGetUrl(_t: string, fileStoreIds: string[]) {
        return fileStoreIds.map((id) => ({ id, url: `inmem://${id}` }));
      },
      async filestoreDownload(_t: string, id: string) {
        const buf = filestoreStore.get(id);
        if (!buf) throw new Error(`not_found: ${id}`);
        return buf;
      },
      getAuthInfo() { return { user: { userName: 'ADMIN' }, authenticated: true, stateTenantId: 'pwt', token: 'tok' }; },
      getEnvironmentInfo() { return { name: 'unit-test', url: 'http://test', stateTenantId: 'pwt' }; },
    } as never;
  }

  const client = buildClient();

  // Take a dump
  const { dumpTenant } = await import('./src/dump/engine.js');
  const dumpResult = await dumpTenant(client, { tenant_id: 'pwt.test', include: ['self'] });

  // Restore by filestore_id directly (skips registry resolution)
  const report = await restoreFromFilestore(client, {
    tenant_id: 'pwt.test',
    filestore_id: dumpResult.filestore_id,
    on_conflict: 'skip',
    dry_run: false,
  });
  assert.equal(report.ok, true);
  assert.equal(report.partial, false);
  assert.equal(report.surfaces.length, 6, `expected 6 surface reports, got ${report.surfaces.length}`);

  // Negative: cross-root restore should fail with the right error token
  const report2 = await restoreFromFilestore(client, {
    tenant_id: 'ke.nairobi',                                     // target root differs
    filestore_id: dumpResult.filestore_id,                       // source root was 'pwt'
    on_conflict: 'skip',
    dry_run: false,
  });
  assert.equal(report2.ok, false);
  assert.match(report2.error || '', /cross_root_restore_not_supported/);

  // Dry-run by version "latest"
  const report3 = await restoreFromFilestore(client, {
    tenant_id: 'pwt.test',
    version: 'latest',
    on_conflict: 'skip',
    dry_run: true,
  });
  assert.equal(report3.ok, true);
  // dry_run report should still have 6 surface entries
  assert.equal(report3.surfaces.length, 6);
}

await testEngineRestore();
console.log('✓ engine: restoreFromFilestore');
