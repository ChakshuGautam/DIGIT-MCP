import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

const REGISTRY_PREFIX = 'mcp-dumps.';

interface Client {
  mdmsSchemaSearch(tenantId: string, codes?: string[]): Promise<Record<string, unknown>[]>;
  mdmsSchemaCreate(tenantId: string, code: string, description: string, definition: unknown): Promise<Record<string, unknown>>;
}

export const mdmsSchemasSurface = {
  name: 'mdms-schemas' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const schemas = await client.mdmsSchemaSearch(tenantId);
    for (const s of schemas) {
      const code = String(s.code);
      if (code.startsWith(REGISTRY_PREFIX)) continue;
      yield JSON.stringify(s);
    }
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = {
      surface: 'mdms-schemas',
      created: 0, updated: 0, skipped: 0, failed: 0, errors: [],
    };
    const existing = new Set(
      (await client.mdmsSchemaSearch(target)).map((s) => String(s.code)),
    );

    for await (const line of lines) {
      const s = JSON.parse(line) as { code: string; description?: string; definition?: unknown };
      const code = s.code;
      const exists = existing.has(code);

      if (exists) {
        if (opts.onConflict === 'skip')      { report.skipped++; continue; }
        if (opts.onConflict === 'fail')      { report.abortedAt = { identifier: code }; return report; }
        // overwrite: MDMS schema create is upsert on code
      }

      if (opts.dryRun) {
        if (exists) report.updated++; else report.created++;
        continue;
      }

      try {
        await client.mdmsSchemaCreate(target, code, s.description || '', s.definition || {});
        if (exists) report.updated++; else report.created++;
        existing.add(code);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: code, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
