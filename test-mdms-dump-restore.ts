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
