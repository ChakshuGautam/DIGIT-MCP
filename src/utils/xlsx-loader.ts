/**
 * xlsx-loader.ts — Phase orchestrator for xlsx-based tenant setup.
 * Sequences 4 phases (Tenant → Boundaries → Masters → Employees),
 * manages cross-phase state, and calls DigitApiClient methods.
 */
import * as fs from 'fs';
import {
  loadWorkbook,
  readTenantInfo,
  readTenantBranding,
  readDepartmentsDesignations,
  readComplaintTypes,
  readEmployees,
} from './xlsx-reader.js';
import { digitApi } from '../services/digit-api.js';
import type ExcelJS from 'exceljs';

// ── Types ──

export interface PhaseResult {
  status: 'completed' | 'skipped' | 'failed';
  error?: string;
  [key: string]: unknown;
}

export interface XlsxLoadResult {
  success: boolean;
  tenant_id: string;
  phases: {
    tenant?: PhaseResult;
    boundaries?: PhaseResult;
    masters?: PhaseResult;
    employees?: PhaseResult;
  };
}

interface RowStatus {
  name: string;
  code?: string;
  status: 'created' | 'exists' | 'failed';
  error?: string;
}

// ── File Resolution ──

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a file reference to a Buffer.
 * - Local path (starts with / or ./) → fs.readFileSync
 * - UUID → download from DIGIT filestore
 */
async function resolveFile(ref: string, tenantId: string): Promise<Buffer> {
  if (ref.startsWith('/') || ref.startsWith('./') || ref.startsWith('../')) {
    return fs.readFileSync(ref);
  }

  if (UUID_RE.test(ref)) {
    // Download from DIGIT filestore
    const root = tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;
    const urls = await digitApi.filestoreGetUrl(root, [ref]);
    if (!urls.length) throw new Error(`FileStore ID "${ref}" not found`);

    const downloadUrl = (urls[0] as Record<string, unknown>).url as string;
    if (!downloadUrl) throw new Error(`No download URL for fileStoreId "${ref}"`);

    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);

    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  throw new Error(
    `Cannot resolve file "${ref}". Expected a local path (starting with /) or a fileStoreId (UUID format).`,
  );
}

// ── Phase Handlers ──

