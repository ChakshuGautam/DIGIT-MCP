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
        // overwrite: DIGIT MDMS has no schema-update primitive, and a duplicate
        // create returns 400 (`Schema code already exists` /
        // `SCHEMA_ALREADY_EXISTS_ERR`). The schema is already in place at the
        // target, so the operator's intent is satisfied — record as skipped.
        report.skipped++;
        continue;
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
        // Race condition: another writer (or a parallel restore) created the
        // schema between our search and our create. DIGIT returns
        // `SCHEMA_ALREADY_EXISTS_ERR` / "Schema code already exists" — downgrade
        // to skipped (still record an info-note in errors for visibility).
        const msg = err instanceof Error ? err.message : String(err);
        const errCode = (err as { code?: string; errors?: { code?: string }[] } | undefined);
        const isAlreadyExists =
          msg.includes('Schema code already exists') ||
          errCode?.code === 'SCHEMA_ALREADY_EXISTS_ERR' ||
          (Array.isArray(errCode?.errors) && errCode.errors.some((e) => e?.code === 'SCHEMA_ALREADY_EXISTS_ERR'));
        if (isAlreadyExists) {
          report.skipped++;
          report.errors.push({ identifier: code, message: `note: schema already exists at target (race) — skipped: ${msg}` });
          existing.add(code);
        } else {
          report.failed++;
          report.errors.push({ identifier: code, message: msg });
        }
      }
    }
    return report;
  },
};
