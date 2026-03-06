import type { DataProvider, RaRecord, GetListResult, GetOneResult, GetManyResult, GetManyReferenceResult, CreateResult, UpdateResult, DeleteResult, Identifier } from 'ra-core';
import type { DigitApiClient } from '../client/DigitApiClient.js';
import type { MdmsRecord } from '../client/types.js';
import { getResourceConfig, type ResourceConfig } from './resourceRegistry.js';

// --- Helpers ---

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function extractId(record: Record<string, unknown>, config: ResourceConfig): string {
  const value = getNestedValue(record, config.idField);
  return value == null ? '' : String(value);
}

function normalizeRecord(raw: Record<string, unknown>, config: ResourceConfig): RaRecord {
  return { ...raw, id: extractId(raw, config) } as RaRecord;
}

function normalizeMdmsRecord(mdms: MdmsRecord, config: ResourceConfig): RaRecord {
  const data = mdms.data || {};
  return {
    ...data,
    id: extractId(data, config),
    _uniqueIdentifier: mdms.uniqueIdentifier,
    _isActive: mdms.isActive,
    _auditDetails: mdms.auditDetails,
    _schemaCode: mdms.schemaCode,
    _mdmsId: mdms.id,
  } as RaRecord;
}

function clientSort(records: RaRecord[], field: string, order: string): RaRecord[] {
  return [...records].sort((a, b) => {
    const aVal = getNestedValue(a as unknown as Record<string, unknown>, field);
    const bVal = getNestedValue(b as unknown as Record<string, unknown>, field);
    const cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
    return order === 'DESC' ? -cmp : cmp;
  });
}

function clientFilter(records: RaRecord[], filter: Record<string, unknown>): RaRecord[] {
  if (!filter || Object.keys(filter).length === 0) return records;
  return records.filter((record) =>
    Object.entries(filter).every(([key, value]) => {
      if (key === 'q' && typeof value === 'string') {
        const q = value.toLowerCase();
        return JSON.stringify(record).toLowerCase().includes(q);
      }
      const fieldVal = getNestedValue(record as unknown as Record<string, unknown>, key);
      return String(fieldVal ?? '').toLowerCase().includes(String(value).toLowerCase());
    }),
  );
}

function clientPaginate(records: RaRecord[], page: number, perPage: number): RaRecord[] {
  const start = (page - 1) * perPage;
  return records.slice(start, start + perPage);
}

// --- Service-specific fetchers ---

async function mdmsGetList(client: DigitApiClient, config: ResourceConfig, tenantId: string): Promise<RaRecord[]> {
  const records = await client.mdmsSearch(tenantId, config.schema!, { limit: 500 });
  return records.filter((r) => r.isActive).map((r) => normalizeMdmsRecord(r, config));
}

async function hrmsGetList(client: DigitApiClient, config: ResourceConfig, tenantId: string): Promise<RaRecord[]> {
  const employees = await client.employeeSearch(tenantId, { limit: 500 });
  return employees.map((e) => normalizeRecord(e, config));
}

async function boundaryGetList(client: DigitApiClient, config: ResourceConfig, tenantId: string): Promise<RaRecord[]> {
  const trees = await client.boundaryRelationshipSearch(tenantId, 'ADMIN');
  const flat: RaRecord[] = [];
  function flatten(nodes: unknown[], parentCode?: string) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as Record<string, unknown>[]) {
      flat.push(normalizeRecord({ ...node, parentCode }, config));
      if (Array.isArray(node.children)) flatten(node.children as unknown[], node.code as string);
    }
  }
  for (const tree of trees) {
    flatten((tree.boundary || []) as unknown[]);
  }
  return flat;
}

async function pgrGetList(client: DigitApiClient, config: ResourceConfig, tenantId: string, filter?: Record<string, unknown>): Promise<RaRecord[]> {
  const options: { status?: string; limit?: number } = { limit: 100 };
  if (filter?.status) options.status = String(filter.status);
  const wrappers = await client.pgrSearch(tenantId, options);
  return wrappers.map((w) => {
    const service = (w.service || w) as Record<string, unknown>;
    return normalizeRecord(service, config);
  });
}

async function localizationGetList(client: DigitApiClient, config: ResourceConfig, tenantId: string, filter?: Record<string, unknown>): Promise<RaRecord[]> {
  const module = filter?.module ? String(filter.module) : undefined;
  const messages = await client.localizationSearch(tenantId, 'en_IN', module);
  return messages.map((m) => normalizeRecord(m, config));
}

// --- Factory ---

