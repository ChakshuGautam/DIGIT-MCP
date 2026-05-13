import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

interface Client {
  workflowBusinessServiceSearch(tenantId: string, businessServices?: string[]): Promise<Record<string, unknown>[]>;
  workflowBusinessServiceCreate(tenantId: string, businessService: Record<string, unknown>): Promise<Record<string, unknown>>;
  workflowBusinessServiceUpdate(tenantId: string, businessService: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export const workflowSurface = {
  name: 'workflow' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const services = await client.workflowBusinessServiceSearch(tenantId);
    for (const svc of services) yield JSON.stringify(svc);
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = { surface: 'workflow', created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

    const existingServices = await client.workflowBusinessServiceSearch(target);
    const existing = new Set(existingServices.map((s) => String(s.businessService)));

    for await (const line of lines) {
      const svc = JSON.parse(line) as Record<string, unknown> & { businessService: string };
      const code = svc.businessService;
      const present = existing.has(code);

      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: code }; return report; }

      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }

      try {
        if (present) {
          await client.workflowBusinessServiceUpdate(target, svc);
          report.updated++;
        } else {
          await client.workflowBusinessServiceCreate(target, svc);
          report.created++;
          existing.add(code);
        }
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: code, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  },
};
