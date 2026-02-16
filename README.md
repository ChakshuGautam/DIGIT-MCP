# DIGIT MCP Server

MCP server for interacting with DIGIT platform APIs with **progressive disclosure** — 5 core tools load initially, with 26 more available on-demand across 10 domain groups.

## Quick Start

```bash
npm install
npm run build
npm start                      # stdio transport
npx tsx test-integration.ts    # integration test (requires running DIGIT stack)
```

## Progressive Disclosure

The server starts with 5 core tools. Additional tools are unlocked by calling `enable_tools`:

| Group | Tools | Purpose |
|-------|-------|---------|
| **core** (always on) | `discover_tools`, `enable_tools`, `configure`, `get_environment_info`, `mdms_get_tenants` | Discovery + environment + auth |
| **mdms** | `validate_tenant`, `mdms_search`, `mdms_create` | Tenant validation + MDMS v2 CRUD |
| **boundary** | `validate_boundary`, `boundary_mgmt_process`, `boundary_mgmt_search`, `boundary_mgmt_generate`, `boundary_mgmt_download` | Boundary hierarchy validation + boundary management CRUD |
| **masters** | `validate_departments`, `validate_designations`, `validate_complaint_types` | Department, designation, PGR service def validation |
| **employees** | `validate_employees` | HRMS employee validation |
| **localization** | `localization_search`, `localization_upsert` | UI label search + create/update |
| **pgr** | `pgr_search`, `pgr_create`, `pgr_update`, `workflow_business_services`, `workflow_process_search` | PGR complaints + workflow state machine |
| **admin** | `filestore_get_urls`, `access_roles_search`, `access_actions_search` | Filestore URLs + access control roles/actions |
| **idgen** | `idgen_generate` | ID generation (complaint numbers, application IDs) |
| **location** | `location_search` | Geographic boundary search (legacy egov-location) |
| **encryption** | `encrypt_data`, `decrypt_data` | Encrypt/decrypt sensitive data |

When groups are enabled/disabled, the server sends `tools/list_changed` notifications so the MCP client re-fetches the tool list.

## All 31 Tools

| # | Tool | Group | Risk | DIGIT Service | Description |
|---|------|-------|------|---------------|-------------|
| 1 | `discover_tools` | core | read | — | List all tools and their groups |
| 2 | `enable_tools` | core | read | — | Enable/disable tool groups on demand |
| 3 | `configure` | core | read | egov-user | Authenticate with a DIGIT environment |
| 4 | `get_environment_info` | core | read | — | Show current environment config |
| 5 | `mdms_get_tenants` | core | read | egov-mdms-service | List all tenants from MDMS |
| 6 | `validate_tenant` | mdms | read | egov-mdms-service | Check if a tenant code exists |
| 7 | `mdms_search` | mdms | read | egov-mdms-service | Generic MDMS v2 search by schema code |
| 8 | `mdms_create` | mdms | write | egov-mdms-service | Create a new MDMS v2 record |
| 9 | `validate_boundary` | boundary | read | boundary-service | Validate boundary hierarchy for a tenant |
| 10 | `validate_departments` | masters | read | egov-mdms-service | Validate department records in MDMS |
| 11 | `validate_designations` | masters | read | egov-mdms-service | Validate designation records in MDMS |
| 12 | `validate_complaint_types` | masters | read | egov-mdms-service | Validate PGR service definitions in MDMS |
| 13 | `validate_employees` | employees | read | egov-hrms | Validate HRMS employee setup |
| 14 | `localization_search` | localization | read | egov-localization | Search localization messages by locale/module |
| 15 | `localization_upsert` | localization | write | egov-localization | Create or update localization messages |
| 16 | `pgr_search` | pgr | read | pgr-services | Search PGR complaints/service requests |
| 17 | `pgr_create` | pgr | write | pgr-services | Create a new PGR complaint |
| 18 | `pgr_update` | pgr | write | pgr-services | Update complaint status via workflow action |
| 19 | `workflow_business_services` | pgr | read | egov-workflow-v2 | Search workflow state machine definitions |
| 20 | `workflow_process_search` | pgr | read | egov-workflow-v2 | Search workflow process audit trail |
| 21 | `filestore_get_urls` | admin | read | egov-filestore | Get download URLs for filestore IDs |
| 22 | `access_roles_search` | admin | read | egov-accesscontrol | Search all defined roles |
| 23 | `access_actions_search` | admin | read | egov-accesscontrol | Search actions/permissions by role |
| 24 | `idgen_generate` | idgen | write | egov-idgen | Generate unique formatted IDs |
| 25 | `location_search` | location | read | egov-location | Search geographic boundaries (legacy) |
| 26 | `encrypt_data` | encryption | write | egov-enc-service | Encrypt sensitive data values |
| 27 | `decrypt_data` | encryption | write | egov-enc-service | Decrypt encrypted data values |
| 28 | `boundary_mgmt_process` | boundary | write | egov-bndry-mgmnt | Process/upload boundary data |
| 29 | `boundary_mgmt_search` | boundary | read | egov-bndry-mgmnt | Search processed boundary data |
| 30 | `boundary_mgmt_generate` | boundary | write | egov-bndry-mgmnt | Generate boundary codes |
| 31 | `boundary_mgmt_download` | boundary | read | egov-bndry-mgmnt | Search/download generated boundaries |

## DIGIT API Coverage

### All Services Covered (16 of 16)

