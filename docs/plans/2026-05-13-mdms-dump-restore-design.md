# MDMS Dump / Restore for DIGIT MCP — Design

**Date**: 2026-05-13
**Status**: Approved (ready for implementation plan)
**Owner**: TASK-029 (`/root/outputs/TASK-029-mdms-dump-restore.md`)
**Validation target**: Bomet (`egov-bomet`, `bometfeedbackhub.digit.org`)

---

## Goal

Add `mdms_dump`, `mdms_restore`, and `mdms_dumps_list` MCP tools that together let an operator snapshot a tenant's full MDMS-shaped configuration to a portable, versioned artifact and re-apply it to the same tenant (or another tenant under the same root).

Validate end-to-end on Bomet's live DIGIT stack. Deploy the patched MCP to Bomet.

`tenant_bootstrap` stays in place for v1; the refactor positions us to alias it onto `mdms_restore` in v2 once cross-root substitution is built.

---

## Background

The DIGIT platform's own "default data handler" — `egov-data-uploader` at `/root/code/Digit-Core/core-services/egov-data-uploader/` — is upload-only, Excel-driven, single-tenant per job. It cannot export. It does not handle boundaries, workflow definitions, or access control. The gap analysis lives in `outputs/TASK-029-mdms-dump-restore.md` (Synthesis section). Verdict: build our own, optionally bridge to data-uploader's Excel path in v2.

The MCP already has `tenant_bootstrap` (copy-from-source-tenant) and `tenant_cleanup` (soft-delete-all). Neither produces a portable artifact. Both share primitives — workflow copy, localization upsert — that should be factored out as part of this work.

---

## Decisions (from clarifying-question round)

| # | Question | Decision |
|---|---|---|
| Q1 | What surfaces? | (c) **Full config** — MDMS schemas + data + localization + workflow + boundary + access control |
| Q2 | Tenant scope? | (d) **Configurable** via `include: ["self", "root", "children"]` flag |
| Q3 | Artifact storage? | **Filestore** for blobs (zip), **`mcp-dumps.DumpRegistry` MDMS schema** for the version index |
| Q3a | Artifact format? | **Zip with `manifest.json` + per-surface `.jsonl`/`.json`** |
| Q4 | Conflict policy? | (d) `on_conflict ∈ {skip, overwrite, fail}` (default `skip`) + orthogonal `dry_run` flag |
| Q5 | Cross-root restore? | (b) **Same-root cross-tenant only** for v1; cross-root deferred |
| Q6 | Bootstrap alias? | (a) **No alias in v1** — factor shared helpers; alias arrives in v2 with cross-root |

---

## Architecture

```
src/
├── dump/
│   ├── engine.ts                    # orchestrator: dumpTenant, restoreFromFilestore, listDumps
│   ├── zip.ts                       # zip read/write helpers (archiver + unzipper)
│   ├── registry.ts                  # mcp-dumps.DumpRegistry schema bootstrap + CRUD
│   ├── types.ts                     # Manifest, SurfaceEntry, ApplyReport, ConflictPolicy
│   └── surfaces/
│       ├── index.ts                 # registry of all surface modules
│       ├── mdmsSchemas.ts
│       ├── mdmsData.ts
│       ├── localization.ts
│       ├── workflow.ts
│       ├── boundary.ts
│       └── accessControl.ts
└── tools/
    └── mdms-dump-restore.ts         # three thin tool wrappers
```

Each `surface/<name>.ts` implements:

```ts
interface Surface {
  name: SurfaceName;
  dump(client: DigitApiClient, tenantId: string, opts: DumpOpts): AsyncIterable<JsonLine>;
  restore(
    client: DigitApiClient,
    lines: AsyncIterable<JsonLine>,
    target: string,
    opts: RestoreOpts,
  ): Promise<SurfaceReport>;
}
```

`engine.ts` iterates surfaces, streams their output into `zip.ts`, uploads the assembled zip via `filestoreUpload()`, then writes the registry row via `mdmsV2Create`.

The three new MCP tools (`src/tools/mdms-dump-restore.ts`) are ~50 lines each: parse args → call `engine.*` → return summary.

