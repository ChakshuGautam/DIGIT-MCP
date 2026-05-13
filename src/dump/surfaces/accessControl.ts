import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

// Roles live in MDMS under this schema. tenant_bootstrap skips
// ACCESSCONTROL-ROLEACTIONS.roleactions because its x-ref-schema cross-refs
// don't survive a tenant-scoped dump cleanly. We follow that precedent here.
const ROLES_SCHEMA = 'ACCESSCONTROL-ROLES.roles';

interface Client {
  accessRolesSearch(tenantId: string): Promise<Record<string, unknown>[]>;
  mdmsV2SearchRaw(tenantId: string, schemaCode: string): Promise<Record<string, unknown>[]>;
  mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown): Promise<unknown>;
}

function rootOf(tenantId: string): string {
  return tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;
}

export const accessControlSurface = {
  name: 'access-control' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const roles = await client.accessRolesSearch(tenantId);
    for (const r of roles) yield JSON.stringify(r);
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = { surface: 'access-control', created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

    const targetRoot = rootOf(target);
    const existingRoles = await client.mdmsV2SearchRaw(targetRoot, ROLES_SCHEMA);
    const existingCodes = new Set(
      existingRoles.map((r) => String((r.data as Record<string, unknown> | undefined)?.code ?? r.uniqueIdentifier ?? '')),
    );

    for await (const line of lines) {
      const role = JSON.parse(line) as Record<string, unknown> & { code: string };
      const code = role.code;
      const present = existingCodes.has(code);

      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: code }; return report; }

      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }

      try {
        await client.mdmsV2Create(targetRoot, ROLES_SCHEMA, code, role);
        if (present) report.updated++; else report.created++;
        existingCodes.add(code);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: code, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
