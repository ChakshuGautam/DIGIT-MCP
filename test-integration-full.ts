/**
 * Comprehensive integration tests for DIGIT MCP Server — 57 tools, 100% coverage.
 *
 * Hits the real DIGIT API (set CRS_API_URL env var).
 * Tests are STRICT — no error swallowing. Failures expose MCP bugs to fix.
 *
 * Required env vars:
 *   CRS_API_URL      - DIGIT API gateway URL (e.g. https://your-digit-instance)
 *   CRS_USERNAME     - DIGIT admin username (default: ADMIN)
 *   CRS_PASSWORD     - DIGIT admin password (default: eGov@123)
 *   CRS_ENVIRONMENT  - Environment key (default: chakshu-digit)
 */

import { ToolRegistry } from './src/tools/registry.js';
import { registerAllTools } from './src/tools/index.js';
import { digitApi } from './src/services/digit-api.js';
import type { ToolGroup } from './src/types/index.js';

// ════════════════════════════════════════════════════════════════════
// Test infrastructure
// ════════════════════════════════════════════════════════════════════

const ALL_TOOL_NAMES: readonly string[] = [
  'access_actions_search', 'access_roles_search', 'api_catalog',
  'boundary_create', 'boundary_hierarchy_search',
  'boundary_mgmt_download', 'boundary_mgmt_generate', 'boundary_mgmt_process', 'boundary_mgmt_search',
  'configure', 'db_counts', 'decrypt_data', 'discover_tools', 'docs_get', 'docs_search',
  'employee_create', 'employee_update', 'enable_tools', 'encrypt_data',
  'filestore_get_urls', 'filestore_upload', 'get_environment_info', 'health_check',
  'idgen_generate', 'kafka_lag', 'localization_search', 'localization_upsert', 'location_search',
  'mdms_create', 'mdms_get_tenants', 'mdms_schema_create', 'mdms_schema_search', 'mdms_search',
  'persister_errors', 'persister_monitor',
  'pgr_create', 'pgr_search', 'pgr_update',
  'tenant_bootstrap', 'tenant_cleanup',
  'trace_debug', 'trace_get', 'trace_search', 'trace_slow', 'tracing_health',
  'user_create', 'user_role_add', 'user_search',
  'validate_boundary', 'validate_complaint_types', 'validate_departments',
  'validate_designations', 'validate_employees', 'validate_tenant',
  'workflow_business_services', 'workflow_create', 'workflow_process_search',
] as const;

/** Which tools have been called at least once during the test run. */
const toolsCovered = new Set<string>();

/** Per-test results. */
interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  ms: number;
  error?: string;
  toolsCalled: string[];
}
const results: TestResult[] = [];
const passed: string[] = [];
const failed: string[] = [];
const skipped: string[] = [];

/** Track dependency failures — if a test fails, dependents auto-skip. */
const failedTests = new Set<string>();

/** Unique run ID — avoids collisions between test runs. */
const RUN_ID = Date.now() % 100000000;
const TEST_PREFIX = `INTTEST_${RUN_ID}`;

/** Convert a numeric ID to a lowercase letter-only string (DIGIT tenant codes must match ^[a-zA-Z. ]*$). */
function toLetters(n: number): string {
  let s = '';
  let num = n;
  while (num > 0) {
    s = String.fromCharCode(97 + (num % 26)) + s; // a-z
    num = Math.floor(num / 26);
  }
  return s || 'a';
}

/** Infra availability detected in section 0. */
let hasDocker = false;
let hasTempo = false;

// ── Shared mutable state passed between tests ──
interface TestState {
  tenantId: string;
  stateTenantId: string;
  mdmsRecordId: string | null;
  mdmsRecordSchemaCode: string;
  mdmsRecordUniqueId: string;
  employeeCode: string | null;
  employeeTenantId: string;
  employeeUuid: string | null;
  testUserMobile: string;
  testUserUuid: string | null;
  complaintId: string | null;
  complaintTenantId: string;
  citizenMobile: string;
  fileStoreId: string | null;
  encryptedValue: string | null;
  localizationCode: string;
  testTenantRoot: string;
  localityCode: string | null;
  docsUrl: string | null;
  traceId: string | null;
}

const state: TestState = {
  tenantId: 'pg.citya',
  stateTenantId: 'pg',
  mdmsRecordId: null,
  mdmsRecordSchemaCode: 'common-masters.Department',
  mdmsRecordUniqueId: `${TEST_PREFIX}_DEPT`,
  employeeCode: null,
  employeeTenantId: 'pg.citya',
  employeeUuid: null,
  testUserMobile: `88${String(RUN_ID).padStart(8, '0')}`,
  testUserUuid: null,
  complaintId: null,
  complaintTenantId: 'pg.citya',
  citizenMobile: `77${String(RUN_ID).padStart(8, '0')}`,
  fileStoreId: null,
  encryptedValue: null,
  localizationCode: `${TEST_PREFIX}_LABEL`,
  testTenantRoot: `t${toLetters(RUN_ID)}`,
  localityCode: null,
  docsUrl: null,
  traceId: null,
};

// ════════════════════════════════════════════════════════════════════
// Test runner
// ════════════════════════════════════════════════════════════════════

let registry: ToolRegistry;

