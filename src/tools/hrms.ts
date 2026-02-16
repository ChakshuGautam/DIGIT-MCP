import type { ToolMetadata } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';

export function registerHrmsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'employee_create',
    group: 'employees',
    category: 'hrms',
    risk: 'write',
    description:
      'Create a new employee in DIGIT HRMS. Requires employee name, mobile number, roles, department/designation assignment, and jurisdiction. ' +
      'Use validate_departments and validate_designations first to get valid codes. ' +
      'Use access_roles_search to find valid role codes. ' +
      'Use validate_boundary to find valid boundary codes for jurisdiction.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID for the employee (city-level, e.g. "pg.citya")',
        },
        name: {
          type: 'string',
          description: 'Full name of the employee',
        },
        mobile_number: {
          type: 'string',
          description: 'Mobile number (10 digits)',
        },
        roles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Role code (e.g. "GRO", "PGR_LME", "EMPLOYEE")' },
              name: { type: 'string', description: 'Role display name' },
            },
            required: ['code', 'name'],
          },
          description: 'Roles to assign. Must include EMPLOYEE role. For PGR: GRO (Grievance Routing Officer), PGR_LME (Last Mile Employee), DGRO (Department GRO).',
        },
        department: {
          type: 'string',
          description: 'Department code for assignment (e.g. "DEPT_1"). Use validate_departments to list valid codes.',
        },
        designation: {
          type: 'string',
          description: 'Designation code for assignment (e.g. "DESIG_1"). Use validate_designations to list valid codes.',
        },
        jurisdiction_hierarchy: {
          type: 'string',
          description: 'Jurisdiction hierarchy type (default: "ADMIN")',
        },
        jurisdiction_boundary_type: {
          type: 'string',
          description: 'Boundary type for jurisdiction (e.g. "City", "Ward", "Locality")',
        },
        jurisdiction_boundary: {
          type: 'string',
          description: 'Boundary code for jurisdiction (e.g. "pg.citya"). Use validate_boundary to find codes.',
        },
        employee_type: {
          type: 'string',
          description: 'Employee type (default: "PERMANENT"). Use mdms_search with schema "egov-hrms.EmployeeType" to list valid types.',
        },
        date_of_appointment: {
          type: 'number',
          description: 'Date of appointment as epoch timestamp in milliseconds (default: current time)',
        },
        email: {
          type: 'string',
          description: 'Optional email address',
        },
        gender: {
          type: 'string',
          enum: ['MALE', 'FEMALE', 'TRANSGENDER'],
          description: 'Optional gender',
        },
      },
      required: ['tenant_id', 'name', 'mobile_number', 'roles', 'department', 'designation', 'jurisdiction_boundary_type', 'jurisdiction_boundary'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const env = digitApi.getEnvironmentInfo();
      const now = Date.now();

      const roles = (args.roles as Array<{ code: string; name: string }>).map((r) => ({
        code: r.code,
        name: r.name,
        tenantId: env.stateTenantId,
      }));

      // Ensure EMPLOYEE role is present
      if (!roles.some((r) => r.code === 'EMPLOYEE')) {
        roles.push({ code: 'EMPLOYEE', name: 'Employee', tenantId: env.stateTenantId });
      }

      const employee: Record<string, unknown> = {
        tenantId,
        employeeType: (args.employee_type as string) || 'PERMANENT',
        employeeStatus: 'EMPLOYED',
        dateOfAppointment: (args.date_of_appointment as number) || now,
        IsActive: true,
        user: {
          name: args.name as string,
          mobileNumber: args.mobile_number as string,
          emailId: (args.email as string) || null,
          gender: (args.gender as string) || null,
          type: 'EMPLOYEE',
          roles,
          tenantId: env.stateTenantId,
        },
        assignments: [
          {
            department: args.department as string,
            designation: args.designation as string,
            fromDate: (args.date_of_appointment as number) || now,
            isCurrentAssignment: true,
            isHOD: false,
          },
        ],
        jurisdictions: [
          {
            hierarchy: (args.jurisdiction_hierarchy as string) || 'ADMIN',
            boundaryType: args.jurisdiction_boundary_type as string,
            boundary: args.jurisdiction_boundary as string,
            tenantId,
            isActive: true,
          },
        ],
      };

      try {
        const result = await digitApi.employeeCreate(tenantId, [employee]);

        if (result.length === 0) {
          return JSON.stringify({ success: false, error: 'No employee returned in response' }, null, 2);
        }

        const created = result[0];
        const user = created.user as Record<string, unknown> | undefined;

        return JSON.stringify(
          {
            success: true,
            message: `Employee created: ${created.code || 'unknown'}`,
            employee: {
              code: created.code,
              uuid: created.uuid,
              name: user?.name,
              mobileNumber: user?.mobileNumber,
              employeeStatus: created.employeeStatus,
              employeeType: created.employeeType,
              tenantId: created.tenantId,
              roles: ((user?.roles || []) as Array<{ code: string }>).map((r) => r.code),
            },
          },
          null,
          2
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isDuplicate = msg.includes('already exists') || msg.includes('duplicate') || msg.includes('ALREADY_ACTIVE');
        return JSON.stringify({
          success: false,
          error: msg,
          hint: isDuplicate
            ? 'An employee with this mobile number may already exist for this tenant. Use validate_employees to search existing employees.'
            : 'Employee creation failed. Verify: (1) department code is valid (use validate_departments), ' +
              '(2) designation code is valid (use validate_designations), ' +
              '(3) role codes are valid (use access_roles_search), ' +
              '(4) boundary code exists (use validate_boundary).',
          alternatives: [
            { tool: 'validate_employees', purpose: 'Search existing employees for the tenant' },
            { tool: 'validate_departments', purpose: 'List valid department codes' },
            { tool: 'validate_designations', purpose: 'List valid designation codes' },
            { tool: 'access_roles_search', purpose: 'List valid role codes' },
            { tool: 'validate_boundary', purpose: 'Find valid boundary codes' },
          ],
        }, null, 2);
      }
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'employee_update',
    group: 'employees',
    category: 'hrms',
    risk: 'write',
    description:
      'Update an existing HRMS employee. First use validate_employees to get current employee data, then pass the modified employee object. ' +
      'Common updates: adding/removing roles, changing department/designation assignment, deactivating an employee. ' +
      'The full employee object must be sent (fetch first, modify, then update).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID of the employee',
        },
        employee_code: {
          type: 'string',
          description: 'Employee code to update (use validate_employees to find codes)',
        },
        add_roles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Role code to add' },
              name: { type: 'string', description: 'Role display name' },
            },
            required: ['code', 'name'],
          },
          description: 'Roles to add to the employee',
        },
        remove_roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Role codes to remove from the employee',
        },
        new_assignment: {
          type: 'object',
          properties: {
            department: { type: 'string', description: 'Department code' },
            designation: { type: 'string', description: 'Designation code' },
          },
          description: 'New current assignment (ends previous current assignment)',
        },
        deactivate: {
          type: 'boolean',
          description: 'Set to true to deactivate the employee',
        },
        reactivate: {
          type: 'boolean',
          description: 'Set to true to reactivate a deactivated employee',
        },
      },
      required: ['tenant_id', 'employee_code'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const employeeCode = args.employee_code as string;
      const env = digitApi.getEnvironmentInfo();

      // Fetch current employee
      const employees = await digitApi.employeeSearch(tenantId, { codes: [employeeCode] });
      if (employees.length === 0) {
        return JSON.stringify({
          success: false,
          error: `Employee "${employeeCode}" not found in tenant "${tenantId}"`,
          hint: 'Use validate_employees to list existing employees and their codes.',
        }, null, 2);
      }

      const employee = { ...employees[0] };
      const user = { ...(employee.user as Record<string, unknown>) };
      let currentRoles = [...((user.roles || []) as Array<{ code: string; name: string; tenantId?: string }>)];

      // Add roles
      const addRoles = args.add_roles as Array<{ code: string; name: string }> | undefined;
      if (addRoles?.length) {
        for (const role of addRoles) {
          if (!currentRoles.some((r) => r.code === role.code)) {
            currentRoles.push({ code: role.code, name: role.name, tenantId: env.stateTenantId });
          }
        }
      }

      // Remove roles
      const removeRoles = args.remove_roles as string[] | undefined;
      if (removeRoles?.length) {
        currentRoles = currentRoles.filter((r) => !removeRoles.includes(r.code));
      }

      user.roles = currentRoles;
      employee.user = user;

      // New assignment
      const newAssignment = args.new_assignment as { department: string; designation: string } | undefined;
      if (newAssignment) {
        const assignments = [...((employee.assignments || []) as Array<Record<string, unknown>>)];
        // End current assignments
        for (const a of assignments) {
          if (a.isCurrentAssignment) {
            a.isCurrentAssignment = false;
            a.toDate = Date.now();
          }
        }
        assignments.push({
          department: newAssignment.department,
          designation: newAssignment.designation,
          fromDate: Date.now(),
          isCurrentAssignment: true,
          isHOD: false,
        });
        employee.assignments = assignments;
      }

      // Deactivate
      if (args.deactivate) {
        employee.employeeStatus = 'INACTIVE';
        employee.IsActive = false;
        employee.deactivationDetails = [
          ...((employee.deactivationDetails || []) as Array<Record<string, unknown>>),
          { effectiveFrom: Date.now(), reasonForDeactivation: 'Deactivated via MCP' },
        ];
      }

      // Reactivate
      if (args.reactivate) {
        employee.employeeStatus = 'EMPLOYED';
        employee.IsActive = true;
        employee.reActivateEmployee = true;
        employee.reactivationDetails = [
          ...((employee.reactivationDetails || []) as Array<Record<string, unknown>>),
          { effectiveFrom: Date.now(), reasonForReactivation: 'Reactivated via MCP' },
        ];
      }

      try {
        const result = await digitApi.employeeUpdate(tenantId, [employee]);

        if (result.length === 0) {
          return JSON.stringify({ success: false, error: 'No employee returned in response' }, null, 2);
        }

        const updated = result[0];
        const updatedUser = updated.user as Record<string, unknown> | undefined;

        return JSON.stringify(
          {
            success: true,
            message: `Employee ${employeeCode} updated`,
            employee: {
              code: updated.code,
              name: updatedUser?.name,
              employeeStatus: updated.employeeStatus,
              roles: ((updatedUser?.roles || []) as Array<{ code: string }>).map((r) => r.code),
              assignments: ((updated.assignments || []) as Array<Record<string, unknown>>)
                .filter((a) => a.isCurrentAssignment)
                .map((a) => ({ department: a.department, designation: a.designation })),
            },
          },
          null,
          2
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return JSON.stringify({
          success: false,
          error: msg,
          hint: 'Employee update failed. The full employee object is sent to the API — if fields are missing from the fetched data, the update may fail.',
          alternatives: [
            { tool: 'validate_employees', purpose: 'Fetch current employee data' },
            { tool: 'access_roles_search', purpose: 'List valid role codes' },
          ],
        }, null, 2);
      }
    },
  } satisfies ToolMetadata);
}

async function ensureAuthenticated(): Promise<void> {
  if (digitApi.isAuthenticated()) return;
  const username = process.env.CRS_USERNAME;
  const password = process.env.CRS_PASSWORD;
  const tenantId = process.env.CRS_TENANT_ID || digitApi.getEnvironmentInfo().stateTenantId;
  if (!username || !password) {
    throw new Error('Not authenticated. Call the "configure" tool first, or set CRS_USERNAME/CRS_PASSWORD env vars.');
  }
  await digitApi.login(username, password, tenantId);
}