async function runTenantPhase(
  tenantId: string,
  fileRef: string,
): Promise<PhaseResult> {
  const root = tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;

  const buf = await resolveFile(fileRef, tenantId);
  const workbook = await loadWorkbook(buf);
  const { tenants, localizations } = readTenantInfo(workbook);

  let created = 0;
  let skipped = 0;
  let failedCount = 0;
  const rows: RowStatus[] = [];

  for (const tenant of tenants) {
    const uniqueId = `Tenant.${tenant.code}`;
    try {
      await digitApi.mdmsV2Create(root, 'tenant.tenants', uniqueId, {
        code: tenant.code,
        name: tenant.name,
        tenantId: tenant.code,
        parent: root,
        city: tenant.city,
        domainUrl: tenant.domainUrl,
      });
      created++;
      rows.push({ name: tenant.name, code: tenant.code, status: 'created' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists') || msg.includes('DUPLICATE') || msg.includes('unique')) {
        skipped++;
        rows.push({ name: tenant.name, code: tenant.code, status: 'exists' });
      } else {
        failedCount++;
        rows.push({ name: tenant.name, code: tenant.code, status: 'failed', error: msg });
      }
    }
  }

  // Handle optional branding sheet
  const brandingRecords = readTenantBranding(workbook);
  let brandingCreated = 0;
  for (const branding of brandingRecords) {
    try {
      await digitApi.mdmsV2Create(root, 'tenant.citymodule', `Branding.${branding.code}`, branding as unknown as Record<string, unknown>);
      brandingCreated++;
    } catch {
      // Non-fatal — branding is optional
    }
  }

  // Upsert localizations
  let localizationKeys = 0;
  if (localizations.length > 0) {
    try {
      await digitApi.localizationUpsert(root, 'en_IN', localizations);
      localizationKeys = localizations.length;
    } catch {
      // Non-fatal — log but don't fail the phase
    }
  }

  return {
    status: failedCount > 0 && created === 0 ? 'failed' : 'completed',
    created,
    skipped,
    failed: failedCount,
    branding_created: brandingCreated,
    localization_keys: localizationKeys,
    rows,
  };
}

async function runBoundaryPhase(
  tenantId: string,
  fileRef: string,
): Promise<PhaseResult> {
  const root = tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;

  const buf = await resolveFile(fileRef, tenantId);

  // Upload file to filestore
  const uploadResult = await digitApi.filestoreUpload(
    root,
    'boundary',
    buf,
    'boundary-data.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  if (!uploadResult.length) {
    return { status: 'failed', error: 'Filestore upload returned no results' };
  }

  const fileStoreId = (uploadResult[0] as Record<string, unknown>).fileStoreId as string;
  if (!fileStoreId) {
    return { status: 'failed', error: 'Filestore upload returned no fileStoreId' };
  }

  // Call boundary management process API
  try {
    const processResult = await digitApi.boundaryMgmtProcess(tenantId, {
      tenantId,
      type: 'boundary',
      hierarchyType: 'ADMIN',
      fileStoreId,
      action: 'create',
    });

    return {
      status: 'completed',
      message: 'Boundary file submitted for processing via boundary management service',
      fileStoreId,
      processResult,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      fileStoreId,
    };
  }
}

async function runMastersPhase(
  tenantId: string,
  fileRef: string,
): Promise<PhaseResult & { deptNameToCode?: Map<string, string> }> {
  const root = tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;

  const buf = await resolveFile(fileRef, tenantId);
  const workbook = await loadWorkbook(buf);

  const result: PhaseResult & { deptNameToCode?: Map<string, string> } = {
    status: 'completed',
    departments: { created: 0, exists: 0, failed: 0 } as Record<string, number>,
    designations: { created: 0, exists: 0, failed: 0 } as Record<string, number>,
    complaint_types: { created: 0, exists: 0, failed: 0 } as Record<string, number>,
    localization_keys: 0,
  };

  // ── Departments & Designations ──
  const {
    departments,
    designations,
    localizations: deptDesigLocalizations,
    deptNameToCode,
    desigNameToCode,
  } = readDepartmentsDesignations(workbook);

  const deptStats = result.departments as Record<string, number>;
  for (const dept of departments) {
    try {
      await digitApi.mdmsV2Create(root, 'common-masters.Department', dept.code, dept as unknown as Record<string, unknown>);
      deptStats.created++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists') || msg.includes('DUPLICATE') || msg.includes('unique')) {
        deptStats.exists++;
      } else {
        deptStats.failed++;
      }
    }
  }

  const desigStats = result.designations as Record<string, number>;
  for (const desig of designations) {
    try {
      await digitApi.mdmsV2Create(root, 'common-masters.Designation', desig.code, desig as unknown as Record<string, unknown>);
      desigStats.created++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists') || msg.includes('DUPLICATE') || msg.includes('unique')) {
        desigStats.exists++;
      } else {
        desigStats.failed++;
      }
    }
  }

  // ── Complaint Types ──
  let complaintTypes: Array<Record<string, unknown>> = [];
  let complaintLocalizations: Array<{ code: string; message: string; module: string }> = [];
  try {
    const parsed = readComplaintTypes(workbook, deptNameToCode);
    complaintTypes = parsed.complaintTypes as unknown as Array<Record<string, unknown>>;
    complaintLocalizations = parsed.localizations;
  } catch {
    // Complaint Type Master sheet may be absent — that's OK
  }

  const ctStats = result.complaint_types as Record<string, number>;
  for (const ct of complaintTypes) {
    try {
      await digitApi.mdmsV2Create(root, 'RAINMAKER-PGR.ServiceDefs', ct.serviceCode as string, ct);
      ctStats.created++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists') || msg.includes('DUPLICATE') || msg.includes('unique')) {
        ctStats.exists++;
      } else {
        ctStats.failed++;
      }
    }
  }

  // ── Localizations ──
  const allLocalizations = [...deptDesigLocalizations, ...complaintLocalizations];
  if (allLocalizations.length > 0) {
    try {
      await digitApi.localizationUpsert(root, 'en_IN', allLocalizations);
      (result as Record<string, unknown>).localization_keys = allLocalizations.length;
    } catch {
      // Non-fatal
    }
  }

  // Pass deptNameToCode for Phase 4
  result.deptNameToCode = deptNameToCode;

  return result;
}