---

## Artifact format

### Zip layout

```
ke.bomet-v3-20260513T070000Z.zip
├── manifest.json                   # see schema below
├── mdms-schemas.jsonl              # one schema definition per line
├── mdms-data.jsonl                 # one row: { schemaCode, uniqueIdentifier, tenantId, data, isActive }
├── localization.jsonl              # one row: { locale, module, code, message }
├── workflow.json                   # business services array + state defs
├── boundary.json                   # { hierarchy, entities, relationships }
└── access-control.json             # { roles, roleActions }
```

`.jsonl` for unbounded surfaces (data, localization, schemas) keeps memory flat. `.json` for surfaces whose total size is bounded by the schema (workflow business services, boundary hierarchy, access control roles).

### `manifest.json`

```json
{
  "version": "v3",
  "tenant_id": "ke.bomet",
  "include": ["self", "root"],
  "created_at": "2026-05-13T07:00:00Z",
  "created_by": "ADMIN@ke",
  "source_env": "bomet.digit.org",
  "surfaces": ["mdms-schemas", "mdms-data", "localization", "workflow", "boundary", "access-control"],
  "counts": { "mdms-schemas": 47, "mdms-data": 1283, "localization": 2484, "workflow": 6, "boundary": 25, "access-control": 14 },
  "sha256": "ab12...",
  "schema_version": 1
}
```

### Registry schema (`mcp-dumps.DumpRegistry`)

```json
{
  "tenant_id": "string",
  "version": "string",
  "filestore_id": "string",
  "created_at": "string",
  "size_bytes": "number",
  "sha256": "string",
  "surfaces": ["string"],
  "include": ["string"]
}
```

- `uniqueIdentifier = <tenant_id>__<version>` so versions are searchable per tenant.
- Schema bootstraps lazily on first dump if not present.
- Dumper excludes the `mcp-dumps.*` schema prefix to avoid recursion.

---

## Tool surfaces

### `mdms_dump`

```ts
{
  tenant_id: string;
  include?: ("self" | "root" | "children")[];   // default: ["self", "root"]
  surfaces?: SurfaceName[];                      // default: all
}
→ { ok: true, filestore_id, version, size_bytes, sha256, counts }
```

### `mdms_restore`

```ts
{
  tenant_id: string;                             // target tenant
  version?: "latest" | string;                   // resolves via registry
  filestore_id?: string;                         // direct, skips registry
  on_conflict?: "skip" | "overwrite" | "fail";   // default "skip"
  dry_run?: boolean;                             // default false
  surfaces?: SurfaceName[];                      // default: all from manifest
  wait_for_persist?: boolean;                    // default true, 30s timeout
}
→ ApplyReport { surfaces[], totals: { created, updated, skipped, failed }, partial: boolean }
```

### `mdms_dumps_list`

```ts
{ tenant_id?: string }
→ { dumps: DumpRegistry[] }   // sorted by version desc
```

---

## Data flow

### Dump

```
Tool handler
  └─→ engine.dumpTenant(tenant_id, include, surfaces)
        ├─ 1. ensureRegistrySchema()             (create mcp-dumps.DumpRegistry if missing)
        ├─ 2. resolveScope(tenant_id, include)   → list of tenantIds (1..N)
        ├─ 3. for each enabled surface:
        │     stream rows → zip.appendEntry(<surface>.jsonl|.json)
        │     update counts[surface]
        ├─ 4. zip.finalize() with manifest.json (counts + sha256)
        ├─ 5. filestoreUpload(tenant_id, "mcp-dumps", zipBuffer, fileName, "application/zip")
        ├─ 6. nextVersion = max(existing versions for tenant_id) + 1
        ├─ 7. mdmsV2Create("mcp-dumps", "DumpRegistry", "<tenant>__v<N>", { … })
        └─→ return { version, filestore_id, size, counts, sha256 }
```

### Restore

