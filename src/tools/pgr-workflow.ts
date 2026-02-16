import type { ToolMetadata } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';

export function registerPgrWorkflowTools(registry: ToolRegistry): void {
  // ──────────────────────────────────────────
  // PGR tools
  // ──────────────────────────────────────────

  registry.register({
    name: 'pgr_search',
    group: 'pgr',
    category: 'pgr',
    risk: 'read',
    description:
      'Search PGR complaints/service requests for a tenant. Can filter by service request ID or status. Returns complaint details including service code, description, status, and workflow state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID to search complaints in',
        },
        service_request_id: {
          type: 'string',
          description: 'Specific service request ID to look up',
        },
        status: {
          type: 'string',
          enum: ['PENDINGFORASSIGNMENT', 'PENDINGATLME', 'PENDINGFORREASSIGNMENT', 'RESOLVED', 'REJECTED', 'CLOSEDAFTERRESOLUTION'],
          description: 'Filter by complaint status',
        },
        limit: { type: 'number', description: 'Max results (default: 50)' },
        offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const complaints = await digitApi.pgrSearch(args.tenant_id as string, {
        serviceRequestId: args.service_request_id as string | undefined,
        status: args.status as string | undefined,
        limit: (args.limit as number) || 50,
        offset: (args.offset as number) || 0,
      });

      return JSON.stringify(
        {
          success: true,
          tenantId: args.tenant_id,
          count: complaints.length,
          complaints: complaints.map((sw) => {
            const svc = sw.service as Record<string, unknown> | undefined;
            const wf = sw.workflow as Record<string, unknown> | undefined;
            return {
              serviceRequestId: svc?.serviceRequestId,
              serviceCode: svc?.serviceCode,
              description: svc?.description,
              status: svc?.applicationStatus,
              workflowAction: wf?.action,
              workflowState: wf?.state,
              createdTime: (svc?.auditDetails as Record<string, unknown>)?.createdTime,
            };
          }),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'pgr_create',
    group: 'pgr',
    category: 'pgr',
    risk: 'write',
    description:
      'Create a new PGR complaint/service request. Requires tenant ID, a valid service code (from validate_complaint_types), description, and address with boundary info.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID',
        },
        service_code: {
          type: 'string',
          description: 'Service code for the complaint type (e.g. "SL_WS")',
        },
        description: {
          type: 'string',
          description: 'Description of the complaint',
        },
        address: {
          type: 'object',
          properties: {
            locality: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'Locality boundary code' },
              },
              required: ['code'],
            },
            city: { type: 'string', description: 'City name' },
          },
          required: ['locality'],
          description: 'Address with locality boundary code',
        },
      },
      required: ['tenant_id', 'service_code', 'description', 'address'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const result = await digitApi.pgrCreate(
        args.tenant_id as string,
        args.service_code as string,
        args.description as string,
        args.address as Record<string, unknown>
      );

      const svc = (result.service || {}) as Record<string, unknown>;

      return JSON.stringify(
        {
          success: true,
          message: `Complaint created: ${svc.serviceRequestId || 'unknown'}`,
          complaint: {
            serviceRequestId: svc.serviceRequestId,
            serviceCode: svc.serviceCode,
            status: svc.applicationStatus,
            tenantId: svc.tenantId,
          },
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'pgr_update',
    group: 'pgr',
    category: 'pgr',
    risk: 'write',
    description:
      'Update a PGR complaint status via workflow action. First use pgr_search to get the service wrapper, then pass the action (ASSIGN, RESOLVE, REJECT, REOPEN, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID',
        },
        service_request_id: {
          type: 'string',
          description: 'Service request ID to update',
        },
        action: {
          type: 'string',
          enum: ['ASSIGN', 'REASSIGN', 'RESOLVE', 'REJECT', 'REOPEN', 'CLOSEDAFTERRESOLUTION'],
          description: 'Workflow action to perform',
        },
        comment: {
          type: 'string',
          description: 'Optional comment for the action',
        },
      },
      required: ['tenant_id', 'service_request_id', 'action'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      // First fetch the current complaint
      const complaints = await digitApi.pgrSearch(args.tenant_id as string, {
        serviceRequestId: args.service_request_id as string,
      });

      if (complaints.length === 0) {
        return JSON.stringify(
          { success: false, error: `Complaint "${args.service_request_id}" not found` },
          null,
          2
        );
      }

      const result = await digitApi.pgrUpdate(
        complaints[0],
        args.action as string,
        args.comment as string | undefined
      );

      const svc = (result.service || {}) as Record<string, unknown>;

      return JSON.stringify(
        {
          success: true,
          message: `Complaint ${args.service_request_id} updated with action ${args.action}`,
          complaint: {
            serviceRequestId: svc.serviceRequestId,
            status: svc.applicationStatus,
          },
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  // ──────────────────────────────────────────
  // Workflow tools
  // ──────────────────────────────────────────

  registry.register({
    name: 'workflow_business_services',
    group: 'pgr',
    category: 'workflow',
    risk: 'read',
    description:
      'Search workflow business service configurations for a tenant. Shows the state machine definition for services like PGR, including states, actions, and SLA. Useful for understanding what workflow actions are available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID',
        },
        business_services: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by business service codes (e.g. ["PGR"]). Omit to list all.',
        },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const services = await digitApi.workflowBusinessServiceSearch(
        args.tenant_id as string,
        args.business_services as string[] | undefined
      );

      return JSON.stringify(
        {
          success: true,
          tenantId: args.tenant_id,
          count: services.length,
          businessServices: services.map((bs) => ({
            businessService: bs.businessService,
            business: bs.business,
            businessServiceSla: bs.businessServiceSla,
            states: ((bs.states || []) as Record<string, unknown>[]).map((s) => ({
              state: s.state,
              applicationStatus: s.applicationStatus,
              isStartState: s.isStartState,
              isTerminateState: s.isTerminateState,
              actions: ((s.actions || []) as Record<string, unknown>[]).map((a) => ({
                action: a.action,
                nextState: a.nextState,
                roles: a.roles,
              })),
            })),
          })),
        },
        null,
        2
      );
    },
  } satisfies ToolMetadata);

  registry.register({
    name: 'workflow_process_search',
    group: 'pgr',
    category: 'workflow',
    risk: 'read',
    description:
      'Search workflow process instances for specific business IDs (e.g. PGR complaint numbers). Shows the audit trail of workflow transitions for a complaint or other entity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant_id: {
          type: 'string',
          description: 'Tenant ID',
        },
        business_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Business IDs to look up (e.g. PGR service request IDs)',
        },
        limit: { type: 'number', description: 'Max results (default: 50)' },
        offset: { type: 'number', description: 'Offset (default: 0)' },
      },
      required: ['tenant_id'],
    },
    handler: async (args) => {
      await ensureAuthenticated();

      const processes = await digitApi.workflowProcessSearch(
        args.tenant_id as string,
        args.business_ids as string[] | undefined,
        {
          limit: (args.limit as number) || 50,
          offset: (args.offset as number) || 0,
        }
      );

      return JSON.stringify(
        {
          success: true,
          tenantId: args.tenant_id,
          count: processes.length,
          processInstances: processes.map((p) => ({
            id: p.id,
            businessId: p.businessId,
            businessService: p.businessService,
            state: (p.state as Record<string, unknown>)?.state,
            action: p.action,
            assignee: p.assignee,
            comment: p.comment,
            createdTime: (p.auditDetails as Record<string, unknown>)?.createdTime,
          })),
        },
        null,
        2
      );
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
