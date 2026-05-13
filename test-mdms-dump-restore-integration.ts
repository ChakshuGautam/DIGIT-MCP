/**
 * Integration round-trip test against a real local DIGIT.
 *
 * Drives the dump/restore engine directly (no MCP layer) against the Docker
 * Compose stack at /root/code/tilt-demo/. Kong gateway must be live at
 * http://localhost:18000.
 *
 * Required env (defaults shown):
 *   CRS_API_URL   http://localhost:18000
 *   CRS_USERNAME  ADMIN
 *   CRS_PASSWORD  eGov@123
 *   CRS_TENANT_ID pg
 *
 * Run: npm run test:dumps:integration
 *
 * The test creates a throwaway tenant `pwt.dump-rt-<unix-ms>` per run, seeds
 * two MDMS records, dumps, soft-deletes them, restores, and asserts the
 * records come back active. The throwaway tenant is left in MDMS (documented
 * — cleanup is out of scope for this test).
 */

import assert from 'node:assert/strict';
import { digitApi } from './src/services/digit-api.js';
import { dumpTenant, restoreFromFilestore, listDumps } from './src/dump/engine.js';

const username = process.env.CRS_USERNAME || 'ADMIN';
const password = process.env.CRS_PASSWORD || 'eGov@123';
const rootTenant = process.env.CRS_TENANT_ID || 'pg';
const apiUrl = process.env.CRS_API_URL || 'http://localhost:18000';

/**
 * Poll the provided async predicate until it returns a non-null value or the
 * timeout is hit. MDMS creates/updates are async (Kafka → persister), so we
 * need a small wait loop between mutating and asserting.
 */
async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastResult: T | null = null;
  while (Date.now() < deadline) {
    lastResult = await fn();
    if (lastResult !== null) return lastResult;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`pollUntil_timeout: ${opts.label} (after ${opts.timeoutMs}ms)`);
}

