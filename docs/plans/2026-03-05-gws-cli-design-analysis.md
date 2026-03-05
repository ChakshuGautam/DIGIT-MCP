# Google Workspace CLI (`gws`) — Design Analysis

> Analysis of [googleworkspace/cli](https://github.com/googleworkspace/cli) for design patterns applicable to DIGIT MCP Server.

## Repository Overview

`gws` is a Rust CLI (and MCP server) that exposes Google Workspace APIs (Drive, Gmail, Sheets, Calendar, etc.) to both human operators and AI agents. Written by [Justin Poehnelt](https://justinpoehnelt.com) — the same author whose blog post ["You Need to Rewrite Your CLI for AI Agents"](https://justinpoehnelt.com/rewrite-cli-for-ai-agents/) inspired our agent safety hardening (#16–#19).

**Key stats:** 23 source files, ~25 Google Workspace APIs, Rust + clap + tokio + reqwest.

---

## Design Elements

### 1. Dynamic API Discovery (vs. Static Tool Registration)

**How gws does it:** Rather than maintaining static tool definitions, `gws` fetches Google's [Discovery Service](https://developers.google.com/discovery) documents at runtime and generates CLI commands dynamically. New API endpoints become available without code changes.

```
discovery.rs:
  fetch_discovery_document(service, version)
    → cache at ~/.config/gws/cache/{service}_{version}.json (24h TTL)
    → validate_api_identifier() before cache path construction
    → fallback URL pattern for newer APIs ($discovery/rest)
```

**How DIGIT MCP does it:** Static tool registration via `registry.register({ name, group, handler })` in 16 tool files. Adding a new tool requires code changes, build, and deploy.

**Gap / Opportunity:** DIGIT APIs also have OpenAPI specs. We already have `docs/openapi.yaml` — we could theoretically generate tool definitions from the spec. However, DIGIT's tools add significant value beyond raw API proxying (validation, dry-run, cross-service orchestration like `tenant_bootstrap`), so full dynamic generation isn't practical. The static approach is the right choice for us.

**Applicable takeaway:** The 24-hour cache TTL pattern for discovery docs is worth noting. Our `docs_search` could cache API catalog results similarly.

---

### 2. Progressive Disclosure via Helpers

**How gws does it:** The `Helper` trait provides "helper commands" prefixed with `+` that abstract complex API patterns into simple operations:

```rust
// helpers/mod.rs
pub trait Helper {
    fn inject_commands(&self, app: Command) -> Command;
    fn handle(&self, ...) -> Option<bool>;  // None = not my command
    fn helper_only(&self) -> bool { false } // suppress raw API cmds?
}
```

Examples:
- `gws gmail +send --to bob@example.com --subject "Hi" --body "Hello"` — abstracts RFC 2822 encoding
- `gws sheets +append --spreadsheet-id X --range A1 --values '[[1,2,3]]'` — abstracts ValueRange JSON
- `gws calendar +agenda` — merges events from multiple calendars
- `gws drive +upload file.pdf --parent FOLDER_ID` — abstracts multipart upload

Each helper maps user-friendly flags to the underlying API's complex request format, then delegates to `executor::execute_method()`.

**10 services have helpers:** Gmail, Sheets, Docs, Chat, Drive, Calendar, Apps Script, Workspace Events, ModelArmor, Workflows.

**How DIGIT MCP does it:** Our progressive disclosure uses tool groups (`enable_tools`). Our "helpers" are tools like `tenant_bootstrap` and `city_setup` that orchestrate multiple API calls. Claude Code skills provide the equivalent of gws's `+` commands — guided workflows.

**Applicable takeaway:** The `helper_only()` flag is interesting — it completely hides the raw API commands for a service, showing only the simplified helpers. We could consider a similar concept where some tool groups have a "simplified" mode that hides advanced tools until requested.

---

### 3. Input Validation — Agent-Hostile by Default

**How gws does it:** `validate.rs` treats ALL input as potentially adversarial. Key validators:

| Validator | What It Rejects | Why |
|-----------|----------------|-----|
| `validate_safe_output_dir(dir)` | Absolute paths, `../` traversal, symlink escapes, control chars | Prevent agents from writing to `~/.ssh/` |
| `validate_safe_dir_path(dir)` | Same + follows symlinks to verify resolved path stays under CWD | Prevent symlink-based escapes |
| `validate_resource_name(s)` | `..`, control chars, `?`, `#`, `%` (prevents double-encoding bypass) | LLMs append query params to IDs |
| `validate_api_identifier(s)` | Non-alphanumeric except `-`, `_`, `.` | Prevent cache path injection |
| `reject_control_chars(s)` | ASCII < 0x20 and DEL (0x7F) | Block null bytes, newlines in paths |
| `encode_path_segment(s)` | Percent-encodes ALL non-alphanumeric | Safe URL path segments |
| `encode_path_preserving_slashes(s)` | Encodes per-segment, preserves `/` | For `{+name}` RFC 6570 templates |

**Critical detail — `%` rejection:** `validate_resource_name` rejects `%` to prevent double-encoding bypasses where `%2e%2e` decodes to `..`. Our `validateResourceId` does the same.

**How DIGIT MCP does it (post-PR #20):** Very similar. Our `validation.ts` has:
- `validateTenantId` — regex-based, rejects uppercase, special chars
- `validateMobileNumber` — strips formatting, enforces 10 digits
- `rejectControlChars` — rejects < 0x20 except `\n` and `\t`
- `validateResourceId` — rejects `?`, `#`, `%`
- `validateStringLength` — max length enforcement

**Gap:** gws validates file paths (output dirs, upload paths) against directory traversal. DIGIT MCP doesn't handle file uploads directly (filestore_upload takes base64 content), so this isn't needed. However, we should note the pattern for any future file-handling tools.

**Gap:** gws rejects `\n` and `\t` in paths but allows them in content. We allow `\n` and `\t` in `rejectControlChars` — consistent with gws's approach for non-path content.

---

### 4. Structured Error Handling

**How gws does it:** `error.rs` defines a typed error enum with 5 variants:

```rust
enum GwsError {
    Api { code: u16, message: String, reason: String, enable_url: Option<String> },
    Validation(String),
    Auth(String),
    Discovery(String),
    Other(anyhow::Error),
}
```

Every error serializes to JSON with consistent structure:
```json
{ "error": { "code": 400, "message": "...", "reason": "validationError" } }
```

**Key pattern — actionable stderr hints:** Errors go to stdout as machine-readable JSON. Human-readable guidance goes to stderr:
```
💡 API not enabled for your GCP project.
   Enable it at: https://console.developers.google.com/...
   After enabling, wait a few seconds and retry your command.
```

**How DIGIT MCP does it:** Tool handlers return `JSON.stringify({ success: false, error: "..." })`. The MCP server catches thrown errors and returns `{ isError: true, content: [...] }`. We have `ValidationError` with a `field` property.

**Gap:** We don't have typed error categories (API vs Auth vs Validation vs Internal). All errors are either `ValidationError` or generic `Error`. Adding error categories would help agents understand what went wrong and what to do about it.

**Applicable takeaway:** The `enable_url` pattern is brilliant — when an API isn't configured, the error includes the exact URL to fix it. We could do something similar: when a tool fails because a group isn't enabled, include `"hint": "Call enable_tools(['pgr']) first"`.

---

### 5. Output Formatting

**How gws does it:** `formatter.rs` supports 4 output formats: JSON (default), Table, YAML, CSV.

Key design decisions:
- **List response auto-detection:** Recognizes `{"files": [...], "nextPageToken": "..."}` and extracts the data array
- **Nested object flattening:** `{"owner": {"name": "Alice"}}` becomes column `owner.name` in table format
- **UTF-8 safe truncation:** Truncates by char count (not bytes) with `…` suffix — prevents panics on emoji
- **YAML injection prevention:** Single-line strings are always double-quoted (prevents `#` and `:` from being interpreted as YAML syntax)
- **Paginated output:** CSV/table headers only on first page; YAML uses `---` document separators; JSON uses NDJSON (one object per line)

**How DIGIT MCP does it:** All tool responses are JSON. No alternative formats.

**Gap:** Not a gap — MCP protocol is JSON-only. But the nested flattening and auto-detection patterns are useful if we add a summary/compact output mode.

---

### 6. Auto-Pagination

**How gws does it:** `executor.rs` implements configurable pagination:

```
--page-all           # Fetch all pages
--page-limit 500     # Max items across all pages
--page-delay 200     # ms between page requests (rate limit friendly)
```

Supports multiple Google pagination patterns: `pageToken`/`nextPageToken`, `pageIndex`, etc. Default: 100 items/page, 100ms delay.

**How DIGIT MCP does it:** Each search tool has `limit` and `offset` parameters. Agents must manually paginate. Our `applyFieldMask` truncates to 50 items by default.

**Gap:** Agents frequently need "all results" but have to loop manually. A `page_all` parameter on search tools (like gws) would reduce agent effort and eliminate pagination bugs. Worth considering for a future PR.

---

### 7. HTTP Client & Retry Logic

**How gws does it:** `client.rs` implements:

```rust
async fn send_with_retry(client, request) -> Result<Response> {
    for attempt in 0..3 {
        let response = client.execute(request.clone()).await?;
        if response.status() != 429 { return Ok(response); }

        let delay = response.headers().get("Retry-After")
            .and_then(|v| v.to_str().ok()?.parse::<u64>().ok())
            .unwrap_or(1 << attempt);  // exponential: 1s, 2s, 4s

        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
    Ok(response)  // return last response even if still 429
}
```

Also sets `x-goog-api-client: gl-rust/{name}-{version}` header for API analytics.

**How DIGIT MCP does it:** No retry logic. If a DIGIT API call fails, the error is returned immediately.

**Gap:** DIGIT services behind Kong can return 429 under load. Adding retry with exponential backoff to `digit-api.ts` would improve reliability. The pattern is simple — 3 attempts, respect `Retry-After`, exponential fallback.

---

### 8. Multi-Account Management

**How gws does it:** `accounts.rs` manages a registry of Google accounts:

```json
// ~/.config/gws/accounts.json
{
  "default": "user@example.com",
  "accounts": {
    "user@example.com": { "added": "2025-01-15T10:30:00Z" },
    "admin@company.com": { "added": "2025-01-16T14:22:00Z" }
  }
}
```

Switch with `--account` flag or `GOOGLE_WORKSPACE_CLI_ACCOUNT` env var. Email normalization (lowercase + trim). Base64-encoded email for per-account credential filenames.

**How DIGIT MCP does it:** Single authenticated session. The `configure` tool switches environments and tenants. Multi-user isn't needed because DIGIT MCP typically runs as a service account (ADMIN).

**Not a gap** — different use case. DIGIT MCP is server-side, not per-user.

---

### 9. Credential Security

**How gws does it:** Multi-layer encryption in `credential_store.rs` and `token_storage.rs`:

1. **AES-256-GCM** encryption for stored credentials
2. **Key sources** (priority order): OS keyring → local `.encryption_key` file → generated random key
3. **Atomic writes** via temp file + rename (prevents corruption on crash)
4. **Unix file permissions:** 0o600 for files, 0o700 for directories
5. **Per-account token caching** with scope matching (exact first, then superset)

**How DIGIT MCP does it:** Credentials are environment variables (`CRS_USERNAME`, `CRS_PASSWORD`). OAuth tokens are in-memory only (re-auth on restart). Session data is in PostgreSQL.

**Not a gap** — different deployment model. Server-side MCP doesn't need encrypted local credential storage.

---

### 10. Model Armor Integration

**How gws does it:** `helpers/modelarmor.rs` provides Google's Model Armor service for response sanitization:

```
--sanitize           # Global flag: apply Model Armor to all responses
gws modelarmor +sanitize-prompt "user input"
gws modelarmor +sanitize-response "model output"
gws modelarmor +create-template --preset moderate
```

Two modes: **Warn** (log to stderr, annotate output) and **Block** (suppress output, exit non-zero).

**How DIGIT MCP does it:** We have `sanitize.ts` with 16 regex patterns for prompt injection. Simpler but effective for our use case.

**Applicable takeaway:** The warn vs block modes are interesting. Our sanitization always filters (equivalent to their "warn" mode — replaces with `[filtered]` but still returns the response). A "block" mode that refuses to return user content with detected injections could be useful for high-security deployments.

---

### 11. Dry-Run Support

**How gws does it:** `--dry-run` global flag validates requests without sending:
- Parses and validates all parameters
- Builds the full URL
- Validates request body against schema
- Prints the request that would be sent
- Does NOT make the HTTP call

**How DIGIT MCP does it (post-PR #20):** `dry_run: true` parameter on 4 mutating tools. Validates inputs and checks prerequisites (auth, schema existence) without executing. Returns a preview object.

**Comparable.** Our dry-run is slightly more useful because it checks API-level prerequisites (does the department exist? is the schema registered?), not just local validation.

---

### 12. Schema Inspection

**How gws does it:** `schema.rs` provides `gws schema drive.files.list` to inspect API schemas:
- Resolves `$ref` references recursively (with cycle detection via `HashSet`)
- Shows request/response schemas, HTTP method, path, parameters
- Helps agents understand what parameters an API expects

**How DIGIT MCP does it:** `api_catalog` tool returns the OpenAPI spec for all or filtered services. `docs_search` and `docs_get` provide documentation lookup.

**Comparable.** Our `api_catalog` serves a similar purpose but returns the full OpenAPI spec rather than per-method schema. The gws approach of per-method schema lookup is more focused and token-efficient for agents.

---

### 13. Skills / Persona System

**How gws does it:** YAML-based registry of personas (role bundles) and recipes (multi-step workflows):

```yaml
# personas.yaml
name: executive-assistant
services: [calendar, gmail, drive, tasks, docs]
workflows: [daily-briefing, meeting-prep]
instructions: |
  Step 1: Check calendar...

# recipes.yaml
name: audit-external-sharing
steps:
  - gws drive files list --params '{"spaces": "drive"}' --page-all
  - gws sheets spreadsheets create --json '...'
caution: Handle sensitive data carefully.
```

Auto-generates `skills.md` from CLI metadata via `generate_skills.rs`.

**How DIGIT MCP does it:** Claude Code skills in `skills/` directory (4 skills). Skills are manually authored markdown files that guide AI through DIGIT workflows.

**Applicable takeaway:** Auto-generating skill docs from tool metadata is appealing. We could generate a skills index from our tool registry (name, description, group, risk level) rather than maintaining it manually.

---

### 14. MCP Server Implementation

**How gws does it:** `mcp_server.rs` — stdio-based JSON-RPC server:

```
tools/list  → walk Discovery Documents, cache tool list
tools/call  → parse tool name → resolve service/resource/method → execute
```

Tool naming: `{service}_{resource}_{method}` (e.g., `drive_files_list`).

Each tool accepts: `{ params, body, upload, page_all }`.

Security: validates upload paths, rejects absolute paths and `../`.

**How DIGIT MCP does it:** Full MCP SDK integration with dual transport (stdio + HTTP), progressive disclosure, tool groups, session management, telemetry.

**Our MCP implementation is significantly more sophisticated.** gws's MCP server is a simple stdin/stdout JSON-RPC loop without sessions, groups, or progressive disclosure. Our architecture is more production-ready.

---

### 15. Testing Strategy

**How gws does it:**
- `cargo test` runs unit tests across all modules
- `cargo clippy -- -D warnings` enforces lint rules
- Tests use `tempfile` crate for filesystem operations
- `#[serial]` annotation for tests that modify CWD (prevents race conditions)
- Validation tests cover: symlink traversal, directory escapes, query injection, double-encoding, unicode
- `clap` argument matchers for CLI parsing tests
- Round-trip tests for encryption/decryption

**How DIGIT MCP does it:**
- `test-agent-safety.ts` — 53 unit tests for validation/sanitization/field masks
- `test-integration-full.ts` — 127 integration tests against live DIGIT APIs
- `test-e2e-new-tenant.ts` — E2E tenant lifecycle test
- Agent tests via Claude Agent SDK

**Comparable coverage**, different approaches. gws tests are unit-level with mocks; ours are primarily integration tests against real APIs. Both cover adversarial inputs.

---

### 16. Atomic File Operations

**How gws does it:** `fs_util.rs` provides `atomic_write()` and `atomic_write_async()`:

```
1. Write to {path}.tmp
2. Atomic rename to {path}
3. POSIX rename(2) guarantees: readers see old or new, never partial
```

**How DIGIT MCP does it:** Standard `fs.writeFile` — not atomic. Our session data goes to PostgreSQL (inherently atomic via transactions). File writes are only for engram docs and logs.

**Applicable takeaway:** If we ever write critical state to files (e.g., engram docs), we should use write-to-temp + rename pattern.

---

### 17. Rate Limiting / Pagination Delay

**How gws does it:** `--page-delay 200` adds configurable delay between pagination requests. Default 100ms. This prevents triggering API rate limits during auto-pagination.

**How DIGIT MCP does it:** No inter-request delays. Each tool call is independent.

**Applicable takeaway:** If we add auto-pagination, include a configurable delay to avoid hammering DIGIT services.

---

## Summary: Gaps & Improvements for DIGIT MCP

### Already Implemented (post-PR #20)

| gws Pattern | DIGIT MCP Equivalent |
|-------------|---------------------|
| Input validation (`validate.rs`) | `validation.ts` — tenant IDs, mobile, control chars, resource IDs |
| Dry-run (`--dry-run`) | `dry_run: true` on 4 mutating tools |
| Response sanitization (Model Armor) | `sanitize.ts` — 16 regex patterns |
| Progressive disclosure (helpers) | Tool groups + `enable_tools` |
| MCP server | Full MCP SDK with dual transport, sessions, telemetry |
| Skills/personas | Claude Code skills in `skills/` |

### Worth Adopting

| # | Pattern | Effort | Impact | Description |
|---|---------|--------|--------|-------------|
| 1 | **Typed error categories** | Small | Medium | Add error categories (API, Validation, Auth, Internal) so agents can distinguish "re-authenticate" from "fix your input" from "server is down" |
| 2 | **Actionable error hints** | Small | High | Include `hint` field in error responses: `"Call enable_tools(['pgr']) first"`, `"Use validate_employees to find valid UUIDs"` |
| 3 | **HTTP retry with backoff** | Small | Medium | 3 retries on 429/503 with exponential backoff in `digit-api.ts` |
| 4 | **Auto-pagination** | Medium | High | `page_all: true` parameter on search tools — fetches all pages, returns combined results |
| 5 | **Schema inspection per-method** | Medium | Medium | Extend `api_catalog` to accept a specific tool name and return only that tool's input/output schema (more token-efficient) |

### Not Applicable (Different Architecture)

| gws Pattern | Why Not Needed |
|-------------|---------------|
| Dynamic API discovery | DIGIT tools add value beyond raw API proxying (orchestration, validation) |
| Multi-account management | Server-side deployment, single service account |
| Encrypted credential storage | Credentials are env vars, not local files |
| File path validation | No file system operations (filestore uses base64) |
| Output format options (table/CSV/YAML) | MCP protocol is JSON-only |
| Atomic file writes | State is in PostgreSQL, not files |

---

## File-by-File Reference

| File | LOC (est.) | Purpose |
|------|-----------|---------|
| `main.rs` | ~100 | Entry point, CLI dispatch |
| `commands.rs` | ~300 | Recursive command tree from Discovery Documents |
| `executor.rs` | ~800 | Request lifecycle: validate → build URL → auth → HTTP → paginate → format |
| `discovery.rs` | ~200 | Fetch + cache Discovery Documents (24h TTL) |
| `formatter.rs` | ~400 | JSON/Table/YAML/CSV output with nested flattening |
| `validate.rs` | ~350 | Input validation (paths, resource names, API identifiers) |
| `error.rs` | ~120 | Typed error enum with JSON serialization + stderr hints |
| `auth.rs` | ~300 | Credential resolution hierarchy (env → encrypted → legacy) |
| `accounts.rs` | ~250 | Multi-account registry (add/remove/default/switch) |
| `credential_store.rs` | ~300 | AES-256-GCM encryption for credentials |
| `token_storage.rs` | ~200 | Encrypted OAuth token cache with scope matching |
| `client.rs` | ~80 | HTTP client with 3-retry + exponential backoff |
| `services.rs` | ~200 | Service name → (api, version) resolution with aliases |
| `mcp_server.rs` | ~400 | Stdio JSON-RPC MCP server |
| `schema.rs` | ~200 | API schema inspection with recursive $ref resolution |
| `setup.rs` | ~500 | 6-stage interactive setup wizard |
| `setup_tui.rs` | ~400 | TUI components (picker, input, wizard) via ratatui |
| `oauth_config.rs` | ~100 | OAuth client config storage |
| `fs_util.rs` | ~60 | Atomic file write (temp + rename) |
| `text.rs` | ~100 | Smart text truncation (sentence → word → char boundary) |
| `generate_skills.rs` | ~300 | Auto-generate skill docs from CLI metadata |
| `helpers/mod.rs` | ~50 | Helper trait + factory |
| `helpers/*.rs` | ~2000 | 10 service-specific helpers (Gmail, Sheets, Drive, etc.) |