export function createDigitDataProvider(client: DigitApiClient, tenantId: string): DataProvider {
  function resolveConfig(resource: string): ResourceConfig {
    const config = getResourceConfig(resource);
    if (!config) throw new Error(`Unknown resource: ${resource}`);
    return config;
  }

  async function fetchAll(resource: string, filter?: Record<string, unknown>): Promise<RaRecord[]> {
    const config = resolveConfig(resource);
    switch (config.type) {
      case 'mdms': return mdmsGetList(client, config, tenantId);
      case 'hrms': return hrmsGetList(client, config, tenantId);
      case 'boundary': return boundaryGetList(client, config, tenantId);
      case 'pgr': return pgrGetList(client, config, tenantId, filter);
      case 'localization': return localizationGetList(client, config, tenantId, filter);
      default: throw new Error(`Unsupported resource type: ${config.type}`);
    }
  }

  const provider: DataProvider = {
    async getList(resource, params): Promise<GetListResult> {
      const { page = 1, perPage = 25 } = params.pagination ?? {};
      const { field = 'id', order = 'ASC' } = params.sort ?? {};
      const all = await fetchAll(resource, params.filter);
      const filtered = clientFilter(all, params.filter);
      const sorted = clientSort(filtered, field, order);
      const data = clientPaginate(sorted, page, perPage);
      return { data, total: filtered.length };
    },

    async getOne(resource, params): Promise<GetOneResult> {
      const config = resolveConfig(resource);
      if (config.type === 'mdms') {
        // Try uniqueIdentifier lookup first (fast path for records we created)
        const records = await client.mdmsSearch(tenantId, config.schema!, { uniqueIdentifiers: [String(params.id)] });
        const active = records.filter((r) => r.isActive);
        if (active.length) return { data: normalizeMdmsRecord(active[0], config) };
        // Fall back to fetching all and matching by id field (handles hash-based UIDs)
        const all = await mdmsGetList(client, config, tenantId);
        const found = all.find((r) => String(r.id) === String(params.id));
        if (!found) throw new Error(`Record not found: ${params.id}`);
        return { data: found };
      }
      if (config.type === 'hrms') {
        // idField is 'uuid', so search by uuids first; fall back to codes for backward compat
        const byUuid = await client.employeeSearch(tenantId, { uuids: [String(params.id)] });
        if (byUuid.length) return { data: normalizeRecord(byUuid[0], config) };
        const byCodes = await client.employeeSearch(tenantId, { codes: [String(params.id)] });
        if (byCodes.length) return { data: normalizeRecord(byCodes[0], config) };
        throw new Error(`Employee not found: ${params.id}`);
      }
      if (config.type === 'pgr') {
        const wrappers = await client.pgrSearch(tenantId, { serviceRequestId: String(params.id) });
        if (!wrappers.length) throw new Error(`Complaint not found: ${params.id}`);
        const service = (wrappers[0].service || wrappers[0]) as Record<string, unknown>;
        return { data: normalizeRecord(service, config) };
      }
      if (config.type === 'boundary') {
        // Search entity table directly to get full data (additionalDetails, geometry, auditDetails)
        const entities = await client.boundarySearch(tenantId, [String(params.id)]);
        if (entities.length) {
          // Merge with tree data (boundaryType, parentCode) if available
          const all = await fetchAll(resource);
          const treeNode = all.find((r) => String(r.id) === String(params.id));
          const merged = { ...(treeNode || {}), ...entities[0], id: String(params.id) };
          return { data: normalizeRecord(merged as Record<string, unknown>, config) };
        }
        // Fall back to tree-only data
        const all = await fetchAll(resource);
        const found = all.find((r) => String(r.id) === String(params.id));
        if (!found) throw new Error(`Record not found: ${params.id}`);
        return { data: found };
      }
      const all = await fetchAll(resource);
      const found = all.find((r) => String(r.id) === String(params.id));
      if (!found) throw new Error(`Record not found: ${params.id}`);
      return { data: found };
    },

    async getMany(resource, params): Promise<GetManyResult> {
      const config = resolveConfig(resource);
      if (config.type === 'mdms') {
        // Try uniqueIdentifier lookup first (fast path)
        const records = await client.mdmsSearch(tenantId, config.schema!, {
          uniqueIdentifiers: params.ids.map(String),
        });
        const found = records.filter((r) => r.isActive).map((r) => normalizeMdmsRecord(r, config));
        if (found.length === params.ids.length) return { data: found };
        // Fall back to fetching all and matching by id field (handles hash-based UIDs)
        const all = await mdmsGetList(client, config, tenantId);
        const ids = new Set(params.ids.map(String));
        return { data: all.filter((r) => ids.has(String(r.id))) };
      }
      const all = await fetchAll(resource);
      const ids = new Set(params.ids.map(String));
      return { data: all.filter((r) => ids.has(String(r.id))) };
    },

    async getManyReference(resource, params): Promise<GetManyReferenceResult> {
      const all = await fetchAll(resource);
      const filtered = all.filter((r) => {
        const val = getNestedValue(r as unknown as Record<string, unknown>, params.target);
        return String(val) === String(params.id);
      });
      const sorted = clientSort(filtered, params.sort.field, params.sort.order);
      const { page, perPage } = params.pagination;
      const data = clientPaginate(sorted, page, perPage);
      return { data, total: filtered.length };
    },

    async create(resource, params): Promise<CreateResult> {
      const config = resolveConfig(resource);
      if (config.type === 'mdms') {
        const data = params.data as Record<string, unknown>;
        const uid = String(data[config.idField] || data.code || '');
        const record = await client.mdmsCreate(tenantId, config.schema!, uid, data);
        return { data: normalizeMdmsRecord(record, config) };
      }
      if (config.type === 'hrms') {
        const [employee] = await client.employeeCreate(tenantId, [params.data as Record<string, unknown>]);
        return { data: normalizeRecord(employee, config) };
      }
      if (config.type === 'pgr') {
        const data = params.data as Record<string, unknown>;
        const wrapper = await client.pgrCreate(
          tenantId,
          String(data.serviceCode),
          String(data.description || ''),
          (data.address || { locality: { code: '' } }) as Record<string, unknown>,
          data.citizen as Record<string, unknown> | undefined,
        );
        const service = ((wrapper as Record<string, unknown>).service || wrapper) as Record<string, unknown>;
        return { data: normalizeRecord(service, config) };
      }
      if (config.type === 'localization') {
        const data = params.data as Record<string, unknown>;
        const messages = await client.localizationUpsert(tenantId, String(data.locale || 'en_IN'), [
          { code: String(data.code), message: String(data.message), module: String(data.module) },
        ]);
        if (messages.length) return { data: normalizeRecord(messages[0], config) };
        return { data: { ...data, id: String(data.code) } as RaRecord };
      }
      if (config.type === 'boundary') {
        const data = params.data as Record<string, unknown>;
        const code = String(data.code);
        const boundaryType = String(data.boundaryType || 'Locality');
        const hierarchyType = String(data.hierarchyType || 'ADMIN');
        const parent = data.parent ? String(data.parent) : null;
        // Create the boundary entity (publishes to Kafka for async persistence)
        await client.boundaryCreate(tenantId, [{ code }]);
        // Retry relationship create — entity may not be persisted yet (Kafka async)
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await client.boundaryRelationshipCreate(tenantId, code, hierarchyType, boundaryType, parent);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err as Error;
            if (lastErr.message?.includes('does not exist') && attempt < 4) {
              await new Promise((r) => setTimeout(r, 500));
              continue;
            }
            throw err;
          }
        }
        if (lastErr) throw lastErr;
        return { data: { ...data, id: code, code, boundaryType } as RaRecord };
      }
      throw new Error(`Create not supported for resource type: ${config.type}`);
    },

    async update(resource, params): Promise<UpdateResult> {
      const config = resolveConfig(resource);
      if (config.type === 'mdms') {
        const records = await client.mdmsSearch(tenantId, config.schema!, { uniqueIdentifiers: [String(params.id)] });
        const existing = records.find((r) => r.isActive);
        if (!existing) throw new Error(`Record not found: ${params.id}`);
        existing.data = { ...existing.data, ...(params.data as Record<string, unknown>) };
        const updated = await client.mdmsUpdate(existing, true);
        return { data: normalizeMdmsRecord(updated, config) };
      }
      if (config.type === 'hrms') {
        const [employee] = await client.employeeUpdate(tenantId, [params.data as Record<string, unknown>]);
        return { data: normalizeRecord(employee, config) };
      }
      if (config.type === 'pgr') {
        const data = params.data as Record<string, unknown>;
        const action = String(data.action || data._action || 'ASSIGN');
        // Fetch current service state
        const wrappers = await client.pgrSearch(tenantId, { serviceRequestId: String(params.id) });
        if (!wrappers.length) throw new Error(`Complaint not found: ${params.id}`);
        const service = ((wrappers[0] as Record<string, unknown>).service || wrappers[0]) as Record<string, unknown>;
        const updated = await client.pgrUpdate(service, action, {
          comment: data.comment as string | undefined,
          assignees: data.assignees as string[] | undefined,
          rating: data.rating as number | undefined,
        });
        const updatedService = ((updated as Record<string, unknown>).service || updated) as Record<string, unknown>;
        return { data: normalizeRecord(updatedService, config) };
      }
      if (config.type === 'localization') {
        const data = params.data as Record<string, unknown>;
        const messages = await client.localizationUpsert(tenantId, String(data.locale || 'en_IN'), [
          { code: String(data.code || params.id), message: String(data.message), module: String(data.module) },
        ]);
        if (messages.length) return { data: normalizeRecord(messages[0], config) };
        return { data: { ...data, id: String(data.code || params.id) } as RaRecord };
      }
      if (config.type === 'boundary') {
        const data = params.data as Record<string, unknown>;
        const code = String(data.code || params.id);
        // Fetch existing boundary to get auditDetails (required by _update)
        const existing = await client.boundarySearch(tenantId, [code]);
        const current = existing.length ? existing[0] as Record<string, unknown> : {};
        const merged: Record<string, unknown> = { ...current, code };
        if (data.additionalDetails !== undefined) merged.additionalDetails = data.additionalDetails;
        if (data.geometry !== undefined) merged.geometry = data.geometry;
        const updated = await client.boundaryUpdate(tenantId, [merged]);
        if (updated.length) return { data: normalizeRecord(updated[0], config) };
        return { data: { ...data, id: code } as RaRecord };
      }
      throw new Error(`Update not supported for resource type: ${config.type}`);
    },

    async updateMany(resource, params): Promise<{ data: Identifier[] }> {
      const results: Identifier[] = [];
      for (const id of params.ids) {
        await provider.update(resource, { id, data: params.data, previousData: {} as RaRecord });
        results.push(id);
      }
      return { data: results };
    },

    async delete(resource, params): Promise<DeleteResult> {
      const config = resolveConfig(resource);
      if (config.type === 'mdms') {
        const records = await client.mdmsSearch(tenantId, config.schema!, { uniqueIdentifiers: [String(params.id)] });
        const existing = records.find((r) => r.isActive);
        if (!existing) throw new Error(`Record not found: ${params.id}`);
        await client.mdmsUpdate(existing, false);
        return { data: normalizeMdmsRecord(existing, config) };
      }
      if (config.type === 'hrms') {
        // Search by UUID first (idField is 'uuid'), fall back to codes
        let results = await client.employeeSearch(tenantId, { uuids: [String(params.id)] });
        if (!results.length) results = await client.employeeSearch(tenantId, { codes: [String(params.id)] });
        if (!results.length) throw new Error(`Employee not found: ${params.id}`);
        let emp = results[0] as Record<string, unknown>;
        // If user is null (UUID search may omit user), re-fetch by code to get full object
        if (!emp.user && emp.code) {
          const byCode = await client.employeeSearch(tenantId, { codes: [emp.code as string] });
          if (byCode.length) emp = byCode[0] as Record<string, unknown>;
        }
        emp.isActive = false;
        emp.deactivationDetails = [{ reasonForDeactivation: 'OTHERS', effectiveFrom: Date.now() }];
        const [updated] = await client.employeeUpdate(tenantId, [emp]);
        return { data: normalizeRecord(updated, config) };
      }
      if (config.type === 'pgr') {
        // "Delete" a complaint by rejecting it via workflow
        const wrappers = await client.pgrSearch(tenantId, { serviceRequestId: String(params.id) });
        if (!wrappers.length) throw new Error(`Complaint not found: ${params.id}`);
        const service = ((wrappers[0] as Record<string, unknown>).service || wrappers[0]) as Record<string, unknown>;
        const appStatus = String(service.applicationStatus || '');
        // If already in a terminal state, return as-is
        if (['REJECTED', 'CLOSEDAFTERRESOLUTION'].includes(appStatus)) {
          return { data: normalizeRecord(service, config) };
        }
        // Reject the complaint (GRO action, works from PENDINGFORASSIGNMENT)
        const updated = await client.pgrUpdate(service, 'REJECT', { comment: 'Deleted via DataProvider' });
        const updatedService = ((updated as Record<string, unknown>).service || updated) as Record<string, unknown>;
        return { data: normalizeRecord(updatedService, config) };
      }
      if (config.type === 'localization') {
        const all = await fetchAll('localization');
        const record = all.find((r) => String(r.id) === String(params.id));
        if (!record) throw new Error(`Localization message not found: ${params.id}`);
        const loc = record as unknown as Record<string, unknown>;
        await client.localizationDelete(tenantId, String(loc.locale || 'en_IN'), [
          { code: String(loc.code), module: String(loc.module) },
        ]);
        return { data: record };
      }
      if (config.type === 'boundary') {
        const all = await fetchAll('boundaries');
        const record = all.find((r) => String(r.id) === String(params.id));
        if (!record) throw new Error(`Boundary not found: ${params.id}`);
        const code = String(params.id);
        try {
          await client.boundaryRelationshipDelete(tenantId, code, 'ADMIN');
        } catch { /* relationship may not exist */ }
        await client.boundaryDelete(tenantId, [code]);
        return { data: record };
      }
      throw new Error(`Delete not supported for resource type: ${config.type}`);
    },

    async deleteMany(resource, params): Promise<{ data: Identifier[] }> {
      const results: Identifier[] = [];
      for (const id of params.ids) {
        await provider.delete(resource, { id, previousData: {} as RaRecord });
        results.push(id);
      }
      return { data: results };
    },
  };

  return provider;
}