async function runEmployeePhase(
  tenantId: string,
  fileRef: string,
  deptNameToCode?: Map<string, string>,
): Promise<PhaseResult> {
  const root = tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;

  const buf = await resolveFile(fileRef, tenantId);
  const workbook = await loadWorkbook(buf);
  const employees = readEmployees(workbook);

  // If deptNameToCode not provided from Phase 3, fetch from MDMS
  const deptMap = deptNameToCode || new Map<string, string>();
  const desigMap = new Map<string, string>();

  if (deptMap.size === 0) {
    try {
      const depts = await digitApi.mdmsV2Search<Record<string, unknown>>(root, 'common-masters.Department');
      for (const d of depts) {
        deptMap.set(d.name as string, d.code as string);
      }
    } catch {
      // Will proceed with raw names
    }
  }

  try {
    const desigs = await digitApi.mdmsV2Search<Record<string, unknown>>(root, 'common-masters.Designation');
    for (const d of desigs) {
      desigMap.set(d.name as string, d.code as string);
    }
  } catch {
    // Will proceed with raw names
  }

  const rows: RowStatus[] = [];
  let created = 0;
  let failedCount = 0;

  for (const emp of employees) {
    const deptCode = deptMap.get(emp.departmentName) || emp.departmentName;
    const desigCode = desigMap.get(emp.designationName) || emp.designationName;

    const assignments = [
      {
        department: deptCode,
        designation: desigCode,
        fromDate: emp.joiningDate,
        isCurrentAssignment: true,
        tenantId,
      },
    ];

    const jurisdictions = [
      {
        hierarchy: 'ADMIN',
        boundaryType: 'City',
        boundary: tenantId,
        tenantId,
      },
    ];

    const user = {
      name: emp.name,
      mobileNumber: emp.mobileNumber,
      userName: emp.code,
      password: emp.password,
      tenantId,
      roles: emp.roleNames.map((r) => ({
        code: r,
        name: r,
        tenantId,
      })),
    };

    try {
      await digitApi.employeeCreate(tenantId, [
        {
          code: emp.code,
          employeeStatus: 'EMPLOYED',
          employeeType: 'PERMANENT',
          dateOfAppointment: emp.appointmentDate,
          user,
          assignments,
          jurisdictions,
        },
      ]);
      created++;
      rows.push({ name: emp.name, code: emp.code, status: 'created' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failedCount++;
      rows.push({ name: emp.name, code: emp.code, status: 'failed', error: msg });
    }
  }

  return {
    status: failedCount > 0 && created === 0 ? 'failed' : 'completed',
    created,
    failed: failedCount,
    rows,
  };
}

// ── Main Orchestrator ──

export interface XlsxLoadOptions {
  tenant_id: string;
  tenant_file?: string;
  boundary_file?: string;
  masters_file?: string;
  employee_file?: string;
}

/**
 * Run xlsx-based tenant setup across all provided phases.
 * Phases execute in dependency order: Tenant → Boundaries → Masters → Employees.
 */
export async function loadFromXlsx(options: XlsxLoadOptions): Promise<XlsxLoadResult> {
  const { tenant_id, tenant_file, boundary_file, masters_file, employee_file } = options;

  const result: XlsxLoadResult = {
    success: true,
    tenant_id,
    phases: {},
  };

  let deptNameToCode: Map<string, string> | undefined;

  // Phase 1: Tenant
  if (tenant_file) {
    try {
      result.phases.tenant = await runTenantPhase(tenant_id, tenant_file);
    } catch (error) {
      result.phases.tenant = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Phase 2: Boundaries
  if (boundary_file) {
    try {
      result.phases.boundaries = await runBoundaryPhase(tenant_id, boundary_file);
    } catch (error) {
      result.phases.boundaries = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Phase 3: Masters
  if (masters_file) {
    try {
      const mastersResult = await runMastersPhase(tenant_id, masters_file);
      deptNameToCode = mastersResult.deptNameToCode;
      // Remove the Map from the serializable result
      const { deptNameToCode: _, ...serializableResult } = mastersResult;
      result.phases.masters = serializableResult;
    } catch (error) {
      result.phases.masters = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Phase 4: Employees
  if (employee_file) {
    try {
      result.phases.employees = await runEmployeePhase(tenant_id, employee_file, deptNameToCode);
    } catch (error) {
      result.phases.employees = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Set overall success based on phase results
  const phaseResults = Object.values(result.phases);
  result.success = phaseResults.length > 0 && phaseResults.every((p) => p.status !== 'failed');

  return result;
}
