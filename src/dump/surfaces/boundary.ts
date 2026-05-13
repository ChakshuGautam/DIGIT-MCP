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

// DIGIT boundary-service raises this error when a tenant has no hierarchy
// definition yet. Treat it as "empty" rather than an abort.
const HIERARCHY_MISSING_TOKEN = 'HIERARCHY_DEFINITION_DOES_NOT_EXIST_ERR';
function isMissingHierarchyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(HIERARCHY_MISSING_TOKEN);
}

export const boundarySurface = {
  name: 'boundary' as const,

  async *dump(client: Client, tenantId: string, _opts: DumpOpts): AsyncIterable<string> {
    // Cheapest probe: hierarchy definitions. If the tenant has none, both
    // boundarySearch() and boundaryRelationshipTreeSearch() are guaranteed to
    // either return empty or throw HIERARCHY_DEFINITION_DOES_NOT_EXIST_ERR.
    // Either way there's nothing to dump — emit a single empty document and bail.
    const hierarchies = await client.boundaryHierarchySearch(tenantId);
    if (hierarchies.length === 0) {
      yield JSON.stringify({ hierarchies: [], entities: [], relationships: [] });
      return;
    }
    // Hierarchy defined but entities/relationships may still be empty or the
    // boundary-service may yet error on them — be defensive.
    let entities: Record<string, unknown>[] = [];
    try {
      entities = await client.boundarySearch(tenantId);
    } catch (err) {
      if (!isMissingHierarchyError(err)) throw err;
      entities = [];
    }
    let relTree: Record<string, unknown>[] = [];
    try {
      relTree = await client.boundaryRelationshipTreeSearch(tenantId);
    } catch (err) {
      if (!isMissingHierarchyError(err)) throw err;
      relTree = [];
    }
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

    // Existing state at target — guard each call for the empty-hierarchy case.
    // When the target tenant has no hierarchy definition yet, boundarySearch
    // and boundaryRelationshipTreeSearch throw HIERARCHY_DEFINITION_DOES_NOT_EXIST_ERR.
    // That's fine — the existence sets are empty and we proceed with creates.
    let existingHierarchies = new Set<string>();
    let existingEntities = new Set<string>();
    let existingRels = new Set<string>();

    try {
      const hs = await client.boundaryHierarchySearch(target);
      existingHierarchies = new Set(hs.map((h) => String(h.hierarchyType)));
    } catch (err) {
      if (!isMissingHierarchyError(err)) throw err;
    }

    if (existingHierarchies.size > 0) {
      try {
        existingEntities = new Set((await client.boundarySearch(target)).map((b) => String(b.code)));
      } catch (err) {
        if (!isMissingHierarchyError(err)) throw err;
      }
      try {
        const tree = await client.boundaryRelationshipTreeSearch(target);
        existingRels = new Set(flattenRels(tree as unknown as RelNode[], '').map((r) => r.code));
      } catch (err) {
        if (!isMissingHierarchyError(err)) throw err;
      }
    }

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