```
Tool handler
  └─→ engine.restoreFromFilestore(...)
        ├─ 1. registry.resolve(tenant_id, version) → filestore_id (skipped if filestore_id passed)
        ├─ 2. filestoreGetUrl → download → unzip in memory
        ├─ 3. verify manifest.sha256 vs computed
        ├─ 4. if dry_run:
        │     for each surface → diff against live tenant state
        │     return ApplyReport — STOP HERE, no writes
        ├─ 5. apply order: schemas → data → localization → workflow → boundary → access-control
        ├─ 6. for each row:
        │     check existence → apply per on_conflict policy
        │     accumulate per-surface ApplyReport
        ├─ 7. on first uncaught error: stop, return partial ApplyReport with `error`
        ├─ 8. if wait_for_persist: poll kafkaLag("egov-infra-persist") until 0 or 30s
        └─→ return ApplyReport
```

### List

`mdmsV2Search("mcp-dumps", "DumpRegistry", filter by tenant_id if given)`, sort by version desc.

---

## Per-surface conflict matrix

| Surface | Apply | On `skip` | On `overwrite` |
|---|---|---|---|
| mdms-schemas | `mdmsSchemaCreate` | Skip if code exists | Re-create (MDMS upserts on `code`) |
| mdms-data | `mdmsV2Create` per row | Skip if `(tenantId, schemaCode, uniqueIdentifier)` exists | `mdmsV2Update` keeping `id` and `auditDetails` |
| localization | `localizationUpsert` | Upsert semantics — same effect | Same |
| workflow | `workflowBusinessServiceCreate` / `…Update` | Skip if service code exists | Update |
| boundary | hierarchy → entities → relationships | Each step checks existence | Re-create relationships only |
| access-control | Roles only (role-actions skipped, follows `tenant_bootstrap`) | Skip if role code exists | Re-create |

---

## Error handling

| Failure | Detection | Response |
|---|---|---|
| Bad `tenant_id` | First call returns empty/auth error | Abort with `tenant_not_found` before zip work |
| Filestore upload fails | Non-2xx from `filestoreUpload` | Abort. No registry row written |
| Registry write fails after filestore upload | MDMS create error after step 5 | Return `registry_write_failed` with `orphan_filestore_id` for manual recovery |
| Cross-root attempt | Source and target derive different roots | Reject up front: `cross_root_restore_not_supported` |
| Missing schema at target | Data row references unknown schemaCode | If schemas in dump → applied first (OK). If filtered out → fail at first row, suggest including schemas |
| Conflict under `on_conflict=fail` | First duplicate | Abort restore, return ApplyReport with `aborted_at` |
| Manifest checksum mismatch | After download | Refuse to restore: `manifest_checksum_mismatch` |
| Kafka persister lag > timeout | After last apply | Return `ok: true, warning: persist_lag_timeout`. Don't fail — data is in Kafka |
| Partial-apply on uncaught error | Network drop mid-restore | No transaction rollback (DIGIT has no cross-service xact). Return ApplyReport with `partial: true` |

**Idempotency**
- `mdms_dump`: not idempotent (mints a new version each call). By design.
- `mdms_restore` with `on_conflict=skip`: idempotent.
- `mdms_dumps_list`: read-only.

**Size limits**
- Soft warn at 50 MB compressed.
- Hard cap at 500 MB (refuse: `dump_too_large`).
- Bomet's estimated dump: ~5–15 MB compressed.

---

## Testing & validation

### Unit tests (`test-mdms-dump-restore.ts`, no live DIGIT)

- `zip.ts` round-trip: 1k synthetic rows across all surfaces → re-read → manifest checksum matches.
- `registry.ts`: monotonic version increments per tenant; concurrent calls — surface as known limitation if races appear.
- Per-surface conflict resolver: synthetic existing + new row → assert create/update/skip per policy.

### Integration tests (against local DIGIT)

- Round-trip on throwaway tenant (`pwt-dump-roundtrip-<ts>`):
  1. `tenant_bootstrap` → fresh tenant
  2. `mdms_dump` → capture `filestore_id` + sha + counts
  3. `tenant_cleanup` (soft-deletes data)
  4. `mdms_restore` → counts match pre-cleanup
  5. `mdms_search` on three sentinels (`common-masters.Department`, `RAINMAKER-PGR.ServiceDefs`, `egov-hrms.Designation`) → identical
