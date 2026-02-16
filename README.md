# CRS Validator MCP Server

MCP server for validating CRS/DIGIT tenant configurations with **progressive disclosure** — only 4 core tools load initially, with 8 more available on-demand across 4 phases matching the CRS data loader workflow.

## Quick Start

```bash
npm install
npm run build
npm start          # stdio transport
npx tsx test-validator.ts  # in-process test
```

## Progressive Disclosure

The server starts with 4 core tools. Additional tools are unlocked by calling `set_enabled_phases`:

| Phase | Tools | Purpose |
|-------|-------|---------|
| **core** (always on) | `discover_tools`, `set_enabled_phases`, `get_environment_info`, `mdms_get_tenants` | Discovery + environment |
| **phase1** | `validate_tenant`, `mdms_search`, `mdms_create` | Tenant validation + MDMS CRUD |
| **phase2** | `validate_boundary` | Boundary hierarchy validation |
| **phase3** | `validate_departments`, `validate_designations`, `validate_complaint_types` | Master data validation |
| **phase4** | `validate_employees` | HRMS employee validation |

When phases are enabled/disabled, the server sends `tools/list_changed` notifications so the MCP client re-fetches the tool list.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CRS_ENVIRONMENT` | `chakshu-digit` | Environment key (`chakshu-digit`, `dev`, `local`) |
| `CRS_USERNAME` | — | DIGIT username for auto-login |
| `CRS_PASSWORD` | — | DIGIT password for auto-login |
| `CRS_TENANT_ID` | from env config | Tenant ID for authentication |

## Claude Code Settings

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "crs-validator": {
      "command": "node",
      "args": ["/root/crs-validator-mcp/dist/index.js"],
      "env": {
        "CRS_ENVIRONMENT": "chakshu-digit"
      }
    }
  }
}
```
