import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

const REGISTRY_PREFIX = 'mcp-dumps.';

interface Client {
  mdmsSchemaSearch(tenantId: string, codes?: string[]): Promise<Record<string, unknown>[]>;
  mdmsV2SearchRaw(tenantId: string, schemaCode: string, options?: { limit?: number; offset?: number }): Promise<Record<string, unknown>[]>;
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

export const mdmsDataSurface = {
  name: 'mdms-data' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const schemas = (await client.mdmsSchemaSearch(tenantId))
      .map((s) => String(s.code))
      .filter((c) => !c.startsWith(REGISTRY_PREFIX));

    for (const schemaCode of schemas) {
      let offset = 0;
      const limit = 500;
      while (true) {
        const page = await client.mdmsV2SearchRaw(tenantId, schemaCode, { limit, offset });
        if (page.length === 0) break;
        for (const row of page) yield JSON.stringify(row);
        if (page.length < limit) break;
        offset += limit;
      }
    }
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = {
      surface: 'mdms-data',
      created: 0, updated: 0, skipped: 0, failed: 0, errors: [],
    };
    // Cache per schemaCode: uniqueIdentifier -> full live record. We need the
    // full record (not just the uid) so the overwrite path can call
    // mdmsV2Update with id/auditDetails/etc.
    const existsCache = new Map<string, Map<string, Record<string, unknown>>>();

    async function loadCache(schemaCode: string): Promise<Map<string, Record<string, unknown>>> {
      let m = existsCache.get(schemaCode);
      if (!m) {
        const rows = await client.mdmsV2SearchRaw(target, schemaCode);
        m = new Map(rows.map((r) => [String(r.uniqueIdentifier ?? ''), r] as const));
        existsCache.set(schemaCode, m);
      }
      return m;
    }

    async function findExisting(schemaCode: string, uid: string): Promise<Record<string, unknown> | undefined> {
      const m = await loadCache(schemaCode);
      return m.get(uid);
    }

    for await (const line of lines) {
      const row = JSON.parse(line) as { schemaCode: string; uniqueIdentifier: string; data: unknown };
      const uid = String(row.uniqueIdentifier);
      const liveRecord = await findExisting(row.schemaCode, uid);
      const present = liveRecord !== undefined;

      if (present) {
        if (opts.onConflict === 'skip')     { report.skipped++; continue; }
        if (opts.onConflict === 'fail')     { report.abortedAt = { identifier: `${row.schemaCode}/${uid}` }; return report; }
      }

      if (opts.dryRun) {
        if (present) report.updated++; else report.created++;
        continue;
      }

      try {
        if (present) {
          // DIGIT MDMS v2 has a "phantom 200" gotcha: a duplicate create
          // returns 200 with an empty mdms[] array but does NOT update the
          // existing record. We must call mdmsV2Update for the overwrite
          // path with the full live record + isActive=true (so soft-deleted
          // records get re-activated).
          await client.mdmsV2Update(
            {
              ...(liveRecord as Record<string, unknown>),
              data: row.data as Record<string, unknown>,
            } as never,
            true,
          );
          report.updated++;
          // Refresh cache entry with the latest data + isActive=true.
          const cached = existsCache.get(row.schemaCode)!;
          cached.set(uid, { ...(liveRecord as Record<string, unknown>), data: row.data, isActive: true });
        } else {
          const created = await client.mdmsV2Create(target, row.schemaCode, uid, row.data);
          report.created++;
          // Add to cache so subsequent rows in the same restore don't re-create.
          const cached = existsCache.get(row.schemaCode);
          if (cached) {
            const createdRec = (created && typeof created === 'object')
              ? (created as Record<string, unknown>)
              : { tenantId: target, schemaCode: row.schemaCode, uniqueIdentifier: uid, data: row.data, isActive: true };
            cached.set(uid, createdRec);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errObj = err as { code?: string; errors?: { code?: string }[] } | undefined;
        // DIGIT MDMS protects fields listed in `x-unique` from being modified
        // by an update — the API returns "Updating fields defined as unique is
        // not allowed" / `MDMS_UNIQUE_FIELD_UPDATE_ERR`. Faithful round-trips
        // hit this on records the dump captured verbatim. Treat as a no-op:
        // downgrade to skipped, but keep an info-note in errors so the
        // operator sees the count.
        const isXUniqueProtected =
          msg.includes('Updating fields defined as unique is not allowed') ||
          errObj?.code === 'MDMS_UNIQUE_FIELD_UPDATE_ERR' ||
          (Array.isArray(errObj?.errors) && errObj.errors.some((e) => e?.code === 'MDMS_UNIQUE_FIELD_UPDATE_ERR'));
        if (isXUniqueProtected) {
          report.skipped++;
          report.errors.push({ identifier: `${row.schemaCode}/${uid}`, message: `note: x-unique field protection — skipped: ${msg}` });
        } else {
          report.failed++;
          report.errors.push({ identifier: `${row.schemaCode}/${uid}`, message: msg });
        }
      }
    }
    return report;
  },
};
