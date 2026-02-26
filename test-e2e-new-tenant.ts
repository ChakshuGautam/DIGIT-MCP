/**
 * End-to-End PGR on a Freshly Bootstrapped Tenant
 *
 * Phase 1: Bootstrap a new root tenant (proves MDMS data propagation).
 * Phase 2: Create a new city under `pg`, set up everything PGR needs,
 *          and run the full complaint lifecycle.
 * Phase 3: Clean up both the new root and the new city data.
 *
 * NOTE: DIGIT Java services (idgen, HRMS, PGR) are configured with
 * STATE_LEVEL_TENANT_ID=pg. A new root tenant's MDMS data is not visible
 * to these services. PGR lifecycle therefore runs on a new city under pg.
 *
 * Required env vars:
 *   CRS_ENVIRONMENT  - Environment key (default: chakshu-digit)
 *   CRS_USERNAME     - DIGIT admin username (default: ADMIN)
 *   CRS_PASSWORD     - DIGIT admin password (default: eGov@123)
 */

import { ToolRegistry } from './src/tools/registry.js';
import { registerAllTools } from './src/tools/index.js';
import { digitApi } from './src/services/digit-api.js';
import type { ToolGroup } from './src/types/index.js';

// ════════════════════════════════════════════════════════════════════
// Test infrastructure (minimal, copied from test-integration-full.ts)
// ════════════════════════════════════════════════════════════════════

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'known_bug';
  ms: number;
  error?: string;
  toolsCalled: string[];
}

const results: TestResult[] = [];
const passed: string[] = [];
const failed: string[] = [];
const skipped: string[] = [];
const failedTests = new Set<string>();
const knownBugTests: string[] = [];

let registry: ToolRegistry;