- Conflict policy matrix (3 × 3): pre-seed one record per surface, restore with each `on_conflict` → assert ApplyReport.
- `dry_run`: mock the client; assert no mutating calls.

### Bomet validation (acceptance gate)

**Step 0 — Postgres pre-snapshot (mandatory before anything else)**

```bash
ssh egov-bomet
mkdir -p /root/dumps
TS=$(date -u +%Y%m%dT%H%M%SZ)
docker exec docker-postgres pg_dump -U egov -d egov --no-owner --clean --if-exists \
  | gzip > /root/dumps/egov-pre-task-029-$TS.sql.gz
ls -lh /root/dumps/egov-pre-task-029-$TS.sql.gz
zcat /root/dumps/egov-pre-task-029-$TS.sql.gz | head -50   # sanity
scp egov-bomet:/root/dumps/egov-pre-task-029-$TS.sql.gz /root/outputs/TASK-029-sources/
```

Covers all critical DIGIT tables in `egov` DB: `eg_mdms_*`, `eg_user`, **`eg_enc_symmetric_keys`** (rebuild without preserving these = permanent PII loss per memory), filestore metadata, workflow, localization, idgen sequences.

**Steps 1–10**

1. Build patched image locally, deploy to Bomet (tag previous as `digit-mcp:pre-task-029`).
2. Restart `digit-mcp`, verify `/healthz` and new tools in `tools/list`.
3. **Pre-flight snapshot** of `ke.bomet` MDMS state → `bomet-pre-snapshot.json`.
4. **Dump**: `mdms_dump(tenant_id="ke.bomet", include=["self","root"])` → record `filestore_id`, version, counts, sha.
5. **List**: `mdms_dumps_list(tenant_id="ke.bomet")` → v1 appears.
6. **Dry-run restore** onto same tenant → 0 creates, 0 updates, all skips.
7. **Selective deletion**: soft-delete one complaint subtype via `mdmsV2Update(isActive=false)`. Re-run dry-run → expect exactly 1 update.
8. **Real restore** with `on_conflict=overwrite` → previously-deactivated record re-activated. Verify via `mdms_search`.
9. **Negative test**: `mdms_restore(target_tenant="pg.citya")` from a `ke.bomet` dump → `cross_root_restore_not_supported`.
10. **Post-flight snapshot** vs pre-flight → only `auditDetails.lastModifiedTime` deltas on the overwritten record.

### Rollback ladder (most-targeted → most-blunt)

1. **MCP image revert** — `docker tag digit-mcp:pre-task-029 digit-mcp:latest && docker restart digit-mcp`. ~30s.
2. **`mdms_restore` from the v1 dump (step 4)** with `on_conflict=overwrite`. Minutes.
3. **`pg_restore` from Step 0** — full DB rewind, 5–15 min DIGIT downtime:

```bash
cd ~/code/tilt-demo && docker compose -f docker-compose.deploy.yaml stop
docker exec -i docker-postgres psql -U egov -d postgres -c "DROP DATABASE egov;"
docker exec -i docker-postgres psql -U egov -d postgres -c "CREATE DATABASE egov;"
zcat /root/dumps/egov-pre-task-029-*.sql.gz | docker exec -i docker-postgres psql -U egov -d egov
cd ~/code/tilt-demo && docker compose -f docker-compose.deploy.yaml up -d
```

---

## Definition of done

- All unit tests pass on dev box.
- All integration tests pass against local DIGIT.
- All 10 Bomet validation steps pass; log at `/root/outputs/TASK-029-sources/bomet-validation-log.md`.
- `digit-mcp:pre-task-029` tag retained as rollback.
- TASK-029 doc Results section filled.
- `outputs.csv` row added.

---

## Future (out of scope for v1)

- Cross-root restore (substitution of `tenantId` field; resolution of workflow role refs and boundary parent chain).
- Bootstrap aliasing onto `mdms_restore`.
- Excel-restore bridge to `egov-data-uploader` `/v1/jobs/_create`.
- User dump/restore (depends on `eg_enc_symmetric_keys` portability).
- Differential dumps (delta from baseline).
- Cross-environment restore (different DIGIT installs).
