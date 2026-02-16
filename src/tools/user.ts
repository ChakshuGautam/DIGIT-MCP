import type { ToolMetadata } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';

export function registerUserTools(registry: ToolRegistry): void {
  registry.register({
    name: 'user_search',
    group: 'admin',
    category: 'user',
    risk: 'read',
    description:
      'Search DIGIT platform users by username, mobile number, UUID, role, or user type (CITIZEN/EMPLOYEE/SYSTEM). ' +
      'Returns user details including roles, active status, and tenant. ' +
      'Useful for verifying if a citizen or employee user exists before creating complaints or employees.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to search users in',
        },
        user_name: {
          type: 'string',
          description: 'Filter by username',
        },
        mobile_number: {
          type: 'string',
          description: 'Filter by mobile number',
        },
        uuid: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by user UUIDs',
        },
        role_codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by role codes (e.g. ["CITIZEN", "GRO"])',
        },
        user_type: {
          type: 'string',
          enum: ['CITIZEN', 'EMPLOYEE', 'SYSTEM'],
          description: 'Filter by user type',
        },
        limit: { type: 'number', description: 'Max results (default: 100)' },
        offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const users = await digitApi.userSearch(args.tenant_id as string, {
        userName: args.user_name as string | undefined,
        mobileNumber: args.mobile_number as string | undefined,
        uuid: args.uuid as string[] | undefined,
        roleCodes: args.role_codes as string[] | undefined,
        userType: args.user_type as string | undefined,
        limit: (args.limit as number) || 100,
        offset: (args.offset as number) || 0,
      });

      return JSON.stringify(
        {
          success: true,
          tenantId: args.tenant_id,
          count: users.length,
          users: users.slice(0, 50).map((u) => ({
            id: u.id,
            uuid: u.uuid,
            userName: u.userName,
            name: u.name,
            mobileNumber: u.mobileNumber,
            emailId: u.emailId,
            type: u.type,
            active: u.active,
            tenantId: u.tenantId,
            roles: ((u.roles || []) as Array<{ code: string; name?: string }>).map((r) => ({
              code: r.code,
              name: r.name,
            })),
          })),
          truncated: users.length > 50,
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'user_create',
    group: 'admin',
    category: 'user',
    risk: 'write',
    description:
      'Create a new user in the DIGIT platform. Creates users without OTP validation (admin operation). ' +
      'Use this to create CITIZEN users for PGR complaints or EMPLOYEE users for HRMS. ' +
      'For creating employees with department/designation/jurisdiction, use employee_create instead — it creates the user automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID for the user',
        },
        name: {
          type: 'string',
          description: 'Full name of the user',
        },
        mobile_number: {
          type: 'string',
          description: 'Mobile number (10 digits, used as username for CITIZEN)',
        },
        user_type: {
          type: 'string',
          enum: ['CITIZEN', 'EMPLOYEE'],
          description: 'User type (default: CITIZEN)',
        },
        roles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Role code' },
              name: { type: 'string', description: 'Role name' },
            },
            required: ['code', 'name'],
          },
          description: 'Roles to assign. For CITIZEN users, CITIZEN role is auto-added.',
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
        username: {
          type: 'string',
          description: 'Username (defaults to mobile_number for CITIZEN, required for EMPLOYEE)',
        },
        password: {
          type: 'string',
          description: 'Password for the user (default: "eGov@123")',
        },
      },
      required: ['tenant_id', 'name', 'mobile_number'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const tenantId = args.tenant_id as string;
      const env = digitApi.getEnvironmentInfo();
      const userType = (args.user_type as string) || 'CITIZEN';
      const mobileNumber = args.mobile_number as string;

      const roles = ((args.roles as Array<{ code: string; name: string }>) || []).map((r) => ({
        code: r.code,
        name: r.name,
        tenantId: env.stateTenantId,
      }));

      // Ensure appropriate default role
      if (userType === 'CITIZEN' && !roles.some((r) => r.code === 'CITIZEN')) {
        roles.push({ code: 'CITIZEN', name: 'Citizen', tenantId: env.stateTenantId });
      }

      const user: Record<string, unknown> = {
        name: args.name as string,
        mobileNumber,
        userName: (args.username as string) || mobileNumber,
        password: (args.password as string) || 'eGov@123',
        type: userType,
        active: true,
        emailId: (args.email as string) || null,
        gender: (args.gender as string) || null,
        roles,
        tenantId: env.stateTenantId,
      };

      try {
        const created = await digitApi.userCreate(user, tenantId);

        return JSON.stringify(
          {
            success: true,
            message: `User created: ${created.userName || 'unknown'}`,
            user: {
              id: created.id,
              uuid: created.uuid,
              userName: created.userName,
              name: created.name,
              mobileNumber: created.mobileNumber,
              type: created.type,
              active: created.active,
              tenantId: created.tenantId,
              roles: ((created.roles || []) as Array<{ code: string }>).map((r) => r.code),
            },
          },
          null,
          2
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isDuplicate = msg.includes('already exists') || msg.includes('duplicate') || msg.includes('already registered');
        return JSON.stringify({
          success: false,
          error: msg,
          hint: isDuplicate
            ? 'A user with this mobile number/username may already exist. Use user_search to find existing users.'
            : 'User creation failed. Verify the tenant_id and role codes are valid.',
          alternatives: [
            { tool: 'user_search', purpose: 'Search existing users by mobile/name' },
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
