import type { ToolMetadata, ValidationResult } from '../types/index.js';
import { MDMS_SCHEMAS } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';

export function registerValidatorTools(registry: ToolRegistry): void {
  // ──────────────────────────────────────────
  // boundary group
  // ──────────────────────────────────────────

  registry.register({
    name: 'validate_boundary',
    group: 'boundary',
    category: 'validation',
    risk: 'read',
    description:
      'Validate boundary setup for a tenant. Checks that boundary hierarchy exists and boundaries are defined. Reports missing levels or empty boundary trees.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to validate boundaries for',
        },
        hierarchy_type: {
          type: 'string',
          description: 'Boundary hierarchy type (default: "ADMIN")',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const hierarchyType = (args.hierarchy_type as string) || 'ADMIN';

      const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [],
        summary: '',
      };

      try {
        const boundaries = await digitApi.boundarySearch(tenantId, hierarchyType);

        if (boundaries.length === 0) {
          result.valid = false;
          result.errors.push({
            field: 'boundary',
            message: `No boundaries found for tenant "${tenantId}" with hierarchy type "${hierarchyType}"`,
            code: 'BOUNDARY_MISSING',
          });
        } else {
          // Count boundary nodes
          let totalNodes = 0;
          const countNodes = (items: unknown[]): void => {
            for (const item of items) {
              totalNodes++;
              const rec = item as Record<string, unknown>;
              if (Array.isArray(rec.children)) {
                countNodes(rec.children);
              }
            }
          };

          for (const tb of boundaries) {
            const boundary = tb.boundary;
            if (boundary && typeof boundary === 'object') {
              countNodes([boundary]);
            }
          }

          if (totalNodes < 2) {
            result.warnings.push({
              field: 'boundary',
              message: `Only ${totalNodes} boundary node(s) found. A typical setup has multiple levels (state > district > city > ward).`,
            });
          }

          result.summary = `Found ${boundaries.length} boundary tree(s) with ${totalNodes} total node(s) for hierarchy "${hierarchyType}"`;
        }
      } catch (error) {
        result.valid = false;
        result.errors.push({
          field: 'boundary',
          message: error instanceof Error ? error.message : String(error),
          code: 'BOUNDARY_API_ERROR',
        });
      }

      if (!result.summary) {
        result.summary = result.valid
          ? 'Boundary validation passed'
          : `Boundary validation failed with ${result.errors.length} error(s)`;
      }

      return JSON.stringify({ success: true, validation: result }, null, 2);
    },
  } satisfies ToolMetadata);

  // ──────────────────────────────────────────
  // masters group — departments, designations, complaint types
  // ──────────────────────────────────────────

  registry.register({
    name: 'validate_departments',
    group: 'masters',
    category: 'validation',
    risk: 'read',
    description:
      'Validate department setup for a tenant. Checks that required departments exist in MDMS and flags any inactive departments.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to validate departments for',
        },
        required_departments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Department codes that must exist (optional — if omitted, just lists what exists)',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const required = (args.required_departments || []) as string[];

      const departments = await digitApi.mdmsV2Search<Record<string, unknown>>(
        tenantId,
        MDMS_SCHEMAS.DEPARTMENT
      );

      const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [],
        summary: '',
      };

      const deptCodes = new Set(departments.map((d) => d.code as string));

      // Check required departments
      for (const code of required) {
        if (!deptCodes.has(code)) {
          result.valid = false;
          result.errors.push({
            field: 'department',
            value: code,
            message: `Required department "${code}" not found`,
            code: 'DEPARTMENT_MISSING',
          });
        }
      }

      // Check for inactive departments
      for (const dept of departments) {
        if (dept.active === false) {
          result.warnings.push({
            field: 'department',
            value: dept.code as string,
            message: `Department "${dept.code}" is inactive`,
          });
        }
      }

      if (departments.length === 0) {
        result.valid = false;
        result.errors.push({
          field: 'department',
          message: `No departments found for tenant "${tenantId}"`,
          code: 'NO_DEPARTMENTS',
        });
      }

      result.summary = `Found ${departments.length} department(s)${required.length ? `, ${required.length - result.errors.length}/${required.length} required present` : ''}`;

      return JSON.stringify(
        {
          success: true,
          validation: result,
          departments: departments.map((d) => ({
            code: d.code,
            name: d.name,
            active: d.active,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'validate_designations',
    group: 'masters',
    category: 'validation',
    risk: 'read',
    description:
      'Validate designation setup for a tenant. Checks that designations exist in MDMS. Optionally validates that specific designation codes are present.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to validate designations for',
        },
        required_designations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Designation codes that must exist (optional)',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const required = (args.required_designations || []) as string[];

      const designations = await digitApi.mdmsV2Search<Record<string, unknown>>(
        tenantId,
        MDMS_SCHEMAS.DESIGNATION
      );

      const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [],
        summary: '',
      };

      const desigCodes = new Set(designations.map((d) => d.code as string));

      for (const code of required) {
        if (!desigCodes.has(code)) {
          result.valid = false;
          result.errors.push({
            field: 'designation',
            value: code,
            message: `Required designation "${code}" not found`,
            code: 'DESIGNATION_MISSING',
          });
        }
      }

      for (const desig of designations) {
        if (desig.active === false) {
          result.warnings.push({
            field: 'designation',
            value: desig.code as string,
            message: `Designation "${desig.code}" is inactive`,
          });
        }
      }

      if (designations.length === 0) {
        result.valid = false;
        result.errors.push({
          field: 'designation',
          message: `No designations found for tenant "${tenantId}"`,
          code: 'NO_DESIGNATIONS',
        });
      }

      result.summary = `Found ${designations.length} designation(s)${required.length ? `, ${required.length - result.errors.length}/${required.length} required present` : ''}`;

      return JSON.stringify(
        {
          success: true,
          validation: result,
          designations: designations.map((d) => ({
            code: d.code,
            name: d.name,
            active: d.active,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'validate_complaint_types',
    group: 'masters',
    category: 'validation',
    risk: 'read',
    description:
      'Validate PGR complaint type / service definition setup for a tenant. Checks that service definitions exist in MDMS and that each has a valid department reference.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to validate complaint types for',
        },
        check_department_refs: {
          type: 'boolean',
          description: 'If true, verify that each complaint type references a valid department (default: true)',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const checkDeptRefs = args.check_department_refs !== false;

      const complaintTypes = await digitApi.mdmsV2Search<Record<string, unknown>>(
        tenantId,
        MDMS_SCHEMAS.PGR_SERVICE_DEFS
      );

      const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [],
        summary: '',
      };

      if (complaintTypes.length === 0) {
        result.valid = false;
        result.errors.push({
          field: 'complaintType',
          message: `No PGR service definitions found for tenant "${tenantId}"`,
          code: 'NO_COMPLAINT_TYPES',
        });
      }

      // Cross-reference departments
      if (checkDeptRefs && complaintTypes.length > 0) {
        const departments = await digitApi.mdmsV2Search<Record<string, unknown>>(
          tenantId,
          MDMS_SCHEMAS.DEPARTMENT
        );
        const deptCodes = new Set(departments.map((d) => d.code as string));

        for (const ct of complaintTypes) {
          const dept = ct.department as string;
          if (dept && !deptCodes.has(dept)) {
            result.warnings.push({
              field: 'complaintType',
              value: ct.serviceCode as string,
              message: `Complaint type "${ct.serviceCode}" references department "${dept}" which doesn't exist in MDMS`,
            });
          }

          if (!ct.slaHours && ct.slaHours !== 0) {
            result.warnings.push({
              field: 'complaintType',
              value: ct.serviceCode as string,
              message: `Complaint type "${ct.serviceCode}" has no SLA hours defined`,
            });
          }
        }
      }

      result.summary = `Found ${complaintTypes.length} complaint type(s)`;

      return JSON.stringify(
        {
          success: true,
          validation: result,
          complaintTypes: complaintTypes.map((ct) => ({
            serviceCode: ct.serviceCode,
            serviceName: ct.serviceName,
            department: ct.department,
            slaHours: ct.slaHours,
            active: ct.active,
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // ──────────────────────────────────────────
  // employees group
  // ──────────────────────────────────────────

  registry.register({
    name: 'validate_employees',
    group: 'employees',
    category: 'validation',
    risk: 'read',
    description:
      'Validate employee setup for a tenant. Checks that employees exist in HRMS, have valid department/designation assignments, and have required PGR roles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to validate employees for',
        },
        required_roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Role codes that at least one employee must have (e.g. ["GRO", "PGR_LME"])',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const requiredRoles = (args.required_roles || []) as string[];

      const employees = await digitApi.employeeSearch(tenantId);

      const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [],
        summary: '',
      };

      if (employees.length === 0) {
        result.valid = false;
        result.errors.push({
          field: 'employee',
          message: `No employees found for tenant "${tenantId}"`,
          code: 'NO_EMPLOYEES',
        });
      }

      // Check required roles coverage
      if (requiredRoles.length > 0 && employees.length > 0) {
        const coveredRoles = new Set<string>();

        for (const emp of employees) {
          const user = emp.user as Record<string, unknown> | undefined;
          const roles = (user?.roles || []) as Array<{ code: string }>;
          for (const role of roles) {
            coveredRoles.add(role.code);
          }
        }

        for (const role of requiredRoles) {
          if (!coveredRoles.has(role)) {
            result.valid = false;
            result.errors.push({
              field: 'employee',
              value: role,
              message: `No employee found with required role "${role}"`,
              code: 'ROLE_NOT_COVERED',
            });
          }
        }
      }

      // Check for employees with missing assignments
      for (const emp of employees) {
        const assignments = (emp.assignments || []) as Array<Record<string, unknown>>;
        const code = emp.code as string;

        const currentAssignment = assignments.find((a) => a.isCurrentAssignment === true);
        if (!currentAssignment && assignments.length > 0) {
          result.warnings.push({
            field: 'employee',
            value: code,
            message: `Employee "${code}" has no current assignment`,
          });
        }

        if (assignments.length === 0) {
          result.warnings.push({
            field: 'employee',
            value: code,
            message: `Employee "${code}" has no assignments`,
          });
        }
      }

      result.summary = `Found ${employees.length} employee(s)${requiredRoles.length ? `, ${requiredRoles.length - result.errors.filter((e) => e.code === 'ROLE_NOT_COVERED').length}/${requiredRoles.length} required roles covered` : ''}`;

      return JSON.stringify(
        {
          success: true,
          validation: result,
          employeeCount: employees.length,
          employees: employees.slice(0, 20).map((e) => ({
            code: e.code,
            name: (e.user as Record<string, unknown>)?.name,
            status: e.employeeStatus,
            roles: ((e.user as Record<string, unknown>)?.roles as Array<{ code: string }> || []).map((r) => r.code),
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);
}

// Auto-login helper
async function ensureAuthenticated(): Promise<void> {
  if (digitApi.isAuthenticated()) return;

  const username = process.env.CRS_USERNAME;
  const password = process.env.CRS_PASSWORD;
  const tenantId = process.env.CRS_TENANT_ID || digitApi.getEnvironmentInfo().stateTenantId;

  if (!username || !password) {
    throw new Error(
      'Not authenticated. Call the "configure" tool first, or set CRS_USERNAME/CRS_PASSWORD env vars.'
    );
  }

  await digitApi.login(username, password, tenantId);
}