| Kong Route | DIGIT Service | MCP Tools | Endpoints Used |
|------------|--------------|-----------|----------------|
| `/user` | egov-user | `configure` | `/user/oauth/token`, `/user/_search` |
| `/mdms-v2` | egov-mdms-service | `mdms_get_tenants`, `validate_tenant`, `mdms_search`, `mdms_create`, `validate_departments`, `validate_designations`, `validate_complaint_types` | `/v2/_search`, `/v2/_create` |
| `/boundary-service` | boundary-service | `validate_boundary` | `/boundary/_search`, `/boundary-hierarchy-definition/_search` |
| `/egov-hrms` | egov-hrms | `validate_employees` | `/employees/_search` |
| `/localization` | egov-localization | `localization_search`, `localization_upsert` | `/messages/v1/_search`, `/messages/v1/_upsert` |
| `/pgr-services` | pgr-services | `pgr_search`, `pgr_create`, `pgr_update` | `/v2/request/_search`, `/v2/request/_create`, `/v2/request/_update` |
| `/egov-workflow-v2` | egov-workflow-v2 | `workflow_business_services`, `workflow_process_search` | `/egov-wf/businessservice/_search`, `/egov-wf/process/_search` |
| `/filestore` | egov-filestore | `filestore_get_urls` | `/v1/files/url` |
| `/access` | egov-accesscontrol | `access_roles_search`, `access_actions_search` | `/v1/roles/_search`, `/v1/actions/_search` |
| `/egov-idgen` | egov-idgen | `idgen_generate` | `/id/_generate` |
| `/egov-location` | egov-location | `location_search` | `/location/v11/boundarys/_search` |
| `/egov-enc-service` | egov-enc-service | `encrypt_data`, `decrypt_data` | `/crypto/v1/_encrypt`, `/crypto/v1/_decrypt` |
| `/egov-bndry-mgmnt` | egov-bndry-mgmnt | `boundary_mgmt_process`, `boundary_mgmt_search`, `boundary_mgmt_generate`, `boundary_mgmt_download` | `/v1/_process`, `/v1/_process-search`, `/v1/_generate`, `/v1/_generate-search` |
| `/common-persist` | egov-persister | — (Kafka consumer) | No HTTP API — async event consumer that persists data to PostgreSQL |

### Infrastructure (not applicable)

| Kong Route | Service | Purpose |
|------------|---------|---------|
| `/digit-ui` | digit-ui | Frontend web application |
| `/jupyter` | digit-jupyter | Jupyter notebook development tool |
| `/health/*` | various | Health check endpoints (5 routes) |

### OpenAPI Specification

Full API documentation is available at [`docs/openapi.yaml`](docs/openapi.yaml) — an OpenAPI 3.0 spec covering all 26 DIGIT API endpoints across 13 services with HTTP APIs.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CRS_ENVIRONMENT` | `chakshu-digit` | Environment key (`chakshu-digit`, `dev`, `local`) |
| `CRS_USERNAME` | — | DIGIT username for auto-login |
| `CRS_PASSWORD` | — | DIGIT password for auto-login |
| `CRS_TENANT_ID` | from env config | Tenant ID for authentication |

## Environments

| Key | Name | URL | State Tenant |
|-----|------|-----|--------------|
| `chakshu-digit` | Chakshu Dev | `https://chakshu-digit.egov.theflywheel.in` | `statea` |
| `dev` | Unified Dev | `https://unified-dev.digit.org` | `statea` |
| `local` | Local Docker | `http://0.0.0.0:18000` (Kong) | `pg` |

## Claude Code Settings

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "crs-validator": {
      "command": "node",
      "args": ["/root/crs-validator-mcp/dist/index.js"],
      "env": {
        "CRS_ENVIRONMENT": "local",
        "CRS_USERNAME": "ADMIN",
        "CRS_PASSWORD": "eGov@123",
        "CRS_TENANT_ID": "pg"
      }
    }
  }
}
```

## Architecture

```
src/
├── index.ts                  # Entry point (stdio transport)
├── server.ts                 # MCP server with listChanged capability
├── types/index.ts            # Shared types, MDMS schema constants
├── config/
│   ├── environments.ts       # Environment configs (dev, local, chakshu-digit)
│   └── endpoints.ts          # DIGIT API endpoint paths + OAuth config
├── services/
│   └── digit-api.ts          # DIGIT API client (auth, MDMS, PGR, HRMS, idgen, encryption, etc.)
└── tools/
    ├── registry.ts           # ToolRegistry (group mgmt, enable/disable, summary)
    ├── discover-tools.ts     # discover_tools + enable_tools (meta-tools)
    ├── mdms-tenant.ts        # configure, get_environment_info, mdms_get_tenants, validate_tenant, mdms_search, mdms_create
    ├── validators.ts         # validate_boundary, validate_departments, validate_designations, validate_complaint_types, validate_employees, boundary_mgmt_*
    ├── localization.ts       # localization_search, localization_upsert
    ├── pgr-workflow.ts       # pgr_search, pgr_create, pgr_update, workflow_business_services, workflow_process_search
    ├── filestore-acl.ts      # filestore_get_urls, access_roles_search, access_actions_search
    ├── idgen-location.ts     # idgen_generate, location_search
    ├── encryption.ts         # encrypt_data, decrypt_data
    └── index.ts              # Aggregator: registerAllTools()
docs/
└── openapi.yaml              # OpenAPI 3.0 spec for all DIGIT API endpoints
```
