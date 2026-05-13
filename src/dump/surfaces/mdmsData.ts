import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

const REGISTRY_PREFIX = 'mcp-dumps.';

interface Client {
  mdmsSchemaSearch(tenantId: string, codes?: string[]): Promise<Record<string, unknown>[]>;
  mdmsV2SearchRaw(tenantId: string, schemaCode: string, options?: { limit?: number; offset?: number }): Promise<Record<string, unknown>[]>;
  mdmsV2Create(tenantId: string, schemaCode: string, uniqueIdentifier: string, data: unknown): Promise<unknown>;
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
    const existsCache = new Map<string, Set<string>>();

    async function exists(schemaCode: string, uid: string): Promise<boolean> {
      let set = existsCache.get(schemaCode);
      if (!set) {
        const rows = await client.mdmsV2SearchRaw(target, schemaCode);
        set = new Set(rows.map((r) => String(r.uniqueIdentifier ?? '')));
        existsCache.set(schemaCode, set);
      }
      return set.has(uid);
    }

    for await (const line of lines) {
      const row = JSON.parse(line) as { schemaCode: string; uniqueIdentifier: string; data: unknown };
      const uid = String(row.uniqueIdentifier);
      const present = await exists(row.schemaCode, uid);

      if (present) {
        if (opts.onConflict === 'skip')     { report.skipped++; continue; }
        if (opts.onConflict === 'fail')     { report.abortedAt = { identifier: `${row.schemaCode}/${uid}` }; return report; }
      }

      if (opts.dryRun) {
        if (present) report.updated++; else report.created++;
        continue;
      }

      try {
        await client.mdmsV2Create(target, row.schemaCode, uid, row.data);
        if (present) report.updated++; else report.created++;
        existsCache.get(row.schemaCode)!.add(uid);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: `${row.schemaCode}/${uid}`, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