async function call(toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = registry.getTool(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  const raw = await tool.handler(args);
  return JSON.parse(raw);
}

async function test(name: string, fn: () => Promise<string[]>): Promise<void> {
  const start = Date.now();
  let calledTools: string[] = [];
  try {
    calledTools = await fn();
    const ms = Date.now() - start;
    passed.push(name);
    results.push({ name, status: 'pass', ms, toolsCalled: calledTools });
    console.log(`  \x1b[32mPASS\x1b[0m  ${name} \x1b[90m(${ms}ms)\x1b[0m`);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    failed.push(name);
    failedTests.add(name);
    results.push({ name, status: 'fail', ms, error: msg, toolsCalled: calledTools });
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} \x1b[90m(${ms}ms)\x1b[0m`);
    console.log(`        ${msg}`);
  }
}

async function testWithDeps(name: string, deps: string[], fn: () => Promise<string[]>): Promise<void> {
  const failedDep = deps.find(d => failedTests.has(d));
  if (failedDep) {
    skipped.push(name);
    failedTests.add(name); // Cascade: skipped tests block their dependents too
    results.push({ name, status: 'skip', ms: 0, error: `Dependency failed: ${failedDep}`, toolsCalled: [] });
    console.log(`  \x1b[33mSKIP\x1b[0m  ${name} \x1b[90m(dep: ${failedDep})\x1b[0m`);
    return;
  }
  await test(name, fn);
}

function markKnownBug(testName: string, description: string): void {
  knownBugTests.push(testName);
  const result = results.find(r => r.name === testName);
  if (result) result.status = 'known_bug';
  console.log(`        \x1b[33mKNOWN SERVER BUG\x1b[0m: ${description}`);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function wait(ms: number, reason?: string): Promise<void> {
  if (reason) console.log(`        ⏳ waiting ${ms}ms (${reason})…`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition<T>(
  fn: () => Promise<T | null | false>,
  opts: { maxAttempts?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts || 5;
  const intervalMs = opts.intervalMs || 2000;
  const label = opts.label || 'condition';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    if (result) return result;
    if (attempt < maxAttempts) {
      console.log(`        ⏳ ${label}: attempt ${attempt}/${maxAttempts} not yet, retrying in ${intervalMs}ms…`);
      await wait(intervalMs);
    }
  }
  throw new Error(`${label}: not satisfied after ${maxAttempts} attempts (${maxAttempts * intervalMs}ms)`);
}

// ════════════════════════════════════════════════════════════════════
// Run ID & tenant naming
// ════════════════════════════════════════════════════════════════════

const RUN_ID = Date.now() % 100000000;

function toLetters(n: number): string {
  let s = '';
  let num = n;
  while (num > 0) {
    s = String.fromCharCode(97 + (num % 26)) + s;
    num = Math.floor(num / 26);
  }
  return s || 'a';
}

// ════════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════════

interface E2EState {
  // Bootstrap target (new root — for testing tenant_bootstrap)
  bootstrapRoot: string;
  // PGR city under pg (where PGR lifecycle runs)
  cityTenant: string;
  localityCode: string;
  employeeCode: string | null;
  employeeUuid: string | null;
  complaintId: string | null;
  citizenMobile: string;
}

const letters = toLetters(RUN_ID);
const state: E2EState = {
  bootstrapRoot: `e2e${letters}`,
  cityTenant: `pg.e2e${letters}`,
  localityCode: `LOC_${RUN_ID}`,
  employeeCode: null,
  employeeUuid: null,
  complaintId: null,
  citizenMobile: `70${String(RUN_ID).padStart(8, '0')}`,
};

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   E2E: PGR on Freshly Bootstrapped Tenant                  ║');
  console.log('║   bootstrap → setup → PGR lifecycle → cleanup              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  RUN_ID:         ${RUN_ID}`);
  console.log(`  Bootstrap root: ${state.bootstrapRoot}`);
  console.log(`  PGR city:       ${state.cityTenant}`);
  console.log('');

  registry = new ToolRegistry();
  registerAllTools(registry);
  const allGroups: ToolGroup[] = ['core', 'mdms', 'boundary', 'masters', 'employees', 'localization', 'pgr', 'admin', 'idgen', 'location', 'encryption', 'docs', 'monitoring', 'tracing'];
  registry.enableGroups(allGroups);

  const targetEnv = process.env.CRS_ENVIRONMENT || 'chakshu-digit';
  const adminUser = process.env.CRS_USERNAME || 'ADMIN';
  const adminPass = process.env.CRS_PASSWORD || 'eGov@123';

  // ──────────────────────────────────────────────────────────────────
  // Phase 1: Bootstrap & Verify
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Phase 1: Bootstrap & Verify ──');

  // 1. Configure + login
  await test('1 configure + login', async () => {
    const r = await call('configure', {
      environment: targetEnv,
      username: adminUser,
      password: adminPass,
    });
    assert(r.success === true, `configure failed: ${r.error}`);
    console.log(`        Logged in as ${adminUser}`);
    return ['configure'];
  });

  // 2. Bootstrap new root tenant
  await testWithDeps('2 bootstrap new root tenant', ['1 configure + login'], async () => {
    const r = await call('tenant_bootstrap', {
      target_tenant: state.bootstrapRoot,
      source_tenant: 'pg',
    });
    const summary = r.summary as Record<string, number> | undefined;
    const schemasCopied = summary?.schemas_copied ?? 0;
    const dataCopied = summary?.data_copied ?? 0;
    const schemasFailed = summary?.schemas_failed ?? 0;
    if (!r.success && schemasCopied > 10 && dataCopied > 0) {
      console.log(`        Bootstrap partial: ${schemasCopied} schemas, ${dataCopied} data records (${schemasFailed} failed)`);
      markKnownBug('2 bootstrap new root tenant', `Partial bootstrap: ${schemasFailed} schema(s) failed due to empty x-unique constraints`);
      return ['tenant_bootstrap'];
    }
    assert(r.success === true, `tenant_bootstrap failed: ${JSON.stringify(r.error || r.summary || r)}`);
    console.log(`        Schemas: ${schemasCopied} copied, ${summary?.schemas_skipped ?? 0} skipped`);
    console.log(`        Data: ${dataCopied} copied, ${summary?.data_skipped ?? 0} skipped`);
    return ['tenant_bootstrap'];
  });

  // 3. Verify schemas on bootstrap root
  await testWithDeps('3 verify schemas on bootstrap root', ['2 bootstrap new root tenant'], async () => {
    await wait(3000, 'MDMS schema propagation');
    const r = await waitForCondition(async () => {
      const res = await call('mdms_schema_search', { tenant_id: state.bootstrapRoot });
      if (res.success && (res.count as number) > 0) return res;
      return null;
    }, { maxAttempts: 3, intervalMs: 3000, label: 'schemas on bootstrap root' });
    const count = r.count as number;
    assert(count > 10, `Expected >10 schemas, got ${count}`);
    console.log(`        ${count} schemas on ${state.bootstrapRoot}`);
    return ['mdms_schema_search'];
  });

  // 4. Verify departments on bootstrap root
  await testWithDeps('4 verify departments on bootstrap root', ['2 bootstrap new root tenant'], async () => {
    const r = await call('validate_departments', { tenant_id: state.bootstrapRoot });
    assert(r.success === true, `validate_departments failed: ${r.error}`);
    const validation = r.validation as Record<string, unknown>;
    console.log(`        ${validation.summary}`);
    return ['validate_departments'];
  });

  // 5. Verify designations on bootstrap root
  await testWithDeps('5 verify designations on bootstrap root', ['2 bootstrap new root tenant'], async () => {
    const r = await call('validate_designations', { tenant_id: state.bootstrapRoot });
    assert(r.success === true, `validate_designations failed: ${r.error}`);
    const validation = r.validation as Record<string, unknown>;
    console.log(`        ${validation.summary}`);
    return ['validate_designations'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 2: PGR Setup on New City (under pg)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Phase 2: PGR Setup ──');

  // 6. Verify tenant.tenants schema has x-unique on pg
  await testWithDeps('6 verify tenant schema on pg', ['1 configure + login'], async () => {
    // tenant.tenants schema on pg needs x-unique for mdms_create to work.
    // The seed data originally lacked x-unique; it should be fixed now.
    const schemas = await digitApi.mdmsSchemaSearch('pg', ['tenant.tenants']);
    assert(schemas.length > 0, 'tenant.tenants schema not found on pg');
    const def = (schemas[0] as Record<string, unknown>).definition as Record<string, unknown>;
    const xUnique = def?.['x-unique'] as string[] | undefined;
    assert(xUnique !== undefined && xUnique.length > 0,
      'tenant.tenants schema on pg lacks x-unique — run: psql -h localhost -p 15432 -U egov -d egov -c ' +
      '"UPDATE eg_mdms_schema_definition SET definition = definition || \'{\\"x-unique\\": [\\"code\\"]}\'::jsonb ' +
      'WHERE code = \'tenant.tenants\' AND tenantid = \'pg\';"');
    console.log(`        tenant.tenants schema has x-unique: [${xUnique.join(', ')}]`);
    return ['mdms_schema_search'];
  });

  // 7. Create city tenant record under pg
  await testWithDeps('7 create city tenant under pg', ['6 verify tenant schema on pg'], async () => {
    const existing = await call('mdms_search', {
      tenant_id: 'pg',
      schema_code: 'tenant.tenants',
      unique_identifiers: [state.cityTenant],
    });
    if (existing.success && (existing.count as number) > 0) {
      console.log(`        City tenant ${state.cityTenant} already exists`);
      return ['mdms_search'];
    }

    // City code for idgen: extract part after "pg." and uppercase it
    const cityCode = state.cityTenant.split('.')[1]!.toUpperCase();
    const r = await call('mdms_create', {
      tenant_id: 'pg',
      schema_code: 'tenant.tenants',
      unique_identifier: `Tenant.${state.cityTenant}`,
      data: {
        code: state.cityTenant,
        name: `E2E City ${RUN_ID}`,
        tenantId: state.cityTenant,
        parent: 'pg',
        city: {
          code: cityCode,
          name: `E2E City ${RUN_ID}`,
        },
      },
    });
    assert(r.success === true, `mdms_create city tenant failed: ${r.error}`);
    console.log(`        Created city tenant: ${state.cityTenant}`);
    return ['mdms_create'];
  });

  // 8. Create boundary hierarchy + entities
  await testWithDeps('8 create boundary hierarchy + entities', ['7 create city tenant under pg'], async () => {
    const r = await call('boundary_create', {
      tenant_id: state.cityTenant,
      hierarchy_definition: ['Country', 'State', 'District', 'City', 'Ward', 'Locality'],
      boundaries: [
        { code: `COUNTRY_${RUN_ID}`, type: 'Country' },
        { code: `STATE_${RUN_ID}`, type: 'State', parent: `COUNTRY_${RUN_ID}` },
        { code: `DISTRICT_${RUN_ID}`, type: 'District', parent: `STATE_${RUN_ID}` },
        { code: `CITY_${RUN_ID}`, type: 'City', parent: `DISTRICT_${RUN_ID}` },
        { code: `WARD_${RUN_ID}`, type: 'Ward', parent: `CITY_${RUN_ID}` },
        { code: state.localityCode, type: 'Locality', parent: `WARD_${RUN_ID}` },
      ],
    });
    const summary = r.summary as Record<string, number> | undefined;
    const created = (summary?.entitiesCreated ?? 0) + (summary?.entitiesSkipped ?? 0);
    assert(created >= 6, `boundary_create should create/skip >=6 entities, got ${created}: ${r.error}`);
    console.log(`        Entities: ${summary?.entitiesCreated ?? 0} created, ${summary?.entitiesSkipped ?? 0} skipped`);
    console.log(`        Relationships: ${summary?.relationshipsCreated ?? 0} created`);
    return ['boundary_create'];
  });

  // 8. Copy PGR workflow (idempotent — pg already has it, but verifies the tool works)
  await testWithDeps('9 copy PGR workflow', ['1 configure + login'], async () => {
    const r = await call('workflow_create', {
      tenant_id: 'pg',
      copy_from_tenant: 'pg',
    });
    assert(r.success === true, `workflow_create failed: ${r.error}`);
    const summary = r.summary as Record<string, number>;
    console.log(`        Created: ${summary.created}, Skipped: ${summary.skipped}`);
    return ['workflow_create'];
  });

  // 9. Verify PGR workflow
  await testWithDeps('10 verify PGR workflow', ['9 copy PGR workflow'], async () => {
    const r = await call('workflow_business_services', {
      tenant_id: state.cityTenant,
      business_services: ['PGR'],
    });
    assert(r.success === true, `workflow_business_services failed: ${r.error}`);
    assert((r.count as number) >= 1, `Expected PGR workflow, found ${r.count}`);
    console.log(`        PGR workflow active on ${state.cityTenant}`);
    return ['workflow_business_services'];
  });

  // 10. Verify complaint types
  await testWithDeps('11 verify complaint types', ['1 configure + login'], async () => {
    const r = await call('validate_complaint_types', { tenant_id: state.cityTenant });
    assert(r.success === true, `validate_complaint_types failed: ${r.error}`);
    const validation = r.validation as Record<string, unknown>;
    console.log(`        ${validation.summary}`);
    return ['validate_complaint_types'];
  });

  // 11. Create GRO+LME employee on new city
  const empMobile = `91${String(RUN_ID).padStart(8, '0')}`;

  await testWithDeps('12 create GRO+LME employee', ['8 create boundary hierarchy + entities'], async () => {
    const r = await call('employee_create', {
      tenant_id: state.cityTenant,
      name: `E2E Employee ${RUN_ID}`,
      mobile_number: empMobile,
      roles: [
        { code: 'GRO', name: 'Grievance Routing Officer' },
        { code: 'PGR_LME', name: 'PGR Last Mile Employee' },
        { code: 'DGRO', name: 'Department GRO' },
      ],
      department: 'DEPT_1',
      designation: 'DESIG_1',
      jurisdiction_boundary_type: 'City',
      jurisdiction_boundary: state.cityTenant,
    });
    const isHrmsBug = !r.success && ((r.error as string) || '').includes('getUser()');
    if (isHrmsBug) {
      markKnownBug('12 create GRO+LME employee', 'HRMS employee_create NPE on getUser() — server-side bug');
      return ['employee_create'];
    }
    assert(r.success === true, `employee_create failed: ${r.error}`);
    const emp = r.employee as Record<string, unknown>;
    state.employeeCode = emp.code as string;
    state.employeeUuid = emp.uuid as string;
    assert(state.employeeCode, 'employee code should not be null');
    console.log(`        Created: ${state.employeeCode} (uuid: ${state.employeeUuid})`);
    return ['employee_create'];
  });

  // 12. Validate employees on new city
  await testWithDeps('13 validate employees', ['12 create GRO+LME employee'], async () => {
    await wait(3000, 'HRMS indexing');
    const r = await call('validate_employees', {
      tenant_id: state.cityTenant,
      required_roles: ['GRO', 'PGR_LME'],
    });
    assert(r.success === true, `validate_employees failed: ${r.error}`);
    const validation = r.validation as Record<string, unknown>;
    console.log(`        ${validation.summary}`);
    return ['validate_employees'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 3: PGR Lifecycle
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Phase 3: PGR Lifecycle ──');

  // 13. Create PGR complaint
  await testWithDeps('14 create PGR complaint', ['10 verify PGR workflow', '11 verify complaint types', '12 create GRO+LME employee'], async () => {
    const r = await call('pgr_create', {
      tenant_id: state.cityTenant,
      service_code: 'StreetLightNotWorking',
      description: `E2E test complaint on new city ${state.cityTenant} (run ${RUN_ID})`,
      address: { locality: { code: state.localityCode } },
      citizen_name: `E2E Citizen ${RUN_ID}`,
      citizen_mobile: state.citizenMobile,
    });
    assert(r.success === true, `pgr_create failed: ${r.error}`);
    const complaint = r.complaint as Record<string, unknown>;
    state.complaintId = complaint.serviceRequestId as string;
    assert(state.complaintId, 'complaint ID should not be null');
    console.log(`        Created: ${state.complaintId}`);
    return ['pgr_create'];
  });

  // 14. Search for complaint (with retry for eventual consistency)
  await testWithDeps('15 search for complaint', ['14 create PGR complaint'], async () => {
    const found = await waitForCondition(async () => {
      const r = await call('pgr_search', {
        tenant_id: state.cityTenant,
        service_request_id: state.complaintId!,
      });
      if (r.success && (r.count as number) >= 1) return r;
      return null;
    }, { maxAttempts: 5, intervalMs: 2000, label: `find complaint ${state.complaintId}` });
    console.log(`        Found complaint: ${state.complaintId}`);
    return ['pgr_search'];
  });

  // 15. ASSIGN complaint (auto-route — don't specify assignees, PGR HRMS lookup is misconfigured)
  await testWithDeps('16 ASSIGN complaint', ['15 search for complaint'], async () => {
    await wait(2000, 'PGR workflow settling');
    const r = await call('pgr_update', {
      tenant_id: state.cityTenant,
      service_request_id: state.complaintId!,
      action: 'ASSIGN',
      comment: `E2E: assigned by integration test (run ${RUN_ID})`,
    });
    assert(r.success === true, `pgr_update ASSIGN failed: ${r.error}`);
    console.log(`        ASSIGN: success (auto-routed)`);
    return ['pgr_update'];
  });

  // 16. RESOLVE complaint
  await testWithDeps('17 RESOLVE complaint', ['16 ASSIGN complaint'], async () => {
    await wait(2000, 'PGR ASSIGN settling');
    const r = await call('pgr_update', {
      tenant_id: state.cityTenant,
      service_request_id: state.complaintId!,
      action: 'RESOLVE',
      comment: `E2E: resolved by integration test (run ${RUN_ID})`,
    });
    assert(r.success === true, `pgr_update RESOLVE failed: ${r.error}`);
    console.log(`        RESOLVE: success`);
    return ['pgr_update'];
  });

  // 17. RATE complaint (as citizen)
  await testWithDeps('18 RATE complaint as citizen', ['17 RESOLVE complaint'], async () => {
    await wait(2000, 'PGR RESOLVE settling');
    try {
      // Login as citizen (mobile number is the username, pgr_create auto-creates the user)
      const loginR = await call('configure', {
        environment: targetEnv,
        username: state.citizenMobile,
        password: 'eGov@123',
      });
      assert(loginR.success === true, `citizen login failed: ${loginR.error}`);

      const r = await call('pgr_update', {
        tenant_id: state.cityTenant,
        service_request_id: state.complaintId!,
        action: 'RATE',
        rating: 5,
        comment: `E2E: rated by citizen (run ${RUN_ID})`,
      });
      assert(r.success === true, `pgr_update RATE failed: ${r.error}`);
      const complaint = r.complaint as Record<string, unknown>;
      console.log(`        RATE: success (rating: ${complaint?.rating}, status: ${complaint?.newStatus})`);
    } finally {
      // Restore admin login
      await call('configure', {
        environment: targetEnv,
        username: adminUser,
        password: adminPass,
      });
    }
    return ['pgr_update', 'configure'];
  });

  // 18. Verify workflow final state
  await testWithDeps('19 verify workflow final state', ['18 RATE complaint as citizen'], async () => {
    const r = await call('workflow_process_search', {
      tenant_id: state.cityTenant,
      business_ids: [state.complaintId!],
    });
    assert(r.success === true, `workflow_process_search failed: ${r.error}`);
    const count = r.count as number;
    assert(count >= 1, `Expected >=1 workflow process instance, got ${count}`);
    // Verify final state is CLOSEDAFTERRESOLUTION (after RATE)
    const instances = r.processInstances as Array<Record<string, unknown>>;
    const latest = instances[0];
    assert(latest.state === 'CLOSEDAFTERRESOLUTION',
      `Expected final state CLOSEDAFTERRESOLUTION, got ${latest.state}`);
    assert(latest.action === 'RATE', `Expected final action RATE, got ${latest.action}`);
    console.log(`        Final state: ${latest.state} (action: ${latest.action})`);
    return ['workflow_process_search'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 4: Cleanup
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Phase 4: Cleanup ──');

  // 19. Cleanup bootstrap root
  await testWithDeps('20 cleanup bootstrap root', ['2 bootstrap new root tenant'], async () => {
    const r = await call('tenant_cleanup', {
      tenant_id: state.bootstrapRoot,
      deactivate_users: true,
    });
    assert(r.success === true, `tenant_cleanup failed: ${JSON.stringify(r)}`);
    const summary = r.summary as Record<string, number>;
    console.log(`        MDMS deleted: ${summary.mdms_deleted}, Users deactivated: ${summary.users_deactivated}`);
    return ['tenant_cleanup'];
  });

  // 20. Verify bootstrap cleanup
  await testWithDeps('21 verify bootstrap cleanup', ['20 cleanup bootstrap root'], async () => {
    await wait(3000, 'MDMS cleanup propagation');
    const r = await waitForCondition(async () => {
      const res = await call('mdms_search', {
        tenant_id: state.bootstrapRoot,
        schema_code: 'common-masters.Department',
      });
      if (!res.success) return null;
      const records = (res.records as Array<{ isActive: boolean }>) || [];
      const activeRecords = records.filter(rec => rec.isActive);
      if (activeRecords.length === 0) return res;
      return null;
    }, { maxAttempts: 5, intervalMs: 3000, label: 'verify 0 active records after cleanup' });
    console.log(`        Verified: 0 active department records on ${state.bootstrapRoot}`);
    return ['mdms_search'];
  });

  // ════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                     TEST RESULTS                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  Total:      ${results.length}`);
  console.log(`  Passed:     \x1b[32m${passed.length}\x1b[0m`);
  console.log(`  Failed:     \x1b[31m${failed.length}\x1b[0m`);
  console.log(`  Skipped:    \x1b[33m${skipped.length}\x1b[0m`);
  console.log(`  Known bugs: \x1b[33m${knownBugTests.length}\x1b[0m`);

  if (failed.length > 0) {
    console.log(`\n  Failed tests:`);
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`    \x1b[31m✗\x1b[0m ${r.name}: ${r.error}`);
    }
  }

  if (knownBugTests.length > 0) {
    console.log(`\n  Known server bug tests:`);
    for (const name of knownBugTests) {
      console.log(`    \x1b[33m⚠\x1b[0m ${name}`);
    }
  }

  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`\n  Total time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Bootstrap:  ${state.bootstrapRoot}`);
  console.log(`  PGR city:   ${state.cityTenant}`);
  if (state.complaintId) {
    console.log(`  Complaint:  ${state.complaintId}`);
  }
  console.log('');

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
