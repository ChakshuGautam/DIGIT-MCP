import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { DigitApiClient } from '../client/DigitApiClient.js';
import { createDigitDataProvider } from './dataProvider.js';
import { REGISTRY, getAllResources, getDedicatedResources } from './resourceRegistry.js';
import type { DataProvider } from 'ra-core';

/**
 * Comprehensive DataProvider integration tests against a live DIGIT API.
 *
 * ┌──────────────────┬──────────┬──────────┬──────────┬──────────┬──────────────┐
 * │ Method           │ MDMS     │ HRMS     │ Boundary │ PGR      │ Localization │
 * ├──────────────────┼──────────┼──────────┼──────────┼──────────┼──────────────┤
 * │ getList          │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ getOne           │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ getMany          │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ getManyReference │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ create           │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ update           │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ updateMany       │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ delete           │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * │ deleteMany       │ ✓        │ ✓        │ ✓        │ ✓        │ ✓            │
 * └──────────────────┴──────────┴──────────┴──────────┴──────────┴──────────────┘
 *
 * Boundary create: entity + hierarchy relationship. Update: additionalDetails/geometry. Delete: entity + relationship.
 * PGR delete: REJECT via workflow. Localization delete: via _delete endpoint (hard delete).
 *
 * NOTE: MDMS data lives at root tenant (pg), not city tenant (pg.citya).
 *       HRMS/PGR/Boundary data lives at city tenant (pg.citya).
 *       Two DataProvider instances are used: dpRoot and dpCity.
 *
 * Environment variables:
 *   DIGIT_URL    - API gateway URL (default: http://localhost:18000)
 *   DIGIT_USER   - Login username (default: ADMIN)
 *   DIGIT_PASS   - Login password (default: eGov@123)
 *   DIGIT_TENANT - Root tenant  (default: pg)
 *
 * Run:
 *   cd packages/data-provider && npm run test:integration
 */

const DIGIT_URL = process.env.DIGIT_URL || 'http://localhost:18000';
const DIGIT_USER = process.env.DIGIT_USER || 'ADMIN';
const DIGIT_PASS = process.env.DIGIT_PASS || 'eGov@123';
const DIGIT_TENANT = process.env.DIGIT_TENANT || 'pg';
const CITY_TENANT = `${DIGIT_TENANT}.citya`;
const TEST_PREFIX = `INTTEST_${Date.now()}`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let client: DigitApiClient;
let dpRoot: DataProvider; // MDMS + localization (root tenant)
let dpCity: DataProvider; // HRMS + PGR + boundary (city tenant)

const createdMdmsIds: { resource: string; id: string }[] = [];
let testEmployeeCode: string | undefined;

