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
