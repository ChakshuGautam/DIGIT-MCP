/**
 * Unit tests for xlsx-reader — pure parsing, no DIGIT API needed.
 * Creates xlsx workbooks programmatically with ExcelJS and verifies parsed output.
 */
import assert from 'node:assert';
import ExcelJS from 'exceljs';
import {
  readTenantInfo,
  readDepartmentsDesignations,
  readComplaintTypes,
  readEmployees,
  excelDateToTimestamp,
  nameToPascalCode,
  nameToUpperSnake,
} from './src/utils/xlsx-reader.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Helper: create workbook with sheet data ──

function createWorkbook(sheets: Record<string, string[][]>): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  for (const [name, data] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of data) {
      ws.addRow(row);
    }
  }
  return wb;
}

// ── Tests ──

async function run() {
  console.log('\n── xlsx-reader unit tests ──\n');

  // ── Helper function tests ──

  await test('nameToPascalCode: basic', () => {
    assert.strictEqual(nameToPascalCode('Road Pothole'), 'RoadPothole');
    assert.strictEqual(nameToPascalCode('garbage not collected'), 'GarbageNotCollected');
    assert.strictEqual(nameToPascalCode('Broken Street-Light'), 'BrokenStreetLight');
  });

  await test('nameToUpperSnake: basic', () => {
    assert.strictEqual(nameToUpperSnake('John Smith'), 'JOHN_SMITH');
    assert.strictEqual(nameToUpperSnake('jane doe'), 'JANE_DOE');
    assert.strictEqual(nameToUpperSnake('Bob'), 'BOB');
  });

  await test('excelDateToTimestamp: Date object', () => {
    const d = new Date('2024-01-15T00:00:00.000Z');
    assert.strictEqual(excelDateToTimestamp(d), d.getTime());
  });

  await test('excelDateToTimestamp: ISO string', () => {
    const ts = excelDateToTimestamp('2024-01-15');
    assert.ok(ts > 0, 'should produce positive timestamp');
    const d = new Date(ts);
    assert.strictEqual(d.getUTCFullYear(), 2024);
    assert.strictEqual(d.getUTCMonth(), 0); // January
    assert.strictEqual(d.getUTCDate(), 15);
  });

  await test('excelDateToTimestamp: Excel serial number', () => {
    // 2024-01-15 = Excel serial 45306
    const ts = excelDateToTimestamp(45306);
    const d = new Date(ts);
    assert.strictEqual(d.getUTCFullYear(), 2024);
    assert.strictEqual(d.getUTCMonth(), 0);
    assert.strictEqual(d.getUTCDate(), 15);
  });

  // ── Tenant Info ──

  await test('readTenantInfo: parses tenant rows', () => {
    const wb = createWorkbook({
      'Tenant Info': [
        ['Tenant Display Name*', 'Tenant Code*', 'Tenant Type*', 'Logo File Path*', 'City Name', 'District Name', 'Latitude', 'Longitude', 'Tenant Website'],
        ['Test City', 'pg.testcity', 'CITY', '/logo.png', 'Test City', 'Test District', '12.5', '77.5', 'https://test.city'],
        ['Another City', 'pg.another', 'CITY', '', 'Another', '', '', '', ''],
      ],
    });

    const { tenants, localizations } = readTenantInfo(wb);

    assert.strictEqual(tenants.length, 2);
    assert.strictEqual(tenants[0].code, 'pgtestcity'); // dots removed, lowercase
    assert.strictEqual(tenants[0].name, 'Test City');
    assert.strictEqual(tenants[0].city.latitude, 12.5);
    assert.strictEqual(tenants[0].domainUrl, 'https://test.city');

    assert.strictEqual(tenants[1].code, 'pganother');
    assert.strictEqual(tenants[1].city.districtName, undefined); // empty → undefined

    assert.strictEqual(localizations.length, 2);
    assert.ok(localizations[0].code.startsWith('TENANT_TENANTS_'));
  });

  await test('readTenantInfo: skips empty rows', () => {
    const wb = createWorkbook({
      'Tenant Info': [
        ['Tenant Display Name*', 'Tenant Code*', 'Tenant Type*'],
        ['Test City', 'tc', 'CITY'],
        ['', '', ''], // empty row
        ['Second City', 'sc', 'CITY'],
      ],
    });

    const { tenants } = readTenantInfo(wb);
    assert.strictEqual(tenants.length, 2);
  });

  await test('readTenantInfo: throws on missing sheet', () => {
    const wb = createWorkbook({ 'Wrong Sheet': [['a']] });
    assert.throws(() => readTenantInfo(wb), /Sheet 'Tenant Info' not found/);
  });

  // ── Departments & Designations ──

  await test('readDepartmentsDesignations: parses and deduplicates', () => {
    const wb = createWorkbook({
      'Department And Designation Master': [
        ['Department Name*', 'Designation Name*', 'Jurisdiction'],
        ['Public Works', 'Junior Engineer', 'City'],
        ['Public Works', 'Senior Engineer', 'City'],
        ['Sanitation', 'Inspector', 'City'],
        ['Sanitation', 'Supervisor', 'City'],
      ],
    });

    const { departments, designations, deptNameToCode, desigNameToCode, localizations } =
      readDepartmentsDesignations(wb);

    assert.strictEqual(departments.length, 2); // deduplicated
    assert.strictEqual(departments[0].code, 'DEPT_1');
    assert.strictEqual(departments[0].name, 'Public Works');
    assert.strictEqual(departments[1].code, 'DEPT_2');

    assert.strictEqual(designations.length, 4);
    assert.strictEqual(designations[0].code, 'DESIG_01');
    assert.strictEqual(designations[1].code, 'DESIG_02');

    assert.strictEqual(deptNameToCode.get('Public Works'), 'DEPT_1');
    assert.strictEqual(deptNameToCode.get('Sanitation'), 'DEPT_2');
    assert.strictEqual(desigNameToCode.get('Junior Engineer'), 'DESIG_01');

    // Localizations: 2 depts + 4 desigs = 6
    assert.strictEqual(localizations.length, 6);
  });

  // ── Complaint Types ──

  await test('readComplaintTypes: parses parent-child hierarchy', () => {
    const deptNameToCode = new Map([['Public Works', 'DEPT_1'], ['Sanitation', 'DEPT_2']]);

    const wb = createWorkbook({
      'Complaint Type Master': [
        ['Complaint Type*', 'Complaint sub type*', 'Department Name*', 'Resolution Time (Hours)*', 'Search Words*', 'Priority'],
        ['Road Maintenance', '', 'Public Works', '48', 'road,pothole', '3'],
        ['', 'Pothole', '', '', '', ''],
        ['', 'Gutter Damage', '', '', '', ''],
        ['Garbage', '', 'Sanitation', '24', 'garbage,trash', '2'],
        ['', 'Not Collected', '', '', '', ''],
      ],
    });

    const { complaintTypes, localizations } = readComplaintTypes(wb, deptNameToCode);

    // 2 parents + 3 children = 5 types
    assert.strictEqual(complaintTypes.length, 5);

    // Parent: Road Maintenance
    assert.strictEqual(complaintTypes[0].serviceCode, 'RoadMaintenance');
    assert.strictEqual(complaintTypes[0].department, 'DEPT_1');
    assert.strictEqual(complaintTypes[0].slaHours, 48);

    // Child: Pothole (inherits from Road Maintenance)
    assert.strictEqual(complaintTypes[1].serviceCode, 'RoadMaintenancePothole');
    assert.strictEqual(complaintTypes[1].department, 'DEPT_1'); // inherited
    assert.strictEqual(complaintTypes[1].slaHours, 48); // inherited

    // Parent: Garbage
    assert.strictEqual(complaintTypes[3].serviceCode, 'Garbage');
    assert.strictEqual(complaintTypes[3].department, 'DEPT_2');

    assert.strictEqual(localizations.length, 5);
  });

  // ── Employees ──

  await test('readEmployees: parses employee rows', () => {
    const wb = createWorkbook({
      'Employee Master': [
        ['User Name*', 'Mobile Number*', 'Department Name*', 'Designation Name*', 'Role Names*', 'Date of Appointment*', 'Assignment From Date*', 'Password'],
        ['John Smith', '9876543210', 'Public Works', 'Junior Engineer', 'EMPLOYEE,GRO', '2024-01-15', '2024-01-15', 'pass123'],
        ['Jane Doe', '9876543211', 'Sanitation', 'Inspector', 'EMPLOYEE', '2024-02-01', '2024-02-01', ''],
      ],
    });

    const employees = readEmployees(wb);

    assert.strictEqual(employees.length, 2);
    assert.strictEqual(employees[0].code, 'JOHN_SMITH');
    assert.strictEqual(employees[0].mobileNumber, '9876543210');
    assert.deepStrictEqual(employees[0].roleNames, ['EMPLOYEE', 'GRO']);
    assert.strictEqual(employees[0].password, 'pass123');

    assert.strictEqual(employees[1].code, 'JANE_DOE');
    assert.strictEqual(employees[1].password, 'eGov@123'); // default
    assert.ok(employees[1].appointmentDate > 0, 'should have valid timestamp');
  });

  await test('readEmployees: handles duplicate names', () => {
    const wb = createWorkbook({
      'Employee Master': [
        ['User Name*', 'Mobile Number*', 'Department Name*', 'Designation Name*', 'Role Names*', 'Date of Appointment*', 'Assignment From Date*'],
        ['John Smith', '9876543210', 'PW', 'JE', 'EMPLOYEE', '2024-01-15', '2024-01-15'],
        ['John Smith', '9876543211', 'SN', 'IN', 'EMPLOYEE', '2024-01-15', '2024-01-15'],
      ],
    });

    const employees = readEmployees(wb);
    assert.strictEqual(employees[0].code, 'JOHN_SMITH');
    assert.strictEqual(employees[1].code, 'JOHN_SMITH_2'); // deduplicated
  });

  // ── Summary ──
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
