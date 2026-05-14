import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

// Roles live in MDMS under this schema. tenant_bootstrap skips
// ACCESSCONTROL-ROLEACTIONS.roleactions because its x-ref-schema cross-refs
// don't survive a tenant-scoped dump cleanly. We follow that precedent here.
const ROLES_SCHEMA = 'ACCESSCONTROL-ROLES.roles';

interface Client {
  accessRolesSearch(tenantId: string): Promise<Record<string, unknown>[]>;
  mdmsV2SearchRaw(tenantId: string, schemaCode: string): Promise<Record<string, unknown>[]>;
  mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown): Promise<unknown>;
  mdmsV2Update(
    record: {
      id: string;
      tenantId: string;
      schemaCode: string;
      uniqueIdentifier: string;
      data: Record<string, unknown>;
      auditDetails?: unknown;
    },
    isActive: boolean,
  ): Promise<unknown>;
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
    // Mirror the mdms-data fix: keep the full live record so the overwrite
    // path can call mdmsV2Update (id/auditDetails/etc.). The role's `code`
    // lives in `data.code` for fresh records and falls back to `uniqueIdentifier`.
    const existingByCode = new Map<string, Record<string, unknown>>(
      existingRoles.map((r) => {
        const code = String((r.data as Record<string, unknown> | undefined)?.code ?? r.uniqueIdentifier ?? '');
        return [code, r] as const;
      }),
    );

    for await (const line of lines) {
      const role = JSON.parse(line) as Record<string, unknown> & { code: string };
      const code = role.code;
      const liveRecord = existingByCode.get(code);
      const present = liveRecord !== undefined;

      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: code }; return report; }

      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }

      try {
        if (present) {
          // ACCESSCONTROL-ROLES.roles enforces uniqueness strictly — a duplicate
          // create returns "Duplicate record" (not the phantom-200 we used to
          // get from older MDMS). Use Update with the full live record to
          // honour the overwrite semantics and re-activate any soft-deleted role.
          await client.mdmsV2Update(
            {
              ...(liveRecord as Record<string, unknown>),
              data: role as Record<string, unknown>,
            } as never,
            true,
          );
          report.updated++;
          existingByCode.set(code, { ...(liveRecord as Record<string, unknown>), data: role, isActive: true });
        } else {
          const created = await client.mdmsV2Create(targetRoot, ROLES_SCHEMA, code, role);
          report.created++;
          const createdRec = (created && typeof created === 'object')
            ? (created as Record<string, unknown>)
            : { tenantId: targetRoot, schemaCode: ROLES_SCHEMA, uniqueIdentifier: code, data: role, isActive: true };
          existingByCode.set(code, createdRec);
        }
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: code, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
