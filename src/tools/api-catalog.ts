import type { ToolMetadata } from '../types/index.js';
import type { ToolRegistry } from './registry.js';
import { digitApi } from '../services/digit-api.js';
import { buildOpenApiSpec, getServiceSummary, getServiceTags } from '../data/openapi-spec.js';

export function registerApiCatalogTools(registry: ToolRegistry): void {
  registry.register({
    name: 'api_catalog',
    group: 'docs',
    category: 'docs',
    risk: 'read',
    description:
      'Get the complete DIGIT platform API catalog as an OpenAPI 3.0 specification. ' +
      'Covers all 14 services (37 endpoints): Auth, User, MDMS, Boundary, HRMS, PGR, Workflow, ' +
      'Localization, Filestore, Access Control, ID Generation, Location, Encryption, and Boundary Management. ' +
      'Filter by service name to get just that service\'s endpoints. ' +
      'Use format "summary" for a quick overview or "openapi" for the full spec with request/response schemas. ' +
      'Useful for UI developers integrating with DIGIT APIs and for agents building API calls.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        service: {
          type: 'string',
          description:
            'Filter by service name (case-insensitive). Options: Auth, User, MDMS, Boundary, ' +
            '"Boundary Management", HRMS, PGR, Workflow, Localization, Filestore, ' +
            '"Access Control", "ID Generation", Location, Encryption. Omit for all services.',
        },
        format: {
          type: 'string',
          enum: ['summary', 'openapi'],
          description:
            'Output format. "summary" returns a compact listing of all services and endpoints. ' +
            '"openapi" returns the full OpenAPI 3.0 JSON spec with schemas. Default: "summary".',
        },
      },
    },
    handler: async (args) => {
      const serviceFilter = args.service as string | undefined;
      const format = (args.format as string) || 'summary';
      const envInfo = digitApi.getEnvironmentInfo();
      const baseUrl = envInfo.url;

      const spec = buildOpenApiSpec(baseUrl);

      // ── Summary mode ──
      if (format === 'summary') {
        const summary = getServiceSummary(spec);

        // Apply service filter if given
        const filtered = serviceFilter
          ? summary.filter((s) => s.service.toLowerCase().includes(serviceFilter.toLowerCase()))
          : summary;

        if (filtered.length === 0 && serviceFilter) {
          return JSON.stringify(
            {
              success: false,
              error: `No service matching "${serviceFilter}" found.`,
              availableServices: getServiceTags(),
              hint: 'Use one of the available service names, or omit the filter to see all.',
            },
            null,
            2,
          );
        }

        const totalEndpoints = filtered.reduce((sum, s) => sum + s.endpointCount, 0);

        return JSON.stringify(
          {
            success: true,
            environment: envInfo.name,
            baseUrl,
            serviceCount: filtered.length,
            totalEndpoints,
            services: filtered,
            hint:
              'Use format "openapi" to get the full OpenAPI 3.0 spec with request/response schemas. ' +
              'Filter by service name to narrow results (e.g. service: "PGR").',
          },
          null,
          2,
        );
      }

      // ── OpenAPI mode ──
      if (serviceFilter) {
        // Filter paths to only include the requested service tag
        const matchTag = getServiceTags().find(
          (t) => t.toLowerCase() === serviceFilter.toLowerCase() ||
                 t.toLowerCase().includes(serviceFilter.toLowerCase()),
        );

        if (!matchTag) {
          return JSON.stringify(
            {
              success: false,
              error: `No service matching "${serviceFilter}" found.`,
              availableServices: getServiceTags(),
            },
            null,
            2,
          );
        }

        // Build a filtered spec with only paths for this service
        const filteredPaths: Record<string, Record<string, unknown>> = {};
        for (const [path, methods] of Object.entries(spec.paths)) {
          const filteredMethods: Record<string, unknown> = {};
          for (const [method, op] of Object.entries(methods)) {
            const operation = op as Record<string, unknown>;
            const tags = (operation.tags || []) as string[];
            if (tags.includes(matchTag)) {
              filteredMethods[method] = operation;
            }
          }
          if (Object.keys(filteredMethods).length > 0) {
            filteredPaths[path] = filteredMethods;
          }
        }

        const filteredSpec = {
          ...spec,
          info: { ...spec.info as Record<string, unknown>, title: `DIGIT Platform API — ${matchTag}` },
          tags: (spec.tags as Array<Record<string, unknown>>).filter((t) => t.name === matchTag),
          paths: filteredPaths,
        };

        return JSON.stringify(
          {
            success: true,
            service: matchTag,
            format: 'openapi',
            spec: filteredSpec,
          },
          null,
          2,
        );
      }

      // Full spec
      return JSON.stringify(
        {
          success: true,
          format: 'openapi',
          spec,
        },
        null,
        2,
      );
    },
  } satisfies ToolMetadata);
}