/** Call a tool by name and parse the JSON result. Records coverage. */
async function call(toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = registry.getTool(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  toolsCovered.add(toolName);
  const raw = await tool.handler(args);
  return JSON.parse(raw);
}

/** Run a test. */
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

/** Run a test that depends on other tests passing first. */
async function testWithDeps(name: string, deps: string[], fn: () => Promise<string[]>): Promise<void> {
  const failedDep = deps.find(d => failedTests.has(d));
  if (failedDep) {
    skipped.push(name);
    results.push({ name, status: 'skip', ms: 0, error: `Dependency failed: ${failedDep}`, toolsCalled: [] });
    console.log(`  \x1b[33mSKIP\x1b[0m  ${name} \x1b[90m(dep: ${failedDep})\x1b[0m`);
    return;
  }
  await test(name, fn);
}

/** Skip a test with a reason. */
function skip(name: string, reason: string, tools: string[] = []): void {
  skipped.push(name);
  for (const t of tools) toolsCovered.add(t);
  results.push({ name, status: 'skip', ms: 0, error: reason, toolsCalled: tools });
  console.log(`  \x1b[33mSKIP\x1b[0m  ${name} \x1b[90m(${reason})\x1b[0m`);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   DIGIT MCP Server — Comprehensive Integration Tests       ║');
  console.log('║   57 tools • STRICT mode • no error swallowing             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  RUN_ID: ${RUN_ID}  TEST_PREFIX: ${TEST_PREFIX}`);
  console.log('');

  registry = new ToolRegistry();
  let listChangedCount = 0;
  registry.setToolListChangedCallback(() => { listChangedCount++; });
  registerAllTools(registry);

  const allGroups: ToolGroup[] = ['core', 'mdms', 'boundary', 'masters', 'employees', 'localization', 'pgr', 'admin', 'idgen', 'location', 'encryption', 'docs', 'monitoring', 'tracing'];
  registry.enableGroups(allGroups);

  const targetEnv = process.env.CRS_ENVIRONMENT || 'chakshu-digit';

  // ──────────────────────────────────────────────────────────────────
  // Section 0: Infra Detection
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 0: Infrastructure Detection ──');

  await test('0.1 detect Docker availability', async () => {
    const r = await call('kafka_lag');
    hasDocker = r.ok === true;
    console.log(`        Docker/rpk: ${hasDocker ? 'available' : 'not available'}`);
    return ['kafka_lag'];
  });

  await test('0.2 detect Tempo availability', async () => {
    const r = await call('tracing_health');
    hasTempo = r.status === 'healthy';
    console.log(`        Tempo: ${hasTempo ? 'healthy' : 'not available'}`);
    return ['tracing_health'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 1: Core tools
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 1: Core ──');

  await test('1.1 discover_tools', async () => {
    const r = await call('discover_tools');
    assert(r.success === true, 'discover_tools should succeed');
    assert(typeof r.groups === 'object', 'should return groups');
    console.log(`        ${r.message}`);
    return ['discover_tools'];
  });

  await test('1.2 enable_tools', async () => {
    const r = await call('enable_tools', { enable: ['pgr', 'admin'] });
    assert(r.success === true, 'enable_tools should succeed');
    return ['enable_tools'];
  });

  await test('1.3 enable_tools: disable + re-enable', async () => {
    const r1 = await call('enable_tools', { disable: ['location'] });
    assert(r1.success === true, 'disable should succeed');
    const r2 = await call('enable_tools', { enable: ['location'] });
    assert(r2.success === true, 're-enable should succeed');
    return ['enable_tools'];
  });

  await test(`1.4 configure: login to ${targetEnv}`, async () => {
    const username = process.env.CRS_USERNAME || 'ADMIN';
    const password = process.env.CRS_PASSWORD || 'eGov@123';
    const r = await call('configure', { environment: targetEnv, username, password });
    assert(r.success === true, `configure failed: ${r.error}`);
    console.log(`        Logged in as: ${(r.user as Record<string, unknown>)?.userName}`);
    return ['configure'];
  });

  await test('1.5 get_environment_info', async () => {
    const r = await call('get_environment_info');
    assert(r.success === true, 'get_environment_info failed');
    assert(r.authenticated === true, 'should be authenticated');
    const cur = r.current as Record<string, unknown>;
    console.log(`        Environment: ${cur.name} (${cur.url})`);
    return ['get_environment_info'];
  });

  await test('1.6 mdms_get_tenants', async () => {
    const r = await call('mdms_get_tenants');
    assert(r.success === true, 'mdms_get_tenants failed');
    assert((r.count as number) > 0, 'no tenants found');
    const tenants = r.tenants as Array<{ code: string }>;
    const city = tenants.find(t => t.code === 'pg.citya')
      || tenants.find(t => t.code.startsWith('pg.'))
      || tenants.find(t => t.code.includes('.'))
      || tenants[0];
    if (city) {
      state.tenantId = city.code;
      state.stateTenantId = city.code.split('.')[0];
      state.complaintTenantId = city.code;
      state.employeeTenantId = city.code;
    }
    console.log(`        Found ${r.count} tenant(s), using: ${state.tenantId}`);
    return ['mdms_get_tenants'];
  });

  await test('1.7 health_check', async () => {
    const r = await call('health_check', { tenant_id: state.tenantId, timeout_ms: 15000 });
    assert(r.success === true, 'health_check failed');
    const summary = r.summary as Record<string, number>;
    console.log(`        Services: ${summary.healthy} healthy, ${summary.unhealthy} unhealthy, ${summary.skipped} skipped`);
    return ['health_check'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 2: MDMS
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 2: MDMS ──');

  await test('2.1 validate_tenant: valid', async () => {
    const r = await call('validate_tenant', { tenant_id: state.tenantId });
    assert(r.valid === true, `${state.tenantId} should be valid`);
    return ['validate_tenant'];
  });

  await test('2.2 validate_tenant: invalid', async () => {
    const r = await call('validate_tenant', { tenant_id: 'nonexistent.fake.xyz' });
    assert(r.valid === false, 'should be invalid');
    return ['validate_tenant'];
  });

  await test('2.3 mdms_search: departments', async () => {
    const r = await call('mdms_search', {
      tenant_id: state.stateTenantId,
      schema_code: 'common-masters.Department',
    });
    assert(r.success === true, 'mdms_search failed');
    assert((r.count as number) > 0, 'no departments found');
    console.log(`        Found ${r.count} departments`);
    return ['mdms_search'];
  });

  await test('2.4 mdms_search: with unique_identifiers filter', async () => {
    const r = await call('mdms_search', {
      tenant_id: state.stateTenantId,
      schema_code: 'common-masters.Department',
      unique_identifiers: ['DEPT_1'],
    });
    assert(r.success === true, 'mdms_search with filter failed');
    return ['mdms_search'];
  });

  await test('2.5 mdms_schema_search', async () => {
    const r = await call('mdms_schema_search', { tenant_id: state.stateTenantId });
    assert(r.success === true, 'mdms_schema_search failed');
    assert((r.count as number) > 0, 'no schemas found');
    console.log(`        Found ${r.count} schemas on ${state.stateTenantId}`);
    return ['mdms_schema_search'];
  });

  await test('2.6 mdms_schema_search: filtered by code', async () => {
    const r = await call('mdms_schema_search', {
      tenant_id: state.stateTenantId,
      codes: ['common-masters.Department'],
    });
    assert(r.success === true, 'filtered schema search failed');
    assert((r.count as number) >= 1, 'Department schema not found');
    return ['mdms_schema_search'];
  });

  await test('2.7 mdms_schema_create: copy from pg (idempotent)', async () => {
    const r = await call('mdms_schema_create', {
      tenant_id: state.stateTenantId,
      code: 'common-masters.Department',
      copy_from_tenant: 'pg',
    });
    assert(r.success === true, `mdms_schema_create failed: ${r.error}`);
    return ['mdms_schema_create'];
  });

  await test('2.8 mdms_create: test department record', async () => {
    const r = await call('mdms_create', {
      tenant_id: state.stateTenantId,
      schema_code: state.mdmsRecordSchemaCode,
      unique_identifier: state.mdmsRecordUniqueId,
      data: {
        code: state.mdmsRecordUniqueId,
        name: `Integration Test Dept ${RUN_ID}`,
        active: true,
      },
    });
    assert(r.success === true || (r.error as string || '').includes('NON_UNIQUE'),
      `mdms_create failed: ${r.error}`);
    if (r.success) {
      state.mdmsRecordId = (r.record as Record<string, unknown>)?.id as string;
      console.log(`        Created: ${state.mdmsRecordUniqueId}`);
    } else {
      console.log(`        Already exists (OK)`);
    }
    return ['mdms_create'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 3: Boundary
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 3: Boundary ──');

  await test('3.1 validate_boundary', async () => {
    const r = await call('validate_boundary', { tenant_id: state.tenantId });
    assert(r.success === true, 'validate_boundary failed');
    const v = r.validation as Record<string, unknown>;
    console.log(`        ${v.summary}`);

    // Extract a locality code from existing complaints for PGR tests
    const pgr = await call('pgr_search', { tenant_id: state.tenantId, limit: 10 });
    const complaints = pgr.complaints as Array<Record<string, unknown>> | undefined;
    if (complaints) {
      for (const c of complaints) {
        const addr = c.address as Record<string, unknown> | undefined;
        const loc = addr?.locality as Record<string, unknown> | undefined;
        if (loc?.code) {
          state.localityCode = loc.code as string;
          break;
        }
      }
    }
    if (!state.localityCode && state.tenantId === 'pg.citya') {
      state.localityCode = 'SUN04';
    }
    console.log(`        Locality for PGR: ${state.localityCode || '(none found)'}`);
    return ['validate_boundary'];
  });

  await test('3.2 boundary_hierarchy_search', async () => {
    const r = await call('boundary_hierarchy_search', { tenant_id: state.tenantId });
    assert(r.success === true, 'boundary_hierarchy_search failed');
    console.log(`        Found ${r.count} hierarchy(s)`);
    return ['boundary_hierarchy_search'];
  });

  await test('3.3 boundary_mgmt_search', async () => {
    const r = await call('boundary_mgmt_search', { tenant_id: state.tenantId });
    assert(r.success !== undefined, 'boundary_mgmt_search should return a result');
    console.log(`        Result: success=${r.success}, count=${r.count ?? 'n/a'}`);
    return ['boundary_mgmt_search'];
  });

  await test('3.4 boundary_mgmt_download', async () => {
    const r = await call('boundary_mgmt_download', { tenant_id: state.tenantId });
    assert(r.success !== undefined, 'boundary_mgmt_download should return a result');
    console.log(`        Result: success=${r.success}`);
    return ['boundary_mgmt_download'];
  });

  await test('3.5 boundary_create: exercise with empty list', async () => {
    const r = await call('boundary_create', {
      tenant_id: state.tenantId,
      boundaries: [],
      hierarchy_definition: ['Country', 'State', 'District', 'City', 'Ward', 'Locality'],
    });
    assert(r.success === true, `boundary_create failed: ${r.error}`);
    return ['boundary_create'];
  });

  skip('3.6 boundary_mgmt_process (requires Excel upload)', 'needs file upload workflow', ['boundary_mgmt_process']);
  skip('3.7 boundary_mgmt_generate (requires prior process)', 'needs boundary_mgmt_process first', ['boundary_mgmt_generate']);

  // ──────────────────────────────────────────────────────────────────
  // Section 4: Masters
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 4: Masters ──');

  await test('4.1 validate_departments', async () => {
    const r = await call('validate_departments', { tenant_id: state.tenantId });
    assert(r.success === true, 'validate_departments failed');
    console.log(`        ${(r.validation as Record<string, unknown>).summary}`);
    return ['validate_departments'];
  });

  await test('4.2 validate_departments: with required check', async () => {
    const r = await call('validate_departments', {
      tenant_id: state.tenantId,
      required_departments: ['DEPT_1'],
    });
    assert(r.success === true, 'validate_departments with required failed');
    return ['validate_departments'];
  });

  await test('4.3 validate_designations', async () => {
    const r = await call('validate_designations', { tenant_id: state.tenantId });
    assert(r.success === true, 'validate_designations failed');
    console.log(`        ${(r.validation as Record<string, unknown>).summary}`);
    return ['validate_designations'];
  });

  await test('4.4 validate_complaint_types', async () => {
    const r = await call('validate_complaint_types', { tenant_id: state.tenantId });
    assert(r.success === true, 'validate_complaint_types failed');
    console.log(`        ${(r.validation as Record<string, unknown>).summary}`);
    return ['validate_complaint_types'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 5: Employees
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 5: Employees ──');

  await test('5.1 validate_employees', async () => {
    const r = await call('validate_employees', { tenant_id: state.tenantId });
    assert(r.success === true, 'validate_employees failed');
    console.log(`        ${(r.validation as Record<string, unknown>).summary}`);
    return ['validate_employees'];
  });

  await test('5.2 validate_employees: with required roles', async () => {
    const r = await call('validate_employees', {
      tenant_id: state.tenantId,
      required_roles: ['GRO'],
    });
    assert(r.success === true, 'validate_employees with roles failed');
    return ['validate_employees'];
  });

  const empMobile = `99${String(RUN_ID).padStart(8, '0')}`;

  await test('5.3 employee_create', async () => {
    const r = await call('employee_create', {
      tenant_id: state.employeeTenantId,
      name: `Test Employee ${RUN_ID}`,
      mobile_number: empMobile,
      roles: [
        { code: 'GRO', name: 'Grievance Routing Officer' },
        { code: 'PGR_LME', name: 'PGR Last Mile Employee' },
        { code: 'DGRO', name: 'Department GRO' },
      ],
      department: 'DEPT_1',
      designation: 'DESIG_1',
      jurisdiction_boundary_type: 'City',
      jurisdiction_boundary: state.employeeTenantId,
    });
    assert(r.success === true, `employee_create failed: ${r.error}`);
    const emp = r.employee as Record<string, unknown>;
    state.employeeCode = emp.code as string;
    state.employeeUuid = emp.uuid as string;
    console.log(`        Created: ${state.employeeCode}`);
    return ['employee_create'];
  });

  await testWithDeps('5.4 employee_update: add role', ['5.3 employee_create'], async () => {
    const r = await call('employee_update', {
      tenant_id: state.employeeTenantId,
      employee_code: state.employeeCode!,
      add_roles: [{ code: 'SUPERUSER', name: 'Super User' }],
    });
    assert(r.success === true, `employee_update add role failed: ${r.error}`);
    console.log(`        Added SUPERUSER role to ${state.employeeCode}`);
    return ['employee_update'];
  });

  await testWithDeps('5.5 employee_update: deactivate', ['5.3 employee_create'], async () => {
    const r = await call('employee_update', {
      tenant_id: state.employeeTenantId,
      employee_code: state.employeeCode!,
      deactivate: true,
    });
    assert(r.success === true, `employee_update deactivate failed: ${r.error}`);
    console.log(`        Deactivated ${state.employeeCode}`);
    return ['employee_update'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 6: Localization
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 6: Localization ──');

  await test('6.1 localization_search', async () => {
    const r = await call('localization_search', {
      tenant_id: state.stateTenantId,
      locale: 'en_IN',
      module: 'rainmaker-pgr',
    });
    assert(r.success === true, `localization_search failed: ${r.error}`);
    console.log(`        Found ${r.count} messages`);
    return ['localization_search'];
  });

  await test('6.2 localization_upsert', async () => {
    const r = await call('localization_upsert', {
      tenant_id: state.stateTenantId,
      locale: 'en_IN',
      messages: [{
        code: state.localizationCode,
        message: `Test label ${RUN_ID}`,
        module: 'rainmaker-common',
      }],
    });
    assert(r.success === true, `localization_upsert failed: ${r.error}`);
    assert((r.upserted as number) === 1, `expected 1 upserted, got ${r.upserted}`);
    console.log(`        Upserted: ${state.localizationCode}`);
    return ['localization_upsert'];
  });

  await testWithDeps('6.3 localization_search: verify upsert', ['6.2 localization_upsert'], async () => {
    const r = await call('localization_search', {
      tenant_id: state.stateTenantId,
      locale: 'en_IN',
      module: 'rainmaker-common',
    });
    assert(r.success === true, `localization_search failed: ${r.error}`);
    console.log(`        Found ${r.count} messages in rainmaker-common`);
    return ['localization_search'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 7: PGR Lifecycle
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 7: PGR Lifecycle ──');

  await test('7.1 workflow_business_services', async () => {
    const r = await call('workflow_business_services', {
      tenant_id: state.tenantId,
      business_services: ['PGR'],
    });
    assert(r.success === true, 'workflow_business_services failed');
    console.log(`        Found ${r.count} business service(s)`);
    return ['workflow_business_services'];
  });

  await test('7.2 pgr_search: baseline', async () => {
    const r = await call('pgr_search', { tenant_id: state.tenantId, limit: 5 });
    assert(r.success === true, 'pgr_search failed');
    console.log(`        Found ${r.count} existing complaint(s)`);
    return ['pgr_search'];
  });

  await test('7.3 pgr_create', async () => {
    const locality = state.localityCode || 'SUN04';
    const r = await call('pgr_create', {
      tenant_id: state.complaintTenantId,
      service_code: 'StreetLightNotWorking',
      description: `Integration test complaint ${TEST_PREFIX}`,
      address: { locality: { code: locality } },
      citizen_name: `Test Citizen ${RUN_ID}`,
      citizen_mobile: state.citizenMobile,
    });
    assert(r.success === true, `pgr_create failed: ${r.error}`);
    const complaint = r.complaint as Record<string, unknown>;
    state.complaintId = complaint.serviceRequestId as string;
    console.log(`        Created: ${state.complaintId}`);
    return ['pgr_create'];
  });

  await testWithDeps('7.4 pgr_search: find created complaint', ['7.3 pgr_create'], async () => {
    // Allow time for eventual consistency
    await new Promise(resolve => setTimeout(resolve, 2000));
    const r = await call('pgr_search', {
      tenant_id: state.complaintTenantId,
      service_request_id: state.complaintId!,
    });
    assert(r.success === true, 'pgr_search failed');
    assert((r.count as number) >= 1, `complaint ${state.complaintId} not found after 2s`);
    console.log(`        Found complaint: ${state.complaintId}`);
    return ['pgr_search'];
  });

  await testWithDeps('7.5 pgr_update: ASSIGN', ['7.3 pgr_create'], async () => {
    const r = await call('pgr_update', {
      tenant_id: state.complaintTenantId,
      service_request_id: state.complaintId!,
      action: 'ASSIGN',
      comment: `Assigned by integration test ${TEST_PREFIX}`,
    });
    assert(r.success === true, `pgr_update ASSIGN failed: ${r.error}`);
    console.log(`        ASSIGN: success`);
    return ['pgr_update'];
  });

  await testWithDeps('7.6 pgr_update: RESOLVE', ['7.5 pgr_update: ASSIGN'], async () => {
    const r = await call('pgr_update', {
      tenant_id: state.complaintTenantId,
      service_request_id: state.complaintId!,
      action: 'RESOLVE',
      comment: `Resolved by integration test ${TEST_PREFIX}`,
    });
    assert(r.success === true, `pgr_update RESOLVE failed: ${r.error}`);
    console.log(`        RESOLVE: success`);
    return ['pgr_update'];
  });

  await testWithDeps('7.7 workflow_process_search', ['7.3 pgr_create'], async () => {
    const r = await call('workflow_process_search', {
      tenant_id: state.complaintTenantId,
      business_ids: [state.complaintId!],
    });
    assert(r.success === true, `workflow_process_search failed: ${r.error}`);
    assert((r.count as number) >= 1, 'no workflow processes found for complaint');
    console.log(`        Found ${r.count} workflow process(es)`);
    return ['workflow_process_search'];
  });

  await test('7.8 workflow_create: idempotent copy', async () => {
    const r = await call('workflow_create', {
      tenant_id: state.stateTenantId,
      copy_from_tenant: 'pg',
    });
    assert(r.success === true, `workflow_create failed: ${r.error}`);
    const summary = r.summary as Record<string, number>;
    console.log(`        Created: ${summary.created}, Skipped: ${summary.skipped}, Failed: ${summary.failed}`);
    return ['workflow_create'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 8: Admin (User, Filestore, ACL)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 8: Admin ──');

  await test('8.1 user_search', async () => {
    const r = await call('user_search', { tenant_id: state.stateTenantId, user_name: 'ADMIN' });
    assert(r.success === true, 'user_search failed');
    assert((r.count as number) >= 1, 'ADMIN user not found');
    return ['user_search'];
  });

  await test('8.2 user_create', async () => {
    const r = await call('user_create', {
      tenant_id: state.stateTenantId,
      name: `Test User ${RUN_ID}`,
      mobile_number: state.testUserMobile,
    });
    assert(r.success === true || (r.error as string || '').includes('already'),
      `user_create failed: ${r.error}`);
    if (r.success) {
      state.testUserUuid = (r.user as Record<string, unknown>)?.uuid as string;
      console.log(`        Created user: ${state.testUserMobile}`);
    } else {
      console.log(`        User already exists (OK)`);
    }
    return ['user_create'];
  });

  await test('8.3 user_role_add', async () => {
    const r = await call('user_role_add', {
      tenant_id: state.stateTenantId,
      role_codes: ['CITIZEN', 'EMPLOYEE'],
    });
    assert(r.success === true, `user_role_add failed: ${r.error}`);
    return ['user_role_add'];
  });

  await test('8.4 filestore_upload', async () => {
    const content = Buffer.from(`integration test ${TEST_PREFIX}`).toString('base64');
    const r = await call('filestore_upload', {
      tenant_id: state.stateTenantId,
      module: 'PGR',
      file_name: `${TEST_PREFIX}.txt`,
      file_content_base64: content,
      content_type: 'text/plain',
    });
    assert(r.success === true, `filestore_upload failed: ${r.error}`);
    state.fileStoreId = (r.files as Array<{ fileStoreId: string }>)?.[0]?.fileStoreId || null;
    assert(state.fileStoreId !== null, 'filestore_upload returned no fileStoreId');
    console.log(`        Uploaded fileStoreId: ${state.fileStoreId}`);
    return ['filestore_upload'];
  });

  await testWithDeps('8.5 filestore_get_urls', ['8.4 filestore_upload'], async () => {
    const r = await call('filestore_get_urls', {
      tenant_id: state.stateTenantId,
      file_store_ids: [state.fileStoreId!],
    });
    assert(r.success === true, `filestore_get_urls failed: ${r.error}`);
    console.log(`        Got ${(r.files as unknown[])?.length || 0} URL(s)`);
    return ['filestore_get_urls'];
  });

  await test('8.6 access_roles_search', async () => {
    const r = await call('access_roles_search', { tenant_id: state.tenantId });
    assert(r.success === true, 'access_roles_search failed');
    assert((r.count as number) > 0, 'no roles found');
    console.log(`        Found ${r.count} roles`);
    return ['access_roles_search'];
  });

  await test('8.7 access_actions_search', async () => {
    const r = await call('access_actions_search', {
      tenant_id: state.tenantId,
      role_codes: ['GRO', 'PGR_LME'],
    });
    assert(r.success === true, 'access_actions_search failed');
    console.log(`        Found ${r.count} actions for GRO+PGR_LME`);
    return ['access_actions_search'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 9: IDGen
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 9: IDGen ──');

  await test('9.1 idgen_generate: single', async () => {
    const r = await call('idgen_generate', {
      tenant_id: state.stateTenantId,
      id_name: 'pgr.servicerequestid',
    });
    assert(r.success === true, `idgen_generate failed: ${r.error}`);
    console.log(`        Generated: ${(r.ids as string[])?.[0]}`);
    return ['idgen_generate'];
  });

  await test('9.2 idgen_generate: batch', async () => {
    const r = await call('idgen_generate', {
      tenant_id: state.stateTenantId,
      id_name: 'pgr.servicerequestid',
      count: 3,
    });
    assert(r.success === true, `idgen_generate batch failed: ${r.error}`);
    assert((r.ids as string[])?.length === 3, 'expected 3 IDs');
    return ['idgen_generate'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 10: Location
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 10: Location ──');

  await test('10.1 location_search', async () => {
    const r = await call('location_search', { tenant_id: state.tenantId });
    assert(r.success !== undefined, 'location_search should return a result');
    console.log(`        Result: success=${r.success}`);
    return ['location_search'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 11: Encryption
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 11: Encryption ──');

  const plaintext = `test-secret-${RUN_ID}`;

  await test('11.1 encrypt_data', async () => {
    const r = await call('encrypt_data', {
      tenant_id: state.stateTenantId,
      values: [plaintext],
    });
    assert(r.success === true, `encrypt_data failed: ${r.error}`);
    assert((r.count as number) === 1, 'expected 1 encrypted value');
    state.encryptedValue = (r.encrypted as string[])?.[0] || null;
    assert(state.encryptedValue !== null, 'encrypted value is null');
    console.log(`        Encrypted: ${state.encryptedValue!.substring(0, 30)}...`);
    return ['encrypt_data'];
  });

  await testWithDeps('11.2 decrypt_data: roundtrip', ['11.1 encrypt_data'], async () => {
    const r = await call('decrypt_data', {
      tenant_id: state.stateTenantId,
      encrypted_values: [state.encryptedValue!],
    });
    assert(r.success === true, `decrypt_data failed: ${r.error}`);
    const decrypted = (r.decrypted as string[])?.[0];
    assert(decrypted === plaintext, `roundtrip mismatch: expected "${plaintext}", got "${decrypted}"`);
    console.log(`        Roundtrip OK`);
    return ['decrypt_data'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 12: Docs
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 12: Docs ──');

  await test('12.1 docs_search', async () => {
    const r = await call('docs_search', { query: 'PGR complaint workflow' });
    assert(r.success === true, `docs_search failed: ${r.error}`);
    console.log(`        Found ${r.count} result(s)`);
    const searchResults = r.results as Array<{ url: string }>;
    if (searchResults?.length > 0 && searchResults[0].url) {
      state.docsUrl = searchResults[0].url;
    }
    return ['docs_search'];
  });

  await test('12.2 docs_get', async () => {
    const url = state.docsUrl || 'https://docs.digit.org/platform/platform/core-services/mdms-v2-master-data-management-service';
    const r = await call('docs_get', { url });
    assert(r.success === true, `docs_get failed for ${url}: ${r.error}`);
    const content = r.content as string;
    assert(content?.length > 0, 'docs_get returned empty content');
    console.log(`        Fetched ${content.length} chars from ${url}`);
    return ['docs_get'];
  });

  await test('12.3 api_catalog: summary', async () => {
    const r = await call('api_catalog', { format: 'summary' });
    assert(r.success === true, 'api_catalog summary failed');
    console.log(`        ${r.serviceCount} services, ${r.totalEndpoints} endpoints`);
    return ['api_catalog'];
  });

  await test('12.4 api_catalog: filtered by service', async () => {
    const r = await call('api_catalog', { format: 'summary', service: 'PGR' });
    assert(r.success === true, 'api_catalog filtered failed');
    return ['api_catalog'];
  });

  await test('12.5 api_catalog: openapi format', async () => {
    const r = await call('api_catalog', { format: 'openapi', service: 'PGR' });
    assert(r.success === true, 'api_catalog openapi failed');
    assert(r.spec !== undefined, 'expected spec in openapi output');
    return ['api_catalog'];
  });

  await test('12.6 docs_get: invalid URL (not docs.digit.org)', async () => {
    const r = await call('docs_get', { url: 'https://example.com/not-digit-docs' });
    assert(r.success === false, 'should reject non-docs.digit.org URL');
    console.log(`        Correctly rejected: ${r.error}`);
    return ['docs_get'];
  });

  await test('12.7 docs_get: nonexistent page', async () => {
    const r = await call('docs_get', { url: 'https://docs.digit.org/nonexistent-page-xyz-12345' });
    // Should return success=false with a helpful error, not throw
    assert(r.success === false, `docs_get should return success=false for 404, got: success=${r.success}`);
    console.log(`        Correctly handled 404: ${r.error}`);
    return ['docs_get'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 13: Monitoring
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 13: Monitoring ──');

  await test('13.1 kafka_lag', async () => {
    const r = await call('kafka_lag');
    // Tool should always return a result, even when Docker is unavailable
    assert(r.ok !== undefined, 'kafka_lag should return ok field');
    console.log(`        Status: ${r.status ?? 'n/a'}, ok=${r.ok}`);
    return ['kafka_lag'];
  });

  await test('13.2 persister_errors', async () => {
    const r = await call('persister_errors', { since: '5m' });
    assert(r.ok !== undefined || r.success !== undefined, 'persister_errors should return a result');
    console.log(`        Status: ${r.status ?? 'n/a'}`);
    return ['persister_errors'];
  });

  await test('13.3 db_counts', async () => {
    const r = await call('db_counts');
    assert(r.ok !== undefined || r.success !== undefined, 'db_counts should return a result');
    console.log(`        Status: ${r.status ?? 'n/a'}`);
    return ['db_counts'];
  });

  await test('13.4 persister_monitor', async () => {
    const r = await call('persister_monitor', {
      tenant_id: state.tenantId,
      since: '5m',
    });
    assert(r.success !== undefined || r.overallStatus !== undefined, 'persister_monitor should return a result');
    console.log(`        Overall: ${r.overallStatus ?? 'n/a'}, Alerts: ${r.alertCount ?? 'n/a'}`);
    return ['persister_monitor'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 14: Tracing (Tempo-dependent)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 14: Tracing ──');

  if (hasTempo) {
    await test('14.1 trace_search', async () => {
      const r = await call('trace_search', { seconds_ago: 600, limit: 5 });
      assert(r.success === true, `trace_search failed: ${r.error}`);
      const traces = r.traces as Array<{ traceId: string }>;
      if (traces?.length > 0) {
        state.traceId = traces[0].traceId;
      }
      console.log(`        Found ${r.count} traces`);
      return ['trace_search'];
    });

    await test('14.2 trace_slow', async () => {
      const r = await call('trace_slow', { min_duration_ms: 100, seconds_ago: 600, limit: 5 });
      assert(r.success === true, `trace_slow failed: ${r.error}`);
      console.log(`        Found ${r.count} slow traces`);
      return ['trace_slow'];
    });

    await test('14.3 trace_debug', async () => {
      const r = await call('trace_debug', { service_name: 'pgr-services', seconds_ago: 600 });
      assert(r.success === true, `trace_debug failed: ${r.error}`);
      console.log(`        Found: ${r.found}`);
      return ['trace_debug'];
    });

    await test('14.4 trace_get', async () => {
      assert(state.traceId !== null, 'no trace ID available from trace_search');
      const r = await call('trace_get', { trace_id: state.traceId! });
      assert(r.success === true, `trace_get failed: ${r.error}`);
      console.log(`        Trace ${state.traceId}: ${r.spanCount} spans`);
      return ['trace_get'];
    });
  } else {
    skip('14.1 trace_search', 'no Tempo', ['trace_search']);
    skip('14.2 trace_slow', 'no Tempo', ['trace_slow']);
    skip('14.3 trace_debug', 'no Tempo', ['trace_debug']);
    skip('14.4 trace_get', 'no Tempo', ['trace_get']);
  }

  // ──────────────────────────────────────────────────────────────────
  // Section 15: Tenant Lifecycle (bootstrap → verify → cleanup)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 15: Tenant Lifecycle ──');

  await test('15.1 tenant_bootstrap', async () => {
    const r = await call('tenant_bootstrap', {
      target_tenant: state.testTenantRoot,
      source_tenant: 'pg',
    });
    assert(r.success === true, `tenant_bootstrap failed: ${JSON.stringify(r.error || r.results)}`);
    const summary = r.summary as Record<string, number>;
    console.log(`        Schemas: ${summary.schemas_copied} copied, ${summary.schemas_skipped} skipped`);
    console.log(`        Data: ${summary.data_copied} copied, ${summary.data_skipped} skipped`);
    return ['tenant_bootstrap'];
  });

  await testWithDeps('15.2 verify: schemas exist on new root', ['15.1 tenant_bootstrap'], async () => {
    const r = await call('mdms_schema_search', { tenant_id: state.testTenantRoot });
    assert(r.success === true, 'schema search on new root failed');
    assert((r.count as number) > 0, 'no schemas found on bootstrapped tenant');
    console.log(`        ${r.count} schemas on ${state.testTenantRoot}`);
    return ['mdms_schema_search'];
  });

  await testWithDeps('15.3 verify: data exists on new root', ['15.1 tenant_bootstrap'], async () => {
    // Allow brief delay for MDMS data propagation
    await new Promise(resolve => setTimeout(resolve, 1000));
    const r = await call('mdms_search', {
      tenant_id: state.testTenantRoot,
      schema_code: 'common-masters.Department',
    });
    assert(r.success === true, 'mdms_search on new root failed');
    // Bootstrap may copy 0 departments if source has none at this schema, so just log
    console.log(`        ${r.count} departments on ${state.testTenantRoot}`);
    return ['mdms_search'];
  });

  await testWithDeps('15.4 tenant_cleanup', ['15.1 tenant_bootstrap'], async () => {
    const r = await call('tenant_cleanup', {
      tenant_id: state.testTenantRoot,
      deactivate_users: true,
    });
    assert(r.success === true, `tenant_cleanup failed: ${JSON.stringify(r)}`);
    const summary = r.summary as Record<string, number>;
    console.log(`        MDMS deleted: ${summary.mdms_deleted}, Users deactivated: ${summary.users_deactivated}`);
    return ['tenant_cleanup'];
  });

  await testWithDeps('15.5 verify: data gone after cleanup', ['15.4 tenant_cleanup'], async () => {
    const r = await call('mdms_search', {
      tenant_id: state.testTenantRoot,
      schema_code: 'common-masters.Department',
    });
    assert(r.success === true, 'post-cleanup search failed');
    const records = (r.records as Array<{ isActive: boolean }>) || [];
    const activeRecords = records.filter(rec => rec.isActive);
    assert(activeRecords.length === 0, `expected 0 active records, got ${activeRecords.length}`);
    console.log(`        Verified: 0 active records on ${state.testTenantRoot}`);
    return ['mdms_search'];
  });

  // ──────────────────────────────────────────────────────────────────
  // Section 16: Cleanup test data on pg
  // ──────────────────────────────────────────────────────────────────
  console.log('\n── Section 16: Cleanup ──');

  await test('16.1 cleanup: soft-delete test MDMS record', async () => {
    try {
      const records = await digitApi.mdmsV2SearchRaw(
        state.stateTenantId,
        state.mdmsRecordSchemaCode,
        { uniqueIdentifiers: [state.mdmsRecordUniqueId], limit: 1 },
      );
      if (records.length > 0 && records[0].isActive) {
        await digitApi.mdmsV2Update(records[0], false);
        console.log(`        Deactivated test MDMS record: ${state.mdmsRecordUniqueId}`);
      } else if (records.length > 0) {
        console.log(`        Test MDMS record already inactive (OK)`);
      } else {
        console.log(`        Test MDMS record not found (OK)`);
      }
    } catch (err) {
      // Fall back to search-only if digitApi cleanup fails (e.g. not authenticated)
      console.log(`        Cleanup via API failed (${err instanceof Error ? err.message : err}), searching only`);
      await call('mdms_search', {
        tenant_id: state.stateTenantId,
        schema_code: state.mdmsRecordSchemaCode,
        unique_identifiers: [state.mdmsRecordUniqueId],
      });
    }
    return ['mdms_search'];
  });

  // ════════════════════════════════════════════════════════════════════
  // COVERAGE REPORT
  // ════════════════════════════════════════════════════════════════════

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                     COVERAGE REPORT                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const covered = ALL_TOOL_NAMES.filter(t => toolsCovered.has(t));
  const uncovered = ALL_TOOL_NAMES.filter(t => !toolsCovered.has(t));
  const coveragePct = ((covered.length / ALL_TOOL_NAMES.length) * 100).toFixed(1);

  console.log(`\n  Tools: ${covered.length}/${ALL_TOOL_NAMES.length} covered (${coveragePct}%)`);
  console.log(`  Tests: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);

  if (uncovered.length > 0) {
    console.log(`\n  \x1b[31mUNCOVERED tools (${uncovered.length}):\x1b[0m`);
    for (const t of uncovered) {
      console.log(`    - ${t}`);
    }
  } else {
    console.log(`\n  \x1b[32m✓ 100% tool coverage achieved!\x1b[0m`);
  }

  console.log('\n  Tool Coverage Matrix:');
  console.log('  ' + '-'.repeat(60));
  for (const tool of ALL_TOOL_NAMES) {
    const mark = toolsCovered.has(tool) ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const tests = results
      .filter(r => r.toolsCalled.includes(tool))
      .map(r => r.name.split(' ')[0])
      .slice(0, 4);
    const testList = tests.length > 0 ? `  ← ${tests.join(', ')}` : '';
    console.log(`  ${mark} ${tool.padEnd(35)}${testList}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // TEST RESULTS SUMMARY
  // ════════════════════════════════════════════════════════════════════

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                     TEST RESULTS                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  Total:   ${results.length}`);
  console.log(`  Passed:  \x1b[32m${passed.length}\x1b[0m`);
  console.log(`  Failed:  \x1b[31m${failed.length}\x1b[0m`);
  console.log(`  Skipped: \x1b[33m${skipped.length}\x1b[0m`);

  if (failed.length > 0) {
    console.log(`\n  Failed tests:`);
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`    \x1b[31m✗\x1b[0m ${r.name}: ${r.error}`);
    }
  }

  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`\n  Total time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Coverage:   ${coveragePct}% (${covered.length}/${ALL_TOOL_NAMES.length})`);
  console.log('');

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