async function main(): Promise<void> {
  console.log(`Auth: ${username} → ${rootTenant} @ ${apiUrl}`);
  digitApi.setAdHocEnvironment(apiUrl);
  await digitApi.login(username, password, rootTenant);
  console.log(`  authenticated as ${digitApi.getAuthInfo().user?.userName} (state=${digitApi.getEnvironmentInfo().stateTenantId})`);

  const throwaway = `${rootTenant}.dumprt${Date.now()}`;
  console.log(`\n=== Round-trip on ${throwaway} ===`);

  // ------------------------------------------------------------------
  // 1. Bootstrap the throwaway tenant. We bypass the full tenant_bootstrap
  //    tool — just create a minimal `tenant.tenants` MDMS record. This is
  //    sufficient for MDMS-level dump/restore. Persister/Kafka writes are
  //    async; if this returns a phantom 200 with no body, we continue.
  // ------------------------------------------------------------------
  console.log('[1/8] Creating throwaway tenant entry in MDMS...');
  try {
    await digitApi.mdmsV2Create(rootTenant, 'tenant.tenants', throwaway, {
      code: throwaway,
      name: `Dump Roundtrip ${throwaway}`,
      description: 'Throwaway tenant for dump/restore integration test',
      city: { code: throwaway, name: throwaway, ulbGrade: 'City' },
    });
    console.log(`  tenant ${throwaway} created in MDMS`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  (tenant create returned non-fatal error — continuing): ${msg}`);
  }

  // ------------------------------------------------------------------
  // 2. Seed sample records under the throwaway. Use common-masters.Department
  //    because its schema is inherited from root pg. The schema's `code` field
  //    is the x-unique key, so MDMS stores `uniqueIdentifier` = uppercase code
  //    regardless of what we pass in.
  // ------------------------------------------------------------------
  console.log('[2/8] Seeding sample MDMS records in throwaway tenant...');
  const ts = Date.now();
  // MDMS persister is async — give Kafka a moment per create so the search
  // is consistent. We use code values that include the ts for uniqueness.
  const seedCodes = [`DUMP-RT-DEPT-1-${ts}`, `DUMP-RT-DEPT-2-${ts}`];
  for (const code of seedCodes) {
    await digitApi.mdmsV2Create(throwaway, 'common-masters.Department', code.toLowerCase(), {
      code,
      name: `Dump RT ${code}`,
      active: true,
    });
  }
  // Wait for persister to commit (Kafka lag is typically <1s on the dev stack).
  await pollUntil(
    async () => {
      const recs = await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department');
      const ours = recs.filter((r) => seedCodes.includes(String(r.uniqueIdentifier)));
      return ours.length === seedCodes.length ? ours : null;
    },
    { timeoutMs: 30000, intervalMs: 500, label: 'seeded dept records to persist' },
  );
  const seededDepts = (await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department'))
    .filter((r) => seedCodes.includes(String(r.uniqueIdentifier)));
  const preActiveCount = seededDepts.filter((r) => r.isActive !== false).length;
  console.log(`  seeded ${seedCodes.length} dept records; pre-count active (in throwaway scope): ${preActiveCount}`);
  assert.equal(preActiveCount, seedCodes.length, `expected ${seedCodes.length} seeded active dept records`);

  // ------------------------------------------------------------------
  // 3. Dump
  // ------------------------------------------------------------------
  console.log('[3/8] Dumping throwaway tenant (include=self,root)...');
  const dumpResult = await dumpTenant(digitApi as never, {
    tenant_id: throwaway,
    include: ['self', 'root'],
  });
  assert.ok(dumpResult.filestore_id, 'filestore_id should be non-empty');
  assert.equal(dumpResult.sha256.length, 64, 'sha256 should be 64 hex chars');
  assert.ok(dumpResult.size_bytes > 0, 'zip should be non-empty');
  for (const s of Object.keys(dumpResult.counts)) {
    assert.ok(
      (dumpResult.counts as Record<string, number>)[s] >= 0,
      `surface ${s} count should be >= 0`,
    );
  }
  console.log(`  dump ${dumpResult.version} filestore_id=${dumpResult.filestore_id} size=${dumpResult.size_bytes} sha=${dumpResult.sha256.slice(0, 16)}...`);
  console.log(`  counts: ${JSON.stringify(dumpResult.counts)}`);

  // ------------------------------------------------------------------
  // 4. List dumps and confirm ours is there
  // ------------------------------------------------------------------
  console.log('[4/8] Listing dumps...');
  const dumps = await listDumps(digitApi as never, throwaway);
  const myDump = dumps.find((d) => d.version === dumpResult.version);
  assert.ok(myDump, `dump ${dumpResult.version} should appear in list`);
  assert.equal(myDump!.filestore_id, dumpResult.filestore_id, 'filestore_id should match');
  assert.equal(myDump!.sha256, dumpResult.sha256, 'sha256 should match');
  console.log(`  found ${dumps.length} dump(s) for ${throwaway}; latest=${dumps[0]?.version}`);

  // ------------------------------------------------------------------
  // 5. Soft-delete seeded records (cleanup phase). We deliberately only
  //    touch the records we created so we don't disturb anything else
  //    the throwaway tenant inherited from root.
  // ------------------------------------------------------------------
  console.log('[5/8] Soft-deleting seeded throwaway records...');
  const toDelete = (await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department'))
    .filter((r) => seedCodes.includes(String(r.uniqueIdentifier)));
  for (const rec of toDelete) {
    await digitApi.mdmsV2Update(rec, false);
  }
  // Wait for the soft-delete to land in the search.
  await pollUntil(
    async () => {
      const recs = await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department');
      const ours = recs.filter((r) => seedCodes.includes(String(r.uniqueIdentifier)));
      const active = ours.filter((r) => r.isActive !== false);
      return active.length === 0 && ours.length > 0 ? ours : null;
    },
    { timeoutMs: 30000, intervalMs: 500, label: 'soft-delete to persist' },
  );
  const postCleanup = (await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department'))
    .filter((r) => seedCodes.includes(String(r.uniqueIdentifier)));
  const postCleanupActive = postCleanup.filter((r) => r.isActive !== false).length;
  console.log(`  post-cleanup active (in seeded scope): ${postCleanupActive} (expected 0)`);
  assert.equal(postCleanupActive, 0, 'seeded records must be inactive after cleanup');

  // ------------------------------------------------------------------
  // 6. Restore from latest dump with overwrite
  // ------------------------------------------------------------------
  console.log('[6/8] Restoring from latest dump (on_conflict=overwrite)...');
  const report = await restoreFromFilestore(digitApi as never, {
    tenant_id: throwaway,
    version: 'latest',
    on_conflict: 'overwrite',
    dry_run: false,
  });
  console.log(`  restore ok=${report.ok} partial=${report.partial} totals=${JSON.stringify(report.totals)}`);
  for (const surfaceReport of report.surfaces) {
    console.log(`    surface ${surfaceReport.surface}: created=${surfaceReport.created} updated=${surfaceReport.updated} skipped=${surfaceReport.skipped} failed=${surfaceReport.failed}`);
    if (surfaceReport.errors.length > 0) {
      for (const e of surfaceReport.errors.slice(0, 3)) {
        console.log(`      err: ${JSON.stringify(e).slice(0, 200)}`);
      }
    }
  }
  assert.equal(report.ok, true, `restore must succeed (error=${report.error ?? '<none>'})`);

  // ------------------------------------------------------------------
  // 7. Verify the seeded records came back active
  // ------------------------------------------------------------------
  console.log('[7/8] Verifying seeded records re-applied...');
  // Wait for the restore-side updates to make their way through Kafka.
  await pollUntil(
    async () => {
      const recs = await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department');
      const ours = recs.filter((r) => seedCodes.includes(String(r.uniqueIdentifier)));
      const active = ours.filter((r) => r.isActive !== false);
      return active.length >= preActiveCount ? ours : null;
    },
    { timeoutMs: 60000, intervalMs: 500, label: 'restore to persist' },
  );
  const postRestore = (await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department'))
    .filter((r) => seedCodes.includes(String(r.uniqueIdentifier)));
  const postRestoreActive = postRestore.filter((r) => r.isActive !== false).length;
  console.log(`  post-restore active (in seeded scope): ${postRestoreActive} (expected ${preActiveCount})`);
  assert.ok(
    postRestoreActive >= preActiveCount,
    `expected at least ${preActiveCount} active seeded dept records post-restore, got ${postRestoreActive}`,
  );

  // ------------------------------------------------------------------
  // 8. Done
  // ------------------------------------------------------------------
  console.log('[8/8] OK — round-trip complete.');
  console.log(`\nThrowaway tenant ${throwaway} left in MDMS (cleanup out of scope).`);
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
