# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DIGIT MCP Server — an MCP (Model Context Protocol) server exposing 32+ DIGIT eGov platform APIs through a progressive disclosure architecture. Written in TypeScript, supports dual transport: stdio (local Claude Code) and HTTP Streamable (containerized/K8s).

## Commands

```bash
npm run build          # TypeScript compile (tsc) → dist/
npm run dev            # Run directly with tsx (no build needed, stdio transport)
npm start              # Run built server (stdio transport)
npm run start:http     # Run built server (HTTP transport on :3000)

npm test               # Quick validator test (test-validator.ts)
npm run test:ci        # Integration test against live DIGIT API (test-integration.ts)
npm run test:full      # Full integration + c8 coverage report (test-integration-full.ts)
npm run test:e2e       # E2E new-tenant test (test-e2e-new-tenant.ts)

# Agent-based flow tests (require built server + ANTHROPIC_API_KEY)
cd agent-tests && npx tsx run.ts                    # All flows
cd agent-tests && npx tsx run.ts --flow smoke       # Single flow
cd agent-tests && npx tsx run.ts --verbose          # Full conversation logging
```

## Architecture

### Dual Transport (`src/index.ts`)

`MCP_TRANSPORT` env var selects transport:
- **stdio** (default): `StdioServerTransport` for local Claude Code usage
- **http**: Express-like server with `/mcp` (JSON-RPC) and `/healthz` (K8s probes) endpoints; stateless for horizontal scaling

### Progressive Disclosure

The server starts with only `core` + `docs` groups enabled (8 tools visible). Clients call `enable_tools` to unlock additional groups. When groups change, the server sends `tools/list_changed` notifications so clients re-fetch the tool list.

14 tool groups: `core` (always on), `mdms`, `boundary`, `masters`, `employees`, `localization`, `pgr`, `admin`, `idgen`, `location`, `encryption`, `docs`, `monitoring`, `tracing`.

Set `MCP_ENABLE_ALL_GROUPS=1` to pre-enable everything (used by agent tests).

### Tool System

**ToolRegistry** (`src/tools/registry.ts`): Manages tool lifecycle — register, enable/disable groups, query enabled tools. The `core` group cannot be disabled.

**Tool registration pattern**: Each domain has a `registerXyzTools(registry)` function in `src/tools/xyz.ts` that registers tools via `registry.register({ name, group, inputSchema, handler } satisfies ToolMetadata)`. All registration functions are aggregated in `src/tools/index.ts`.

**Tool handler contract**:
- Accepts `Record<string, unknown>` args
- Returns `Promise<string>` (JSON with `{ success, data?, error? }`)
- Must call `ensureAuthenticated()` before DIGIT API calls
- Errors are caught by `server.ts` and returned with `isError: true`

### DIGIT API Client (`src/services/digit-api.ts`)

Singleton `digitApi` handles authentication (OAuth2 password grant), multi-tenant resolution (e.g. `pg.citya` → state root `pg`), and all DIGIT HTTP calls. Methods organized by domain: MDMS, Boundary, HRMS, User, PGR, Workflow, Localization, Filestore, IDGen, Encryption, Access Control.

### Configuration (`src/config/`)

- `environments.ts`: Named environment configs (URL, state tenant, endpoint overrides). Available: `chakshu-digit`, `dev`, `local`.
- `endpoints.ts`: All DIGIT API endpoint path constants + OAuth config.

### Multi-Tenant Model

- **State tenant** (root): `pg`, `statea`, `tenant` — used for MDMS queries, schema definitions
- **City tenant** (leaf): `pg.citya`, `statea.f` — used for PGR, HRMS, boundaries
- Auto-derived: city tenant `pg.citya` → state root `pg`

## Adding a New Tool

1. Create or edit a file in `src/tools/` with a `registerXyzTools(registry: ToolRegistry)` function
2. Define `ToolMetadata` with `name`, `group` (use existing `ToolGroup` or add new one in `src/types/index.ts`), `inputSchema` (JSON Schema), and async `handler`
3. Import and call the registration function in `src/tools/index.ts` → `registerAllTools()`
4. If adding a new group, add it to the `ToolGroup` union type in `src/types/index.ts` and to the `enable_tools` description in `src/tools/discover-tools.ts`

## Adding a New DIGIT API Method

1. Add the endpoint path to `ENDPOINTS` in `src/config/endpoints.ts`
2. Add the method to `DigitApiClient` in `src/services/digit-api.ts` following the existing pattern (use `this.request()` with `this.buildRequestInfo()`)
3. Call the new method from a tool handler

## Agent Tests (`agent-tests/`)

Uses `@anthropic-ai/claude-agent-sdk` V1 `query()` API. Each `sendPrompt()` starts a fresh subprocess with the MCP server. Flows are in `agent-tests/flows/` and export `{ name, description, estimatedSeconds, run }`.

Assertion helpers: `assertToolCalled()`, `assertSuccess()`, `getToolResult()`, `getAllToolResults()`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` | `3000` | HTTP port (http mode only) |
| `MCP_LOG_FILE` | `/var/log/digit-mcp/access.log` | Structured JSON log path |
| `MCP_ENABLE_ALL_GROUPS` | unset | `1` to enable all tool groups on startup |
| `CRS_ENVIRONMENT` | `chakshu-digit` | Environment key |
| `CRS_API_URL` | from env config | Override API base URL |
| `CRS_USERNAME` | — | DIGIT admin username |
| `CRS_PASSWORD` | — | DIGIT admin password |
| `CRS_TENANT_ID` | from env config | Tenant for login |
| `CRS_STATE_TENANT` | from env config | Override state tenant |

## DIGIT Docker Environment

The DIGIT platform runs via Docker Compose from `/root/code/tilt-demo/`. Never use other docker-compose files or start Kind clusters.

```bash
cd ~/code/tilt-demo && docker compose -f docker-compose.deploy.yaml up -d    # Start
cd ~/code/tilt-demo && docker compose -f docker-compose.deploy.yaml down      # Stop
cd ~/code/tilt-demo && docker compose -f docker-compose.deploy.yaml ps        # Status
```
