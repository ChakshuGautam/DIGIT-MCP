# Spec: e2e orchestration composites (`onboard_city`, `validate_deployment`, `verify_login`)

**Status:** spec only — implement + validate next session. Nothing here is built yet; do not treat as shipped.

## Why

DIGIT-MCP today is all *low-level* tools (one tool ≈ one DIGIT API call). An agent must already know the correct multi-step sequence and every gotcha. A 10-iteration faithful `./deploy.sh` validation on macOS ([ChakshuGautam/CCRS#46](https://github.com/ChakshuGautam/Citizen-Complaint-Resolution-System/pull/46)) + the Feliciano Maputo onboarding proved that "deploy + onboard a DIGIT city end-to-end" is ~a dozen ordered gotchas an agent currently re-derives by failing. These composites encode the *validated* recipe once.

**Architecture boundary (important):** deploy correctness lives in `deploy.sh`/the ansible playbook (already fixed in CCRS#46) — composites do **not** re-own deploy. Composites are the source of truth for the **agent-driven onboard / validate / verify layer on top of an already-deployed stack**. The `digit-ansible-onboard` / `digit-xlsx-onboard` skills ([CCRS#47](https://github.com/ChakshuGautam/Citizen-Complaint-Resolution-System/pull/47)) become thin narratives that *call* these composites.

## Implementation shape

New module `src/tools/composites.ts`, `registerCompositeTools(registry)` added to `src/tools/index.ts` `registerAllTools`. Each = `registry.register({ name, description, inputSchema, group, handler })` (same `ToolMetadata` pattern as `mdms-tenant.ts`). Handlers **compose existing registered tools** (call their shared helper functions / handlers) — they add ordering + gotchas + verification, not new low-level API logic. Group: a new `'composite'` group (opt-in like others). Every composite is **idempotent** ("exists" ⇒ success) and returns a structured per-step report.

---

### 1. `onboard_city` — the substantive one

Take a configurator-style (or legacy CCRS) 4-file XLSX dump + target tenant → a fully onboarded city, validated gotchas baked in. Wraps/elevates the existing `city_setup_from_xlsx`; that tool stays as the low-level call this composes.

**inputSchema:** `target_tenant` (`<root>.<city>`), `dump_dir` (or 4 explicit file paths), `source_tenant` (default `pg`), `auth`, `widen_user_validation` (bool, default false — IRON LAW gate), `dry_run` (probe-only).

**Sequence (the proven recipe):**
1. **Validate tenant id** — reject hyphens and digits-in-city-portion (egov-user `^[a-zA-Z. ]*$` on `user.tenantId`; MCP's own validator is laxer — catch here, pre-employee-phase).
2. **Pre-clean the dump** (on a copy; return a diff, never mutate originals): boundary `code/name/parentCode` whitespace-trim + drop exact-duplicate rows by `code` + assert 0 unresolved `parentCode`; blank Phase-1 `Logo File Path` if it's a local-machine path; confirm `Designation.department` & `ServiceDefs.keywords` are comma-sep text (keywords must serialise **String**, not JSON array). These are the exact defects in Feliciano's dump.
3. **New-root bootstrap (conditional):** `mdms_schema_search` at `<root>`; if zero schemas → `tenant_bootstrap({target:<root>, source:source_tenant, auth})` (clones schema defs + ~14 essential data records + ADMIN + PGR workflow). Idempotent; skipped for an existing root. **Must precede step 5** or Phase 3–4 fail `SCHEMA_DEFINITION_NOT_FOUND_ERR`/`INVALID_ROLE`.
4. **Widen `common-masters.UserValidation` (conditional, gated):** only if `widen_user_validation:true` AND a mobile sample fails the root's pattern. `mdms_update` the rule, then **flush redis `validationRules`** (egov-user pins it; MDMS write alone insufficient).
5. **`city_setup_from_xlsx`** with the cleaned files (synchronous ~60–90s; `Accept: text/event-stream` for >5000-boundary dumps).
6. **Read-back verify** (don't trust wizard counts): `tenant.tenants/<city>` @ `<root>`; boundary hierarchy @ city; Department/Designation/ServiceDefs present @ root; employees @ city by mobile (HRMS overrides userName=employeeCode).

**Returns:** pre-clean diff · per-phase status+counts · verification matrix · idempotency markers.
**Composes:** `tenant_bootstrap`, `city_setup_from_xlsx`, `mdms_schema_search`, `mdms_search`, `mdms_update`, `user_search`, boundary validators.
**Validation gate (don't mark done until proven, same discipline as CCRS#46):** on a fresh stack, `mz.maputo` from Feliciano's dump → all phases `completed`, read-backs match source XLSX, a created employee logs in with `eGov@123`.

---

### 2. `validate_deployment` — INFRA-VALIDATION as a callable

The playbook's final validation block, runnable standalone against any env.

**inputSchema:** `base_url` (or target), `auth`.
**Sequence / checks:** all containers healthy; Kong / Public-UI / Configurator / Gatus `/status/` → 200; mint an auth token (`Basic egov-user-client:` — **empty secret**, not the upstream `:egov-user-secret`); MDMS `StateInfo` non-empty; OpenBao `/v1/sys/health` unsealed+initialized; MCP probe ⇒ `SKIPPED (disabled)` is **pass**, not fail, when MCP is off.
**Returns:** the `INFRA VALIDATION RESULTS` matrix (per-check PASS/FAIL/SKIPPED). **Composes:** `health_check` + http probes + a token mint.

---

### 3. `verify_login` — login probe with specific failure reasons

**inputSchema:** `tenant_id`, `user_type` (`EMPLOYEE`|`CITIZEN`), `username`+`password` or `mobile`+`otp`.
**Sequence:** `POST /user/oauth/token`, `Authorization: Basic ZWdvdi11c2VyLWNsaWVudDo=` (`egov-user-client:` empty secret), exact `tenantId` scoping, citizen fixed-OTP awareness. Classify failure precisely: `invalid_credentials` vs `account locked` vs wrong-tenant vs mobile-regex-reject vs HRMS-default-password (the `egov-hrms` default is `EGOV_HRMS_DEFAULT_PASSWORD`, `eGov@123` on canonical — the fork's `:default-pwd` image overrode it).
**Returns:** token + roles, or the specific reason. **Composes:** user oauth.

---

## Gotcha ledger to encode (from the validated runs)

- db_fast_path pins `postgres_password=egov123` + `minio_root_*=minioadmin` + `elasticsearch_master_password=asd@#$@$!132123` (volumes init with compose defaults before OpenBao; first-write-wins). *Deploy concern — not a composite's job, but `validate_deployment` should detect the `password authentication failed` symptom and name this cause.*
- egov-user oauth Basic = `egov-user-client:` **empty** secret.
- `tenant.tenants` lives at the **root**, not the city.
- HRMS sets `userName=employeeCode` (search employees by mobile, not the file's userName).
- redis `validationRules` must be flushed after any `UserValidation` MDMS write.
- new-root ⇒ zero schemas ⇒ bootstrap before Phase 3–4.

## Out of scope

No `deploy_stack` composite — deploy correctness belongs in `deploy.sh`/playbook (CCRS#46), not re-owned in MCP. A composite is not "done" until it has its own e2e validation run, mirroring CCRS#46.