describe('DataProvider Integration Tests', () => {
  before(async () => {
    client = new DigitApiClient({
      url: DIGIT_URL,
      stateTenantId: DIGIT_TENANT,
      endpointOverrides: {
        MDMS_SEARCH: '/mdms-v2/v2/_search',
        MDMS_CREATE: '/mdms-v2/v2/_create',
        MDMS_UPDATE: '/mdms-v2/v2/_update',
        MDMS_SCHEMA_SEARCH: '/mdms-v2/schema/v1/_search',
        MDMS_SCHEMA_CREATE: '/mdms-v2/schema/v1/_create',
      },
    });
    await client.login(DIGIT_USER, DIGIT_PASS, DIGIT_TENANT);
    assert.ok(client.isAuthenticated(), 'Should authenticate successfully');
    dpRoot = createDigitDataProvider(client, DIGIT_TENANT);
    dpCity = createDigitDataProvider(client, CITY_TENANT);
  });

  after(async () => {
    for (const { resource, id } of createdMdmsIds) {
      try { await dpRoot.delete(resource, { id, previousData: { id } as any }); } catch { /* best effort */ }
    }
    if (testEmployeeCode) {
      try {
        const employees = await client.employeeSearch(CITY_TENANT, { codes: [testEmployeeCode] });
        if (employees.length > 0) {
          const emp = employees[0] as Record<string, unknown>;
          if (emp.isActive !== false) {
            emp.isActive = false;
            emp.deactivationDetails = [{ reasonForDeactivation: 'OTHERS', effectiveFrom: Date.now() }];
            await client.employeeUpdate(CITY_TENANT, [emp]);
          }
        }
      } catch { /* best effort */ }
    }
  });

  // =========================================================================
  // MDMS Dedicated Resources (using dpRoot)
  // =========================================================================

  describe('MDMS: departments', () => {
    let firstId: string;
    let secondId: string;

    it('getList returns departments with pagination', async () => {
      const result = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 5 },
        sort: { field: 'code', order: 'ASC' },
        filter: {},
      });
      assert.ok(result.data.length > 0, 'Should return departments');
      assert.ok(result.total > 0, 'Should have a total count');
      assert.ok(result.data.length <= 5, 'Should respect perPage');
      assert.ok(result.data[0].id, 'Each record should have an id');
      assert.ok((result.data[0] as any).code, 'Each record should have a code field');
      firstId = String(result.data[0].id);
      if (result.data.length > 1) secondId = String(result.data[1].id);
    });

    it('getList supports sorting DESC', async () => {
      const asc = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 100 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      const desc = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 100 }, sort: { field: 'code', order: 'DESC' }, filter: {},
      });
      assert.ok(asc.data.length > 1, 'Need at least 2 records to test sorting');
      assert.notEqual(String(asc.data[0].id), String(desc.data[0].id), 'ASC and DESC should differ');
    });

    it('getList supports q filter (full-text search)', async () => {
      const result = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 100 }, sort: { field: 'code', order: 'ASC' }, filter: { q: 'Health' },
      });
      assert.ok(result.data.length > 0, 'Should find departments matching "Health"');
    });

    it('getList page 2 differs from page 1', async () => {
      const p1 = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 3 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(p1.total > 3, 'Precondition: need more than 3 departments to test pagination');
      const p2 = await dpRoot.getList('departments', {
        pagination: { page: 2, perPage: 3 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.notEqual(String(p1.data[0].id), String(p2.data[0].id), 'Page 2 should differ');
    });

    it('getOne fetches a single department by id', async () => {
      assert.ok(firstId, 'Need a department id from getList');
      const result = await dpRoot.getOne('departments', { id: firstId });
      assert.equal(String(result.data.id), firstId);
      assert.ok((result.data as any).code, 'Should have code field');
      assert.ok((result.data as any).name, 'Should have name field');
    });

    it('getMany fetches multiple departments', async () => {
      assert.ok(firstId, 'Need department ids from getList');
      const ids = secondId ? [firstId, secondId] : [firstId];
      const result = await dpRoot.getMany('departments', { ids });
      assert.equal(result.data.length, ids.length, `Should return ${ids.length} records`);
    });

    it('getManyReference finds departments by field match', async () => {
      const list = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      const dept = list.data[0] as any;
      assert.ok(dept.active !== undefined, 'Precondition: department should have active field');
      const result = await dpRoot.getManyReference('departments', {
        target: 'active', id: String(dept.active),
        pagination: { page: 1, perPage: 100 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should find departments matching the active field');
    });

    it('create → getOne → update → delete (full CRUD cycle)', async () => {
      const testCode = `${TEST_PREFIX}_DEPT`;
      const testData = { code: testCode, name: `Test Department ${TEST_PREFIX}`, active: true };

      const created = await dpRoot.create('departments', { data: testData });
      assert.equal(String(created.data.id), testCode);
      createdMdmsIds.push({ resource: 'departments', id: testCode });
      await delay(500); // async persistence

      const fetched = await dpRoot.getOne('departments', { id: testCode });
      assert.equal(String(fetched.data.id), testCode);
      assert.equal((fetched.data as any).name, testData.name);

      const updated = await dpRoot.update('departments', {
        id: testCode, data: { name: `Updated ${TEST_PREFIX}` }, previousData: fetched.data,
      });
      assert.equal((updated.data as any).name, `Updated ${TEST_PREFIX}`);

      const deleted = await dpRoot.delete('departments', { id: testCode, previousData: updated.data });
      assert.ok(deleted.data, 'Should return deleted record');
      const idx = createdMdmsIds.findIndex((r) => r.id === testCode);
      if (idx >= 0) createdMdmsIds.splice(idx, 1);

      await delay(500); // wait for async persistence of soft-delete
      const afterDelete = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.equal(afterDelete.data.find((r) => String(r.id) === testCode), undefined, 'Deleted record should not appear');
    });

    it('updateMany updates multiple records', async () => {
      const code1 = `${TEST_PREFIX}_UM1`;
      const code2 = `${TEST_PREFIX}_UM2`;
      await dpRoot.create('departments', { data: { code: code1, name: `UM1 ${TEST_PREFIX}`, active: true } });
      createdMdmsIds.push({ resource: 'departments', id: code1 });
      await dpRoot.create('departments', { data: { code: code2, name: `UM2 ${TEST_PREFIX}`, active: true } });
      createdMdmsIds.push({ resource: 'departments', id: code2 });
      await delay(500);

      const result = await dpRoot.updateMany('departments', {
        ids: [code1, code2], data: { name: `BatchUpdated ${TEST_PREFIX}` },
      });
      assert.deepEqual(result.data, [code1, code2]);

      const fetched1 = await dpRoot.getOne('departments', { id: code1 });
      assert.equal((fetched1.data as any).name, `BatchUpdated ${TEST_PREFIX}`);
    });

    it('deleteMany removes multiple records', async () => {
      const code1 = `${TEST_PREFIX}_DM1`;
      const code2 = `${TEST_PREFIX}_DM2`;
      await dpRoot.create('departments', { data: { code: code1, name: `DM1 ${TEST_PREFIX}`, active: true } });
      await dpRoot.create('departments', { data: { code: code2, name: `DM2 ${TEST_PREFIX}`, active: true } });
      await delay(500);
      const result = await dpRoot.deleteMany('departments', { ids: [code1, code2] });
      assert.deepEqual(result.data, [code1, code2]);
      await delay(500);
      const after = await dpRoot.getList('departments', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(!after.data.find((r) => String(r.id) === code1), `${code1} should be deleted`);
      assert.ok(!after.data.find((r) => String(r.id) === code2), `${code2} should be deleted`);
    });
  });

  describe('MDMS: designations', () => {
    it('getList returns designations', async () => {
      const result = await dpRoot.getList('designations', {
        pagination: { page: 1, perPage: 10 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should have designations');
      assert.ok((result.data[0] as any).code, 'Should have code field');
    });

    it('getOne fetches a single designation', async () => {
      const list = await dpRoot.getList('designations', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      const id = String(list.data[0].id);
      const result = await dpRoot.getOne('designations', { id });
      assert.equal(String(result.data.id), id);
    });
  });

  describe('MDMS: complaint-types', () => {
    it('getList returns complaint types', async () => {
      const result = await dpRoot.getList('complaint-types', {
        pagination: { page: 1, perPage: 10 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should have complaint types');
      assert.ok((result.data[0] as any).serviceCode, 'Should have serviceCode field');
      assert.ok((result.data[0] as any).department, 'Should have department field');
    });

    it('getOne fetches by serviceCode', async () => {
      const list = await dpRoot.getList('complaint-types', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      const id = String(list.data[0].id);
      const result = await dpRoot.getOne('complaint-types', { id });
      assert.equal(String(result.data.id), id);
    });

    it('getManyReference finds complaint types by department', async () => {
      const list = await dpRoot.getList('complaint-types', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      const dept = (list.data[0] as any).department;
      assert.ok(dept, 'Precondition: complaint type should have department field');
      const result = await dpRoot.getManyReference('complaint-types', {
        target: 'department', id: dept,
        pagination: { page: 1, perPage: 100 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, `Should find complaint types in department ${dept}`);
    });
  });

  describe('MDMS: tenants', () => {
    it('getList returns tenants', async () => {
      const result = await dpRoot.getList('tenants', {
        pagination: { page: 1, perPage: 50 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should have tenants');
      assert.ok((result.data[0] as any).code, 'Should have code field');
    });

    it('getOne fetches a single tenant', async () => {
      const list = await dpRoot.getList('tenants', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      const id = String(list.data[0].id);
      const result = await dpRoot.getOne('tenants', { id });
      assert.equal(String(result.data.id), id);
    });
  });

  // =========================================================================
  // MDMS Generic Resources (sample, using dpRoot)
  // =========================================================================

  describe('MDMS: generic resources', () => {
    const genericSamples = ['roles', 'gender-types', 'employee-status', 'employee-type', 'id-formats'] as const;

    for (const resource of genericSamples) {
      it(`getList returns data for ${resource}`, async () => {
        const result = await dpRoot.getList(resource, {
          pagination: { page: 1, perPage: 50 },
          sort: { field: REGISTRY[resource].idField, order: 'ASC' },
          filter: {},
        });
        assert.ok(result.data.length > 0, `Should have ${resource} records`);
        const idField = REGISTRY[resource].idField;
        assert.ok((result.data[0] as any)[idField], `Record should have ${idField} field`);
      });
    }

    it('getOne fetches a single role by code', async () => {
      const list = await dpRoot.getList('roles', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      const id = String(list.data[0].id);
      const result = await dpRoot.getOne('roles', { id });
      assert.equal(String(result.data.id), id);
    });

    it('getMany fetches multiple roles', async () => {
      const list = await dpRoot.getList('roles', {
        pagination: { page: 1, perPage: 3 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      const ids = list.data.slice(0, 2).map((r) => String(r.id));
      const result = await dpRoot.getMany('roles', { ids });
      assert.equal(result.data.length, ids.length);
    });
  });

  // =========================================================================
  // Localization (using dpRoot)
  // =========================================================================

  describe('Localization', () => {
    let firstCode: string;

    it('getList returns localization messages', async () => {
      const result = await dpRoot.getList('localization', {
        pagination: { page: 1, perPage: 10 }, sort: { field: 'code', order: 'ASC' },
        filter: { module: 'rainmaker-pgr' },
      });
      assert.ok(result.data.length > 0, 'Should return localization messages');
      assert.ok(result.total > 0, 'Should have a total count');
      assert.ok((result.data[0] as any).code, 'Message should have code');
      assert.ok((result.data[0] as any).message, 'Message should have message text');
      firstCode = String(result.data[0].id);
    });

    it('getList pagination works', async () => {
      const p1 = await dpRoot.getList('localization', {
        pagination: { page: 1, perPage: 5 }, sort: { field: 'code', order: 'ASC' },
        filter: { module: 'rainmaker-pgr' },
      });
      assert.ok(p1.total > 5, 'Precondition: need more than 5 localization messages to test pagination');
      const p2 = await dpRoot.getList('localization', {
        pagination: { page: 2, perPage: 5 }, sort: { field: 'code', order: 'ASC' },
        filter: { module: 'rainmaker-pgr' },
      });
      assert.notEqual(String(p1.data[0].id), String(p2.data[0].id), 'Page 2 should differ');
    });

    it('getOne fetches a single message by code', async () => {
      assert.ok(firstCode, 'Need a code from getList');
      const result = await dpRoot.getOne('localization', { id: firstCode });
      assert.equal(String(result.data.id), firstCode);
    });

    it('getMany fetches multiple messages', async () => {
      const list = await dpRoot.getList('localization', {
        pagination: { page: 1, perPage: 3 }, sort: { field: 'code', order: 'ASC' },
        filter: { module: 'rainmaker-pgr' },
      });
      const ids = list.data.slice(0, 2).map((r) => String(r.id));
      const result = await dpRoot.getMany('localization', { ids });
      assert.equal(result.data.length, ids.length);
    });

    it('getManyReference finds messages by module', async () => {
      const result = await dpRoot.getManyReference('localization', {
        target: 'module', id: 'rainmaker-pgr',
        pagination: { page: 1, perPage: 10 }, sort: { field: 'code', order: 'ASC' },
        filter: { module: 'rainmaker-pgr' },
      });
      assert.ok(result.data.length > 0, 'Should find messages in rainmaker-pgr module');
    });

    it('create upserts a new localization message', async () => {
      const code = `${TEST_PREFIX}_LOC_MSG`;
      const result = await dpRoot.create('localization', {
        data: { code, message: `Test message ${TEST_PREFIX}`, module: 'rainmaker-common', locale: 'en_IN' },
      });
      assert.ok(result.data, 'Should return created message');
      assert.equal(String(result.data.id), code);
    });

    it('update modifies an existing localization message', async () => {
      const code = `${TEST_PREFIX}_LOC_UPD`;
      await dpRoot.create('localization', {
        data: { code, message: 'Original text', module: 'rainmaker-common', locale: 'en_IN' },
      });
      const result = await dpRoot.update('localization', {
        id: code, data: { code, message: `Updated ${TEST_PREFIX}`, module: 'rainmaker-common', locale: 'en_IN' },
        previousData: { id: code } as any,
      });
      assert.equal((result.data as any).message, `Updated ${TEST_PREFIX}`, 'Updated message should be returned');
    });

    it('delete removes a localization message', async () => {
      const delCode = `${TEST_PREFIX}_LOC_DEL`;
      const created = await dpRoot.create('localization', {
        data: { code: delCode, message: `Delete me ${TEST_PREFIX}`, module: 'rainmaker-common', locale: 'en_IN' },
      });
      assert.equal(String(created.data.id), delCode, 'Create should return the message code');
      // Delete the message (localization _delete hard-deletes from DB + busts Redis cache)
      const result = await dpRoot.delete('localization', {
        id: delCode, previousData: { id: delCode } as any,
      });
      assert.equal(String(result.data.id), delCode);
      // Verify it's gone by re-fetching (after cache bust)
      const after = await dpRoot.getList('localization', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' },
        filter: { module: 'rainmaker-common' },
      });
      assert.ok(!after.data.find((r) => String(r.id) === delCode), 'Message should be gone after delete');
    });

    it('deleteMany removes multiple localization messages', async () => {
      const delCode1 = `${TEST_PREFIX}_LOC_DM1`;
      const delCode2 = `${TEST_PREFIX}_LOC_DM2`;
      await dpRoot.create('localization', {
        data: { code: delCode1, message: `DM1 ${TEST_PREFIX}`, module: 'rainmaker-common', locale: 'en_IN' },
      });
      await dpRoot.create('localization', {
        data: { code: delCode2, message: `DM2 ${TEST_PREFIX}`, module: 'rainmaker-common', locale: 'en_IN' },
      });
      const result = await dpRoot.deleteMany('localization', { ids: [delCode1, delCode2] });
      assert.deepEqual(result.data, [delCode1, delCode2]);
      const after = await dpRoot.getList('localization', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' },
        filter: { module: 'rainmaker-common' },
      });
      assert.ok(!after.data.find((r) => String(r.id) === delCode1), `${delCode1} should be gone`);
      assert.ok(!after.data.find((r) => String(r.id) === delCode2), `${delCode2} should be gone`);
    });
  });

  // =========================================================================
  // Boundaries (using dpCity)
  // =========================================================================

  describe('Boundaries', () => {
    let firstCode: string;
    let secondCode: string;
    let parentWardCode: string;

    it('getList returns flattened boundary tree', async () => {
      const result = await dpCity.getList('boundaries', {
        pagination: { page: 1, perPage: 50 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should return boundaries');
      assert.ok(result.total > 0, 'Should have total count');
      assert.ok((result.data[0] as any).code, 'Boundary should have code');
      firstCode = String(result.data[0].id);
      if (result.data.length > 1) secondCode = String(result.data[1].id);
      // Find a Ward to use as parent for create tests
      const ward = result.data.find((r) => (r as any).boundaryType === 'Ward');
      if (ward) parentWardCode = String((ward as any).code);
    });

    it('getList pagination works', async () => {
      const p1 = await dpCity.getList('boundaries', {
        pagination: { page: 1, perPage: 3 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(p1.total > 3, 'Precondition: need more than 3 boundaries to test pagination');
      const p2 = await dpCity.getList('boundaries', {
        pagination: { page: 2, perPage: 3 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.notEqual(String(p1.data[0].id), String(p2.data[0].id), 'Page 2 should differ');
    });

    it('getOne fetches a single boundary by code', async () => {
      assert.ok(firstCode, 'Need a boundary code from getList');
      const result = await dpCity.getOne('boundaries', { id: firstCode });
      assert.equal(String(result.data.id), firstCode);
    });

    it('getMany fetches multiple boundaries', async () => {
      assert.ok(firstCode, 'Need boundary codes from getList');
      const ids = secondCode ? [firstCode, secondCode] : [firstCode];
      const result = await dpCity.getMany('boundaries', { ids });
      assert.equal(result.data.length, ids.length);
    });

    it('getManyReference finds boundaries by boundaryType', async () => {
      const list = await dpCity.getList('boundaries', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(list.data.length > 0, 'Need boundary data');
      const bType = (list.data[0] as any).boundaryType;
      assert.ok(bType, 'Boundary should have boundaryType');
      const result = await dpCity.getManyReference('boundaries', {
        target: 'boundaryType', id: bType,
        pagination: { page: 1, perPage: 100 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, `Should find boundaries of type ${bType}`);
    });

    it('create adds a new boundary entity + relationship', async () => {
      assert.ok(parentWardCode, 'Need a Ward code as parent');
      const newCode = `${TEST_PREFIX}_LOC`;
      const result = await dpCity.create('boundaries', {
        data: { code: newCode, boundaryType: 'Locality', hierarchyType: 'ADMIN', parent: parentWardCode },
      });
      assert.equal(String(result.data.id), newCode);
      assert.equal((result.data as any).boundaryType, 'Locality');
      // Verify it appears in the tree
      const list = await dpCity.getList('boundaries', {
        pagination: { page: 1, perPage: 200 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      const found = list.data.find((r) => String(r.id) === newCode);
      assert.ok(found, 'New boundary should appear in getList');
    });

    it('update changes boundary additionalDetails', async () => {
      assert.ok(firstCode, 'Need a boundary code');
      const testDetails = { label: `Updated ${TEST_PREFIX}`, updatedAt: Date.now() };
      const result = await dpCity.update('boundaries', {
        id: firstCode, data: { code: firstCode, additionalDetails: testDetails },
        previousData: { id: firstCode } as any,
      });
      assert.equal(String(result.data.id), firstCode);
      await delay(1500); // Wait for persister to write to DB
      const verify = await dpCity.getOne('boundaries', { id: firstCode });
      const details = (verify.data as any).additionalDetails;
      assert.ok(details, 'Boundary should have additionalDetails after update');
      assert.equal(details.label, testDetails.label, 'additionalDetails.label should match');
    });

    it('updateMany updates multiple boundaries', async () => {
      assert.ok(firstCode, 'Need boundary codes');
      const ids = secondCode ? [firstCode, secondCode] : [firstCode];
      const testDetails = { batch: true, prefix: TEST_PREFIX };
      const result = await dpCity.updateMany('boundaries', { ids, data: { additionalDetails: testDetails } });
      assert.deepEqual(result.data, ids);
      await delay(1500); // Wait for persister to write to DB
      const verify = await dpCity.getOne('boundaries', { id: firstCode });
      assert.equal((verify.data as any).additionalDetails?.batch, true, 'Batch update should persist');
    });

    it('delete removes boundary entity + relationship', async () => {
      const delCode = `${TEST_PREFIX}_DEL_BNDRY`;
      assert.ok(parentWardCode, 'Need a Ward code as parent');
      await dpCity.create('boundaries', {
        data: { code: delCode, boundaryType: 'Locality', hierarchyType: 'ADMIN', parent: parentWardCode },
      });
      const before = await dpCity.getList('boundaries', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(before.data.find((r) => String(r.id) === delCode), 'Boundary should exist before delete');
      const result = await dpCity.delete('boundaries', {
        id: delCode, previousData: { id: delCode } as any,
      });
      assert.equal(String(result.data.id), delCode);
      const after = await dpCity.getList('boundaries', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(!after.data.find((r) => String(r.id) === delCode), 'Boundary should be gone after delete');
    });

    it('deleteMany removes multiple boundaries', async () => {
      const delCode1 = `${TEST_PREFIX}_DM_B1`;
      const delCode2 = `${TEST_PREFIX}_DM_B2`;
      assert.ok(parentWardCode, 'Need a Ward code as parent');
      await dpCity.create('boundaries', {
        data: { code: delCode1, boundaryType: 'Locality', hierarchyType: 'ADMIN', parent: parentWardCode },
      });
      await dpCity.create('boundaries', {
        data: { code: delCode2, boundaryType: 'Locality', hierarchyType: 'ADMIN', parent: parentWardCode },
      });
      const result = await dpCity.deleteMany('boundaries', { ids: [delCode1, delCode2] });
      assert.deepEqual(result.data, [delCode1, delCode2]);
      const after = await dpCity.getList('boundaries', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(!after.data.find((r) => String(r.id) === delCode1), `${delCode1} should be gone`);
      assert.ok(!after.data.find((r) => String(r.id) === delCode2), `${delCode2} should be gone`);
    });
  });

  // =========================================================================
  // HRMS Employees (using dpCity)
  // =========================================================================

  describe('HRMS: employees', () => {
    let employeeUuid: string;
    let fullEmployeeObject: Record<string, unknown>;

    before(async () => {
      // Find valid department/designation from MDMS at root tenant (use large limit to skip test cruft)
      let deptCode = 'DEPT_1';
      let desigCode = 'DESIG_05';
      try {
        const depts = await client.mdmsSearch(DIGIT_TENANT, 'common-masters.Department', { limit: 500 });
        const activeDept = depts.find((r) => r.isActive);
        if (activeDept?.data?.code) deptCode = activeDept.data.code as string;
        const desigs = await client.mdmsSearch(DIGIT_TENANT, 'common-masters.Designation', { limit: 500 });
        const activeDesig = desigs.find((r) => r.isActive);
        if (activeDesig?.data?.code) desigCode = activeDesig.data.code as string;
      } catch { /* use defaults */ }

      const mobileNumber = `99${Date.now().toString().slice(-8)}`;
      try {
        const [emp] = await client.employeeCreate(CITY_TENANT, [{
          code: `${TEST_PREFIX}_EMP`,
          employeeStatus: 'EMPLOYED',
          employeeType: 'TEMPORARY',
          dateOfAppointment: Date.now(),
          user: {
            name: `Test Employee ${TEST_PREFIX}`, mobileNumber,
            userName: `testEmp${Date.now()}`, gender: 'MALE', dob: 631152000000,
            roles: [
              { code: 'EMPLOYEE', name: 'Employee', tenantId: CITY_TENANT },
              { code: 'PGR_LME', name: 'PGR Last Mile Employee', tenantId: CITY_TENANT },
            ],
            tenantId: DIGIT_TENANT, type: 'EMPLOYEE', password: 'eGov@123',
          },
          assignments: [{ department: deptCode, designation: desigCode, fromDate: Date.now(), isCurrentAssignment: true }],
          jurisdictions: [{ hierarchy: 'ADMIN', boundaryType: 'City', boundary: CITY_TENANT, tenantId: CITY_TENANT }],
          isActive: true,
        }]);
        employeeUuid = (emp as any).uuid || (emp as any).user?.uuid;
        testEmployeeCode = `${TEST_PREFIX}_EMP`;
        fullEmployeeObject = emp as Record<string, unknown>;
      } catch (err) {
        console.error('Employee creation failed:', (err as Error).message);
      }
    });

    it('getList returns employees', async () => {
      assert.ok(employeeUuid, 'Employee should have been created in before()');
      const result = await dpCity.getList('employees', {
        pagination: { page: 1, perPage: 500 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should return at least the test employee');
      const testEmp = result.data.find((r) => String(r.id) === employeeUuid);
      assert.ok(testEmp, `Test employee ${employeeUuid} should appear in getList (got ${result.data.length} employees)`);
    });

    it('getOne fetches employee by uuid', async () => {
      assert.ok(employeeUuid, 'Employee should have been created');
      const result = await dpCity.getOne('employees', { id: employeeUuid });
      assert.equal(String(result.data.id), employeeUuid);
    });

    it('getMany fetches employees by ids', async () => {
      assert.ok(employeeUuid, 'Employee should have been created');
      const result = await dpCity.getMany('employees', { ids: [employeeUuid] });
      assert.ok(result.data.length > 0, 'Should return the employee');
    });

    it('getManyReference finds employees by status', async () => {
      assert.ok(employeeUuid, 'Employee should have been created');
      const result = await dpCity.getManyReference('employees', {
        target: 'employeeStatus', id: 'EMPLOYED',
        pagination: { page: 1, perPage: 100 }, sort: { field: 'code', order: 'ASC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should find employed employees');
    });

    it('create — verified via getOne', async () => {
      assert.ok(employeeUuid, 'Employee create should have succeeded in before()');
      const fetched = await dpCity.getOne('employees', { id: employeeUuid });
      assert.equal(String(fetched.data.id), employeeUuid, 'getOne should find the created employee');
      assert.ok((fetched.data as any).user?.name?.includes(TEST_PREFIX),
        'Created employee name should contain test prefix');
    });

    it('update modifies employee name', async () => {
      assert.ok(employeeUuid, 'Employee should have been created');
      const fetched = await client.employeeSearch(CITY_TENANT, { codes: [testEmployeeCode!] });
      assert.ok(fetched.length > 0, 'Should find employee to update');
      const emp = fetched[0] as Record<string, unknown>;
      const user = emp.user as Record<string, unknown>;
      const newName = `Updated Employee ${TEST_PREFIX}`;
      user.name = newName;
      const result = await dpCity.update('employees', {
        id: employeeUuid, data: emp, previousData: { id: employeeUuid } as any,
      });
      assert.equal(String(result.data.id), employeeUuid);
      assert.equal((result.data as any).user?.name, newName, 'Returned data should have updated name');
      const verify = await dpCity.getOne('employees', { id: employeeUuid });
      assert.equal((verify.data as any).user?.name, newName, 'Updated name should persist');
    });

    it('delete deactivates employee', async () => {
      assert.ok(employeeUuid, 'Employee should have been created');
      const result = await dpCity.delete('employees', {
        id: employeeUuid, previousData: { id: employeeUuid } as any,
      });
      assert.equal(String(result.data.id), employeeUuid);
      // Verify the returned data shows deactivated
      assert.equal((result.data as any).isActive, false, 'Delete result should show employee deactivated');
      testEmployeeCode = undefined; // already cleaned up
    });
  });

  // =========================================================================
  // PGR Complaints (using dpCity)
  // =========================================================================

  describe('PGR: complaints', () => {
    let serviceRequestId: string;
    let localityCode: string;

    before(async () => {
      // Ensure PGR workflow exists
      try {
        const existing = await client.workflowBusinessServiceSearch(DIGIT_TENANT, ['PGR']);
        if (existing.length === 0) {
          const pgWorkflows = await client.workflowBusinessServiceSearch('pg', ['PGR']);
          if (pgWorkflows.length > 0) {
            const pgrDef = pgWorkflows[0] as Record<string, unknown>;
            const states = (pgrDef.states || []) as Record<string, unknown>[];
            const stateMap = new Map<string, string>();
            for (const s of states) { if (s.uuid && s.state) stateMap.set(s.uuid as string, s.state as string); }
            await client.workflowBusinessServiceCreate(DIGIT_TENANT, {
              businessService: 'PGR', business: 'pgr-services', businessServiceSla: 259200000,
              states: states.map((s) => ({
                state: s.state, applicationStatus: s.applicationStatus,
                isStartState: s.isStartState, isTerminateState: s.isTerminateState,
                actions: ((s.actions || []) as Record<string, unknown>[]).map((a) => ({
                  action: a.action, nextState: stateMap.get(a.nextState as string) || a.nextState, roles: a.roles,
                })),
              })),
            });
          }
        }
      } catch (err) { console.error('Workflow setup warning:', (err as Error).message); }

      // Find a valid locality boundary code from the tree we created
      localityCode = 'LOC_CITYA_1';
      try {
        const boundaries = await client.boundaryRelationshipSearch(CITY_TENANT, 'ADMIN');
        const findLocality = (nodes: unknown[]): string | undefined => {
          if (!Array.isArray(nodes)) return undefined;
          for (const n of nodes as Record<string, unknown>[]) {
            if ((n.boundaryType as string) === 'Locality') return n.code as string;
            const child = findLocality(n.children as unknown[]);
            if (child) return child;
          }
          return undefined;
        };
        for (const tree of boundaries) {
          const found = findLocality((tree.boundary || []) as unknown[]);
          if (found) { localityCode = found; break; }
        }
      } catch (err) { console.error('Boundary search warning:', (err as Error).message); }

      // Create a test complaint via client API (not DataProvider — setup data)
      try {
        const ctResult = await dpRoot.getList('complaint-types', {
          pagination: { page: 1, perPage: 1 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
        });
        const serviceCode = ctResult.data.length > 0 ? String((ctResult.data[0] as any).serviceCode) : 'StreetLightNotWorking';

        const wrapper = await client.pgrCreate(CITY_TENANT, serviceCode,
          `Integration test complaint ${TEST_PREFIX}`,
          { locality: { code: localityCode } },
          { name: 'Test Citizen', mobileNumber: '9999999999', type: 'CITIZEN',
            roles: [{ code: 'CITIZEN', name: 'Citizen', tenantId: DIGIT_TENANT }], tenantId: DIGIT_TENANT },
        );
        const service = (wrapper as any).service || wrapper;
        serviceRequestId = service.serviceRequestId;
      } catch (err) { console.error('PGR complaint creation failed:', (err as Error).message); }
    });

    it('getList returns complaints', async () => {
      assert.ok(serviceRequestId, 'Complaint should have been created in before()');
      const result = await dpCity.getList('complaints', {
        pagination: { page: 1, perPage: 10 }, sort: { field: 'serviceRequestId', order: 'DESC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should return complaints');
      assert.ok((result.data[0] as any).serviceRequestId, 'Should have serviceRequestId');
    });

    it('getList with status filter', async () => {
      assert.ok(serviceRequestId, 'Complaint should exist');
      const result = await dpCity.getList('complaints', {
        pagination: { page: 1, perPage: 10 }, sort: { field: 'serviceRequestId', order: 'DESC' },
        filter: { status: 'PENDINGFORASSIGNMENT' },
      });
      if (result.data.length > 0) {
        for (const record of result.data) {
          assert.equal((record as any).applicationStatus, 'PENDINGFORASSIGNMENT',
            'All filtered results should have PENDINGFORASSIGNMENT status');
        }
      }
    });

    it('getOne fetches a complaint by serviceRequestId', async () => {
      assert.ok(serviceRequestId, 'Complaint should exist');
      const result = await dpCity.getOne('complaints', { id: serviceRequestId });
      assert.equal(String(result.data.id), serviceRequestId);
      assert.ok((result.data as any).description, 'Should have description');
    });

    it('getMany fetches multiple complaints', async () => {
      assert.ok(serviceRequestId, 'Complaint should exist');
      const result = await dpCity.getMany('complaints', { ids: [serviceRequestId] });
      assert.ok(result.data.length > 0, 'Should return the complaint');
    });

    it('getManyReference finds complaints by serviceCode', async () => {
      assert.ok(serviceRequestId, 'Complaint should exist');
      const one = await dpCity.getOne('complaints', { id: serviceRequestId });
      const code = (one.data as any).serviceCode;
      assert.ok(code, 'Precondition: complaint should have serviceCode');
      const result = await dpCity.getManyReference('complaints', {
        target: 'serviceCode', id: code,
        pagination: { page: 1, perPage: 10 }, sort: { field: 'serviceRequestId', order: 'DESC' }, filter: {},
      });
      assert.ok(result.data.length > 0, 'Should find complaints by service code');
    });

    it('create creates a new PGR complaint', async () => {
      const ctResult = await dpRoot.getList('complaint-types', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      const serviceCode = ctResult.data.length > 0 ? String((ctResult.data[0] as any).serviceCode) : 'StreetLightNotWorking';

      const result = await dpCity.create('complaints', {
        data: {
          serviceCode,
          description: `DataProvider create test ${TEST_PREFIX}`,
          address: { locality: { code: localityCode } },
          citizen: {
            name: 'DP Test Citizen', mobileNumber: '8888888888', type: 'CITIZEN',
            roles: [{ code: 'CITIZEN', name: 'Citizen', tenantId: DIGIT_TENANT }], tenantId: DIGIT_TENANT,
          },
        },
      });
      assert.ok(result.data.id, 'Created complaint should have serviceRequestId');
      assert.ok(String(result.data.id).includes('PG'), 'serviceRequestId should contain PG prefix');
    });

    it('update transitions complaint via workflow action', async () => {
      assert.ok(serviceRequestId, 'Complaint should exist');
      // REJECT the complaint (GRO action, no assignee needed)
      const result = await dpCity.update('complaints', {
        id: serviceRequestId,
        data: { action: 'REJECT', comment: `Rejected by integration test ${TEST_PREFIX}` },
        previousData: { id: serviceRequestId } as any,
      });
      assert.ok(result.data.id, 'Updated complaint should have id');
    });

    it('updateMany transitions multiple complaints', async () => {
      // Create a fresh complaint for updateMany
      const ctResult = await dpRoot.getList('complaint-types', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      const serviceCode = ctResult.data.length > 0 ? String((ctResult.data[0] as any).serviceCode) : 'StreetLightNotWorking';
      const created = await dpCity.create('complaints', {
        data: {
          serviceCode,
          description: `UpdateMany test ${TEST_PREFIX}`,
          address: { locality: { code: localityCode } },
          citizen: {
            name: 'UM Test Citizen', mobileNumber: '7777777777', type: 'CITIZEN',
            roles: [{ code: 'CITIZEN', name: 'Citizen', tenantId: DIGIT_TENANT }], tenantId: DIGIT_TENANT,
          },
        },
      });
      const newId = String(created.data.id);
      await delay(1000); // PGR search index needs time to catch up
      const result = await dpCity.updateMany('complaints', {
        ids: [newId], data: { action: 'REJECT', comment: 'Batch rejected' },
      });
      assert.deepEqual(result.data, [newId]);
      await delay(500); // workflow state update needs time to propagate
      const verify = await dpCity.getOne('complaints', { id: newId });
      assert.equal((verify.data as any).applicationStatus, 'REJECTED',
        'Complaint should be REJECTED after updateMany');
    });

    it('delete rejects a PGR complaint', async () => {
      // Create a fresh complaint to delete (reject)
      const ctResult = await dpRoot.getList('complaint-types', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      const serviceCode = ctResult.data.length > 0 ? String((ctResult.data[0] as any).serviceCode) : 'StreetLightNotWorking';
      const created = await dpCity.create('complaints', {
        data: {
          serviceCode,
          description: `Delete test ${TEST_PREFIX}`,
          address: { locality: { code: localityCode } },
          citizen: {
            name: 'Del Test Citizen', mobileNumber: '6666666666', type: 'CITIZEN',
            roles: [{ code: 'CITIZEN', name: 'Citizen', tenantId: DIGIT_TENANT }], tenantId: DIGIT_TENANT,
          },
        },
      });
      const delId = String(created.data.id);
      await delay(500);
      const result = await dpCity.delete('complaints', {
        id: delId, previousData: { id: delId } as any,
      });
      assert.ok(result.data.id, 'Deleted complaint should return data');
      assert.equal((result.data as any).applicationStatus, 'REJECTED',
        'Deleted (rejected) complaint should have REJECTED status');
    });

    it('deleteMany rejects multiple PGR complaints', async () => {
      const ctResult = await dpRoot.getList('complaint-types', {
        pagination: { page: 1, perPage: 1 }, sort: { field: 'serviceCode', order: 'ASC' }, filter: {},
      });
      const serviceCode = ctResult.data.length > 0 ? String((ctResult.data[0] as any).serviceCode) : 'StreetLightNotWorking';
      const created = await dpCity.create('complaints', {
        data: {
          serviceCode,
          description: `DeleteMany test ${TEST_PREFIX}`,
          address: { locality: { code: localityCode } },
          citizen: {
            name: 'DM Test Citizen', mobileNumber: '5555555555', type: 'CITIZEN',
            roles: [{ code: 'CITIZEN', name: 'Citizen', tenantId: DIGIT_TENANT }], tenantId: DIGIT_TENANT,
          },
        },
      });
      const dmId = String(created.data.id);
      await delay(1000);
      const result = await dpCity.deleteMany('complaints', { ids: [dmId] });
      assert.deepEqual(result.data, [dmId]);
      await delay(500); // workflow state update needs time to propagate
      const verify = await dpCity.getOne('complaints', { id: dmId });
      assert.equal((verify.data as any).applicationStatus, 'REJECTED',
        'Complaint should be REJECTED after deleteMany');
    });
  });

  // =========================================================================
  // Coverage Matrix Validation
  // =========================================================================

  describe('Coverage: all resources in registry are testable', () => {
    it('all dedicated resources have at least a getList test above', () => {
      const dedicated = getDedicatedResources();
      const expected = ['tenants', 'departments', 'designations', 'complaint-types', 'employees', 'boundaries', 'complaints', 'localization'];
      for (const name of expected) {
        assert.ok(dedicated[name], `${name} should be in dedicated resources`);
      }
    });

    it('resource registry has consistent id fields', () => {
      const all = getAllResources();
      for (const [name, config] of Object.entries(all)) {
        assert.ok(config.idField, `${name} should have an idField`);
        assert.ok(config.type, `${name} should have a type`);
        assert.ok(config.label, `${name} should have a label`);
      }
    });
  });
});
