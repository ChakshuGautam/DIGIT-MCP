# DIGIT MCP Server

[![CI](https://github.com/ChakshuGautam/digit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ChakshuGautam/digit-mcp/actions/workflows/ci.yml)

MCP server that bridges AI agents to the [DIGIT](https://docs.digit.org) eGov platform — **60 tools** across **14 groups** covering tenant management, grievance redressal (PGR), employee management, workflow, observability, and more.

Only 11 tools load initially (`core` + `docs`). The rest unlock on demand via `enable_tools`, so agents aren't overwhelmed with options they don't need yet.

## Install

One command to configure your MCP client:

```bash
curl -fsSL https://raw.githubusercontent.com/ChakshuGautam/DIGIT-MCP/main/install.sh | bash
```

This auto-detects your client (**Claude Code**, **Cursor**, **Windsurf**, **VS Code**), connects to the hosted server, and — for Claude Code — installs skills that guide the AI through DIGIT workflows.

### Non-interactive

```bash
# Remote mode (default) — connects to hosted server, no build needed
curl -fsSL https://raw.githubusercontent.com/ChakshuGautam/DIGIT-MCP/main/install.sh | bash -s -- --client claude-code --mode remote --yes

# Local mode — clones repo, builds, runs via stdio
curl -fsSL https://raw.githubusercontent.com/ChakshuGautam/DIGIT-MCP/main/install.sh | bash -s -- --client cursor --mode local --yes
```

### Manual Configuration

<details>
<summary>Claude Code</summary>

Add to `~/.claude.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "DIGIT-MCP": {
      "type": "http",
      "url": "https://mcp.egov.theflywheel.in/mcp"
    }
  }
}
```

Or for local stdio:

```json
{
  "mcpServers": {
    "DIGIT-MCP": {
      "command": "node",
      "args": ["/path/to/DIGIT-MCP/dist/index.js"],
      "env": {
        "CRS_ENVIRONMENT": "local",
        "CRS_USERNAME": "ADMIN",
        "CRS_PASSWORD": "eGov@123"
      }
    }
  }
}
```

</details>

<details>
<summary>Cursor / Windsurf / VS Code</summary>

Add to your MCP settings (`.cursor/mcp.json`, `.windsurf/mcp.json`, or VS Code MCP config):

```json
{
  "mcpServers": {
    "DIGIT-MCP": {
      "url": "https://mcp.egov.theflywheel.in/mcp"
    }
  }
}
```

</details>

## Quick Start

```bash
npm install
npm run build
npm start              # stdio transport (default)
npm run start:http     # HTTP transport on :3000
```

## Docker

```bash
docker run -p 3000:3000 \
  -e CRS_ENVIRONMENT=chakshu-digit \
  -e CRS_USERNAME=ADMIN \
  -e CRS_PASSWORD=eGov@123 \
  ghcr.io/chakshugautam/digit-mcp:latest

# Health check
curl http://localhost:3000/healthz
```

## Helm (Kubernetes)

```bash
helm install digit-mcp ./helm/digit-mcp \
  --set env.CRS_ENVIRONMENT=chakshu-digit \
  --set secret.CRS_USERNAME=ADMIN \
  --set secret.CRS_PASSWORD=eGov@123
```

See [`helm/digit-mcp/values.yaml`](helm/digit-mcp/values.yaml) for all options.

## Progressive Disclosure

The server starts with 11 tools. Agents call `enable_tools` to unlock groups as needed:

| Group | Tools | Purpose |
|-------|------:|---------|
| **core** | 8 | Discovery, auth, environment, health check |
| **docs** | 3 | Search docs.digit.org, fetch pages, OpenAPI catalog |
| **mdms** | 8 | Master data CRUD, schema management, tenant bootstrap/cleanup |
| **boundary** | 7 | Boundary hierarchy + entity CRUD |
| **masters** | 3 | Validate departments, designations, complaint types |
| **employees** | 3 | HRMS employee create, update, validate |
| **localization** | 2 | Search and upsert UI label translations |
| **pgr** | 6 | PGR complaints + workflow actions |
| **admin** | 7 | Filestore, access control, user management |
| **idgen** | 1 | ID generation |
| **location** | 1 | Geographic boundaries (legacy) |
| **encryption** | 2 | Encrypt/decrypt sensitive data |
| **monitoring** | 4 | Kafka lag, persister errors, DB counts |
| **tracing** | 5 | Distributed trace search, debug, slow-query detection |

Full tool reference with per-tool docs: **[docs/api/](docs/api/README.md)**

## Common Workflows

**Set up a new city with PGR:**
```
configure → tenant_bootstrap → city_setup → employee_create → pgr_create
```

**File a complaint and resolve it:**
```
pgr_create → pgr_update(ASSIGN) → pgr_update(RESOLVE) → pgr_update(RATE)
```

**Debug a failed API call:**
```
enable_tools(["tracing"]) → trace_debug → trace_get
```

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](docs/guides/getting-started.md) | Connect, authenticate, discover tools |
| [City Setup](docs/guides/city-setup.md) | Bootstrap a new tenant and set up PGR end-to-end |
| [PGR Complaint Lifecycle](docs/guides/pgr-lifecycle.md) | Create, assign, resolve, and rate complaints |
| [Debugging & Monitoring](docs/guides/debugging.md) | Trace failures, monitor persister health |
| [API Nuances](docs/guides/api-nuances.md) | Known DIGIT API quirks and gotchas |
| [Building a PGR UI](docs/ui.md) | Complete guide to building complaint management frontends |
| [Architecture](docs/architecture.md) | Server internals, transport, progressive disclosure |
| [API Reference](docs/api/README.md) | All 60 tools with parameters and examples |
| [OpenAPI Spec](docs/openapi.yaml) | Machine-readable API specification |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` | `3000` | HTTP port (http mode only) |
| `CRS_ENVIRONMENT` | `chakshu-digit` | Environment key |
| `CRS_USERNAME` | — | DIGIT admin username |
| `CRS_PASSWORD` | — | DIGIT admin password |
| `CRS_TENANT_ID` | from env config | Tenant for authentication |
| `MCP_ENABLE_ALL_GROUPS` | — | Set to `1` to enable all tool groups on startup |

## Environments

| Key | URL | State Tenant |
|-----|-----|--------------|
| `chakshu-digit` | `https://chakshu-digit.egov.theflywheel.in` | `statea` |
| `dev` | `https://unified-dev.digit.org` | `statea` |
| `local` | `http://0.0.0.0:18000` | `pg` |

## Testing

```bash
npm test                 # Quick validator tests
npm run test:safety      # Agent safety tests (53 tests)
npm run test:full        # Full integration suite (127 tests, 100% tool coverage)
npm run test:e2e         # E2E new-tenant test
npm run test:openapi     # Validate OpenAPI spec against live APIs
```

## Architecture

```
src/
├── index.ts              # Entry point (dual transport: stdio / HTTP)
├── server.ts             # MCP server with listChanged notifications
├── types/                # Shared types, ToolGroup, MDMS schema constants
├── config/
│   ├── environments.ts   # Named environment configs
│   └── endpoints.ts      # DIGIT API endpoint paths
├── services/
│   ├── digit-api.ts      # DIGIT API client (auth, multi-tenant, all services)
│   ├── session-store.ts  # PostgreSQL session tracking
│   └── telemetry.ts      # Matomo analytics
├── tools/                # 60 tools across 16 registration files
│   ├── registry.ts       # ToolRegistry (group enable/disable lifecycle)
│   └── index.ts          # registerAllTools() aggregator
├── utils/
│   ├── validation.ts     # Input validation (tenant IDs, mobile, control chars)
│   ├── sanitize.ts       # Response sanitization (prompt injection defense)
│   └── field-mask.ts     # Field projection for search results
docs/
├── api/                  # Per-tool API reference
├── guides/               # 5 walkthrough guides
├── architecture.md       # Server design and internals
├── ui.md                 # PGR frontend development guide
└── openapi.yaml          # OpenAPI 3.0 specification
skills/                   # Claude Code skills for guided DIGIT workflows
helm/digit-mcp/           # Helm chart for Kubernetes
```
