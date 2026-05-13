import type { DumpOpts, RestoreOpts, SurfaceReport } from '../types.js';

interface RelNode {
  code: string;
  parent?: string | null;
  children?: RelNode[];
  boundaryType?: string;
  hierarchyType?: string;
}

interface Client {
  boundaryHierarchySearch(tenantId: string, hierarchyType?: string): Promise<Record<string, unknown>[]>;
  boundarySearch(tenantId: string, hierarchyType?: string, options?: { limit?: number; offset?: number }): Promise<Record<string, unknown>[]>;
  boundaryRelationshipTreeSearch(tenantId: string, hierarchyType?: string): Promise<Record<string, unknown>[]>;
  boundaryHierarchyCreate(tenantId: string, hierarchyType: string, boundaryHierarchy: { boundaryType: string; parentBoundaryType: string | null; active?: boolean }[]): Promise<Record<string, unknown>>;
  boundaryCreate(tenantId: string, boundaries: { code: string; tenantId?: string; geometry?: Record<string, unknown> }[]): Promise<Record<string, unknown>[]>;
  boundaryRelationshipCreate(tenantId: string, code: string, hierarchyType: string, boundaryType: string, parent: string | null): Promise<Record<string, unknown>>;
}

// Flatten a relationship tree into a flat list of { code, parent, boundaryType, hierarchyType } records
function flattenRels(nodes: RelNode[], hierarchyType: string): Array<{ code: string; parent: string | null; boundaryType: string; hierarchyType: string }> {
  const out: Array<{ code: string; parent: string | null; boundaryType: string; hierarchyType: string }> = [];
  function walk(n: RelNode, parent: string | null) {
    if (n.code) {
      out.push({
        code: n.code,
        parent: parent,
        boundaryType: n.boundaryType || '',
        hierarchyType: n.hierarchyType || hierarchyType,
      });
    }
    for (const child of n.children || []) walk(child, n.code);
  }
  for (const n of nodes) walk(n, n.parent ?? null);
  return out;
}

export const boundarySurface = {
  name: 'boundary' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    const hierarchies = await client.boundaryHierarchySearch(tenantId);
    const entities = await client.boundarySearch(tenantId);
    const relTree = await client.boundaryRelationshipTreeSearch(tenantId);
    yield JSON.stringify({ hierarchies, entities, relationships: relTree });
  },

  async restore(
    client: Client,
    lines: AsyncIterable<string>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport> {
    const report: SurfaceReport = { surface: 'boundary', created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

    // Read the single line
    let doc: { hierarchies: Record<string, unknown>[]; entities: Record<string, unknown>[]; relationships: RelNode[] } | undefined;
    for await (const line of lines) {
      doc = JSON.parse(line);
      break;  // only one expected
    }
    if (!doc) return report;

    // Existing state at target
    const existingHierarchies = new Set(
      (await client.boundaryHierarchySearch(target)).map((h) => String(h.hierarchyType)),
    );
    const existingEntities = new Set(
      (await client.boundarySearch(target)).map((b) => String(b.code)),
    );
    const existingRelTree = await client.boundaryRelationshipTreeSearch(target);
    const existingRels = new Set(flattenRels(existingRelTree as unknown as RelNode[], '').map((r) => r.code));

    // Stage 1: hierarchies
    for (const h of doc.hierarchies) {
      const ht = String(h.hierarchyType);
      const present = existingHierarchies.has(ht);
      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: `hierarchy:${ht}` }; return report; }
      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }
      try {
        const bh = (h.boundaryHierarchy || []) as { boundaryType: string; parentBoundaryType: string | null; active?: boolean }[];
        await client.boundaryHierarchyCreate(target, ht, bh);
        if (present) report.updated++; else report.created++;
        existingHierarchies.add(ht);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: `hierarchy:${ht}`, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Stage 2: entities (batch)
    const toCreate: { code: string; tenantId?: string; geometry?: Record<string, unknown> }[] = [];
    for (const e of doc.entities) {
      const code = String(e.code);
      const present = existingEntities.has(code);
      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: `entity:${code}` }; return report; }
      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }
      toCreate.push({ code, tenantId: String(e.tenantId || target), geometry: e.geometry as Record<string, unknown> | undefined });
    }
    if (toCreate.length > 0) {
      try {
        await client.boundaryCreate(target, toCreate);
        report.created += toCreate.length;
        for (const e of toCreate) existingEntities.add(e.code);
      } catch (err) {
        report.failed += toCreate.length;
        report.errors.push({ identifier: 'boundary_create_batch', message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Stage 3: relationships (flatten the tree, create each)
    const flatRels = flattenRels(doc.relationships, doc.hierarchies[0] ? String(doc.hierarchies[0].hierarchyType) : '');
    for (const r of flatRels) {
      const present = existingRels.has(r.code);
      if (present && opts.onConflict === 'skip') { report.skipped++; continue; }
      if (present && opts.onConflict === 'fail') { report.abortedAt = { identifier: `relationship:${r.code}` }; return report; }
      if (opts.dryRun) { if (present) report.updated++; else report.created++; continue; }
      try {
        await client.boundaryRelationshipCreate(target, r.code, r.hierarchyType, r.boundaryType, r.parent);
        if (present) report.updated++; else report.created++;
        existingRels.add(r.code);
      } catch (err) {
        report.failed++;
        report.errors.push({ identifier: `relationship:${r.code}`, message: err instanceof Error ? err.message : String(err) });
      }
    }

    return report;
  },
};
