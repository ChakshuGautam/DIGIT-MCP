import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

const DEFAULT_LOCALES = ['en_IN', 'en_US'];

interface Client {
  mdmsV2SearchRaw(tenantId: string, schemaCode: string): Promise<Record<string, unknown>[]>;
  localizationSearch(tenantId: string, locale: string, module?: string): Promise<Record<string, unknown>[]>;
  localizationUpsert(tenantId: string, locale: string, messages: { code: string; message: string; module: string }[]): Promise<Record<string, unknown>[]>;
}

function rootOf(tenantId: string): string {
  return tenantId.includes('.') ? tenantId.split('.')[0] : tenantId;
}

export const localizationSurface = {
  name: 'localization' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const locales = new Set<string>(DEFAULT_LOCALES);
    const stateInfo = await client.mdmsV2SearchRaw(rootOf(tenantId), 'common-masters.StateInfo');
    for (const row of stateInfo) {
      const data = (row.data || row) as { languages?: Array<{ value?: string }> };
      for (const l of data.languages || []) if (l.value) locales.add(l.value);
    }

    for (const locale of locales) {
      const messages = await client.localizationSearch(tenantId, locale);
      for (const m of messages) {
        yield JSON.stringify({ locale, ...m });
      }
    }
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = { surface: 'localization', created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

    // Collect all lines first to plan per-(locale, module) existence pre-fetches
    const allLines: { locale: string; code: string; message: string; module: string }[] = [];
    for await (const line of lines) {
      const row = JSON.parse(line) as { locale: string; code: string; message: string; module: string };
      allLines.push(row);
    }

    const localeModulePairs = new Set<string>();
    for (const row of allLines) localeModulePairs.add(`${row.locale}::${row.module}`);

    const existing = new Set<string>();
    for (const key of localeModulePairs) {
      const [locale, module] = key.split('::');
      const live = await client.localizationSearch(target, locale, module);
      for (const m of live) existing.add(`${locale}::${module}::${String(m.code)}`);
    }

    for (const row of allLines) {
      const key = `${row.locale}::${row.module}::${row.code}`;
      const present = existing.has(key);

      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: key }; return report; }

      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }

      try {
        await client.localizationUpsert(target, row.locale, [{ code: row.code, message: row.message, module: row.module }]);
        if (present) report.updated++; else report.created++;
        existing.add(key);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: key, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
