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
import type { ApplyReport } from './src/dump/types.js';

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
  console.log('[1/11] Creating throwaway tenant entry in MDMS...');
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
  console.log('[2/11] Seeding sample MDMS records in throwaway tenant...');
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
  console.log('[3/11] Dumping throwaway tenant (include=self,root)...');
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
  console.log('[4/11] Listing dumps...');
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
  console.log('[5/11] Soft-deleting seeded throwaway records...');
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
  console.log('[6/11] Restoring from latest dump (on_conflict=overwrite)...');
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
  console.log('[7/11] Verifying seeded records re-applied...');
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
  // 8. Capture a sentinel record's lastModifiedTime. Used by step 9
  //    (dry-run must not mutate) and step 10 (idempotent skip).
  // ------------------------------------------------------------------
  console.log('[8/11] Capturing sentinel record state for dry-run comparison...');
  const sentinelCode = seedCodes[0];
  const sentinelBefore = (await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department'))
    .find((r) => String(r.uniqueIdentifier) === sentinelCode);
  assert.ok(sentinelBefore, `sentinel record ${sentinelCode} should exist after restore`);
  const sentinelBeforeLMT = sentinelBefore!.auditDetails?.lastModifiedTime;
  assert.ok(
    typeof sentinelBeforeLMT === 'number' && sentinelBeforeLMT > 0,
    'sentinel must carry an auditDetails.lastModifiedTime',
  );
  console.log(`  sentinel=${sentinelCode} lastModifiedTime=${sentinelBeforeLMT}`);

  // ------------------------------------------------------------------
  // 9. Dry-run restore (overwrite policy + dryRun=true). Counts must be
  //    non-zero (the engine still planned all the writes) but the sentinel
  //    record must not actually have been mutated.
  // ------------------------------------------------------------------
  console.log('[9/11] Restoring from latest dump (dry_run=true)...');
  const dryReport: ApplyReport = await restoreFromFilestore(digitApi as never, {
    tenant_id: throwaway,
    version: 'latest',
    on_conflict: 'overwrite',
    dry_run: true,
  });
  console.log(`  dry-run ok=${dryReport.ok} partial=${dryReport.partial} totals=${JSON.stringify(dryReport.totals)}`);
  for (const sr of dryReport.surfaces) {
    if (sr.created || sr.updated || sr.skipped || sr.failed) {
      console.log(`    surface ${sr.surface}: created=${sr.created} updated=${sr.updated} skipped=${sr.skipped} failed=${sr.failed}`);
    }
  }
  assert.equal(dryReport.ok, true, `dry-run must succeed (error=${dryReport.error ?? '<none>'})`);
  const dryCounted = dryReport.totals.created + dryReport.totals.updated + dryReport.totals.skipped;
  assert.ok(dryCounted > 0, `dry-run must report non-zero planned counts (totals=${JSON.stringify(dryReport.totals)})`);
  assert.equal(dryReport.totals.failed, 0, `dry-run must not record failures (got ${dryReport.totals.failed})`);

  // Re-query sentinel and confirm lastModifiedTime is unchanged.
  // Small wait window in case anything async DID slip out, so we don't get
  // a false negative from a same-millisecond comparison.
  await new Promise((r) => setTimeout(r, 2000));
  const sentinelAfterDry = (await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department'))
    .find((r) => String(r.uniqueIdentifier) === sentinelCode);
  assert.ok(sentinelAfterDry, 'sentinel record must still exist after dry-run');
  const sentinelAfterDryLMT = sentinelAfterDry!.auditDetails?.lastModifiedTime;
  console.log(`  sentinel after dry-run lastModifiedTime=${sentinelAfterDryLMT} (was ${sentinelBeforeLMT})`);
  assert.equal(
    sentinelAfterDryLMT,
    sentinelBeforeLMT,
    `dry-run must not mutate sentinel (before=${sentinelBeforeLMT} after=${sentinelAfterDryLMT})`,
  );

  // ------------------------------------------------------------------
  // 10. Skip restore. Everything from the v1 dump is already present and
  //     active in the tenant, so every record should be skipped, nothing
  //     should be created, and there should be no failures. Re-run once
  //     to confirm idempotency.
  // ------------------------------------------------------------------
  console.log('[10/11] Restoring from latest dump (on_conflict=skip)...');
  const skipReport: ApplyReport = await restoreFromFilestore(digitApi as never, {
    tenant_id: throwaway,
    version: 'latest',
    on_conflict: 'skip',
    dry_run: false,
  });
  console.log(`  skip ok=${skipReport.ok} partial=${skipReport.partial} totals=${JSON.stringify(skipReport.totals)}`);
  for (const sr of skipReport.surfaces) {
    if (sr.created || sr.updated || sr.skipped || sr.failed) {
      console.log(`    surface ${sr.surface}: created=${sr.created} updated=${sr.updated} skipped=${sr.skipped} failed=${sr.failed}`);
    }
  }
  assert.equal(skipReport.ok, true, `skip restore must succeed (error=${skipReport.error ?? '<none>'})`);
  assert.ok(
    skipReport.totals.skipped > 0,
    `skip restore must report at least one skipped record (totals=${JSON.stringify(skipReport.totals)})`,
  );
  // Specifically, our seeded common-masters.Department records should appear
  // in the skipped bucket (not failed) — they're already present and active.
  const mdmsDataSkip = skipReport.surfaces.find((s) => s.surface === 'mdms-data');
  assert.ok(mdmsDataSkip, 'skip report must include mdms-data surface');
  assert.ok(
    mdmsDataSkip!.skipped > 0,
    `mdms-data must report skipped > 0 under skip policy (got ${JSON.stringify(mdmsDataSkip)})`,
  );
  // The seeded records (common-masters.Department) must not be in the failure
  // list — they're well-formed and already present.
  const seededFailures = mdmsDataSkip!.errors.filter((e) =>
    seedCodes.some((c) => String(e.identifier).includes(c)),
  );
  assert.equal(
    seededFailures.length,
    0,
    `seeded records must NOT appear in skip-restore failure list (got ${JSON.stringify(seededFailures)})`,
  );

  // Idempotency: run skip again. We can't strictly equate totals between
  // runs — localization writes always create (no skip), and Kafka persister
  // lag shifts the mdms-data skipped/failed split between runs. What MUST
  // hold for our seeded records (which the dump definitively contains) is:
  //   - never reported as failures
  //   - never reported as updates (skip policy must not touch existing)
  console.log('  re-running skip restore to verify idempotency (for seeded records)...');
  const skipReport2: ApplyReport = await restoreFromFilestore(digitApi as never, {
    tenant_id: throwaway,
    version: 'latest',
    on_conflict: 'skip',
    dry_run: false,
  });
  console.log(`  skip-2 ok=${skipReport2.ok} totals=${JSON.stringify(skipReport2.totals)}`);
  assert.equal(skipReport2.ok, true, `second skip restore must succeed (error=${skipReport2.error ?? '<none>'})`);
  // Updated must always be 0 under skip policy — by definition skip does not
  // touch records that already exist.
  assert.equal(
    skipReport2.totals.updated,
    0,
    `skip policy must never update (run2 updated=${skipReport2.totals.updated})`,
  );
  // For our seeded common-masters.Department records: they must not appear
  // in the failure list on either run.
  const mdmsDataSkip2 = skipReport2.surfaces.find((s) => s.surface === 'mdms-data');
  assert.ok(mdmsDataSkip2, 'skip-2 report must include mdms-data surface');
  const seededFailures2 = mdmsDataSkip2!.errors.filter((e) =>
    seedCodes.some((c) => String(e.identifier).includes(c)),
  );
  assert.equal(
    seededFailures2.length,
    0,
    `seeded records must NOT appear in second skip-restore failure list (got ${JSON.stringify(seededFailures2)})`,
  );

  // The sentinel record should still be unchanged after two skip passes:
  // skip policy must not have rewritten it (and overwrite from step 6
  // already happened, so its lastModifiedTime should be stable from there).
  const sentinelAfterSkip = (await digitApi.mdmsV2SearchRaw(throwaway, 'common-masters.Department'))
    .find((r) => String(r.uniqueIdentifier) === sentinelCode);
  assert.ok(sentinelAfterSkip, 'sentinel must still exist after skip restores');
  console.log(`  sentinel after skip restores lastModifiedTime=${sentinelAfterSkip!.auditDetails?.lastModifiedTime} (was ${sentinelBeforeLMT})`);
  assert.equal(
    sentinelAfterSkip!.auditDetails?.lastModifiedTime,
    sentinelBeforeLMT,
    `skip restore must not mutate sentinel (before=${sentinelBeforeLMT} after=${sentinelAfterSkip!.auditDetails?.lastModifiedTime})`,
  );

  // ------------------------------------------------------------------
  // 11. Cross-root negative — restoring a `pg.*` dump into `ke.nairobi`
  //     must be rejected with cross_root_restore_not_supported. Engine
  //     should not even attempt to apply any surface.
  //
  //     Note: DIGIT filestore rejects downloads when the tenantId in the
  //     query doesn't match the tenant the file was uploaded under (HTTP
  //     400). That gives us a second layer of defense — the cross-root
  //     attempt is blocked at the filestore layer before the engine even
  //     gets to its own guard. We wrap the call and accept EITHER form of
  //     rejection: the engine's cross_root guard returning ok:false, OR
  //     filestore throwing a 400. Both prove cross-root data is
  //     unreachable at the integration level.
  // ------------------------------------------------------------------
  console.log('[11/11] Cross-root restore attempt (target=ke.nairobi)...');
  let crossReport: ApplyReport | null = null;
  let crossThrew: Error | null = null;
  try {
    crossReport = await restoreFromFilestore(digitApi as never, {
      tenant_id: 'ke.nairobi',
      filestore_id: dumpResult.filestore_id,
      on_conflict: 'skip',
      dry_run: false,
    });
  } catch (err) {
    crossThrew = err instanceof Error ? err : new Error(String(err));
  }
  if (crossReport) {
    console.log(`  cross-root ok=${crossReport.ok} error=${crossReport.error}`);
    assert.equal(crossReport.ok, false, 'cross-root restore must be rejected (ok=false)');
    assert.ok(
      typeof crossReport.error === 'string' && /cross_root_restore_not_supported/.test(crossReport.error),
      `cross-root error must match /cross_root_restore_not_supported/ (got ${crossReport.error})`,
    );
    assert.equal(
      crossReport.surfaces.length,
      0,
      `cross-root restore must abort before applying any surface (got ${crossReport.surfaces.length} surface reports)`,
    );
  } else {
    console.log(`  cross-root threw at filestore layer: ${crossThrew!.message}`);
    assert.ok(
      /filestore_download_failed/.test(crossThrew!.message),
      `cross-root must be rejected by filestore (got: ${crossThrew!.message})`,
    );
  }

  console.log('\nOK — 11/11 steps complete (round-trip + conflict matrix + cross-root negative).');
  console.log(`Throwaway tenant ${throwaway} left in MDMS (cleanup out of scope).`);
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
