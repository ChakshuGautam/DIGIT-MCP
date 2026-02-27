# Building a PGR (Complaint Management) UI with DIGIT APIs

> One-shot guide: everything needed to build an end-to-end working complaint management UI against the DIGIT platform.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Authentication](#authentication)
3. [Tenant & Environment Setup](#tenant--environment-setup)
4. [API Reference (PGR)](#api-reference-pgr)
5. [API Reference (Supporting Services)](#api-reference-supporting-services)
6. [Data Models](#data-models)
7. [User Flows](#user-flows)
8. [DIGIT UI Component Library](#digit-ui-component-library)
9. [Localization](#localization)
10. [File Uploads](#file-uploads)
11. [Error Handling](#error-handling)
12. [Complete Code Examples](#complete-code-examples)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (React / Next.js / any SPA)                    │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
│  │ Citizen UI │  │ Employee UI│  │ Admin / Dashboard  │ │
│  │ - File     │  │ - Inbox    │  │ - Analytics        │ │
│  │ - Track    │  │ - Assign   │  │ - Config           │ │
│  │ - Rate     │  │ - Resolve  │  │ - Employee Mgmt    │ │
│  └─────┬──────┘  └─────┬──────┘  └────────┬───────────┘ │
│        └───────────┬────┘                  │             │
│                    ▼                       │             │
│           Request Wrapper (adds RequestInfo + auth)      │
└─────────────────────┬────────────────────────────────────┘
                      │ HTTPS
                      ▼
┌──────────────────────────────────────────────────────────┐
│  DIGIT Platform (API Gateway)                            │
│                                                          │
│  /user/oauth/token         → Auth Service                │
│  /pgr-services/v2/request  → PGR Service                 │
│  /egov-workflow-v2/        → Workflow Service             │
│  /mdms-v2/                 → Master Data Service         │
│  /filestore/v1/            → File Storage                │
│  /localization/            → Localization Service        │
│  /egov-hrms/               → Employee (HRMS) Service     │
│  /boundary-service/        → Boundary Service            │
└──────────────────────────────────────────────────────────┘
```

### Key Concepts

- **Multi-tenant**: Every API call requires a `tenantId`. City-level (e.g. `pg.citya`) for operational data, state-root (e.g. `pg`) for master data.
- **RequestInfo**: Every POST body must include a `RequestInfo` object with auth token and user info.
- **Workflow-driven**: Complaints move through states via explicit workflow actions (ASSIGN, RESOLVE, etc.).
- **MDMS-driven**: Complaint types, departments, designations are all master data — fetched at runtime, not hardcoded.
- **Localization-first**: All UI labels are localization keys resolved at runtime.

---

## Authentication

### Login (Get Access Token)

```
POST /user/oauth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic ZWdvdi11c2VyLWNsaWVudDo=
```

| Parameter    | Value                              |
|--------------|------------------------------------|
| `username`   | Mobile number (citizen) or employee code |
| `password`   | User password (default: `eGov@123`) |
| `userType`   | `CITIZEN` or `EMPLOYEE`            |
| `tenantId`   | City tenant (e.g. `pg.citya`)      |
| `grant_type` | `password`                         |
| `scope`      | `read`                             |

**Response:**
```json
{
  "access_token": "8b3f3e2a-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "token_type": "bearer",
  "expires_in": 3600,
  "scope": "read",
  "UserRequest": {
    "id": 123,
    "uuid": "c0ae57c8-...",
    "userName": "9876543210",
    "name": "Citizen Name",
    "mobileNumber": "9876543210",
    "type": "CITIZEN",
    "tenantId": "pg.citya",
    "roles": [
      { "code": "CITIZEN", "name": "Citizen", "tenantId": "pg.citya" }
    ]
  }
}
```

**Basic auth header**: Base64 of `egov-user-client:` (colon, no secret) = `ZWdvdi11c2VyLWNsaWVudDo=`

### Session Management

Store in session/local storage:
- `access_token` — for API calls
- `UserRequest` — for user info, roles, tenant context
- `userType` — `citizen` or `employee` (controls UI routing)

### RequestInfo Object

Every API call (except auth) must include this in the POST body:

```json
{
  "RequestInfo": {
    "apiId": "Rainmaker",
    "ver": "1.0",
    "ts": 1709000000000,
    "action": "",
    "did": "",
    "key": "",
    "msgId": "1709000000000|en_IN",
    "authToken": "<access_token>",
    "userInfo": {
      "id": 123,
      "uuid": "c0ae57c8-...",
      "userName": "9876543210",
      "name": "Citizen Name",
      "type": "CITIZEN",
      "tenantId": "pg.citya",
      "roles": [{ "code": "CITIZEN", "name": "Citizen", "tenantId": "pg.citya" }]
    }
  }
}
```

**Fields:**
- `msgId`: `"<timestamp>|<locale>"` — used for request tracing and localization context
- `authToken`: Bearer token from login
- `userInfo`: Full user object from login response (include for write operations)

---

## Tenant & Environment Setup

Before the UI can work, the tenant must have:

1. **Tenant record** in MDMS (`tenant.tenants` schema)
2. **Boundary hierarchy** (Country > State > District > City > Ward > Locality)
3. **Complaint types** (MDMS `RAINMAKER-PGR.ServiceDefs`)
4. **Departments** (MDMS `common-masters.Department`)
5. **Workflow definition** (PGR business service)
6. **At least one employee** with GRO + PGR_LME roles

Use the MCP tools `tenant_bootstrap` + `city_setup` to automate all of this, or see [DIGIT docs on tenant setup](https://docs.digit.org/platform/platform/core-services/mdms-v2-master-data-management-service).

### Fetching Tenant Config at App Startup

```
POST /mdms-v2/v2/_search
{
  "RequestInfo": { ... },
  "MdmsCriteria": {
    "tenantId": "pg",
    "schemaCode": "tenant.tenants",
    "limit": 100
  }
}
```

This returns all cities under the state root. Use this to populate city selectors.

---

## API Reference (PGR)

### Create Complaint

```
POST /pgr-services/v2/request/_create?tenantId=pg.citya
```

```json
{
  "RequestInfo": { "..." },
  "service": {
    "tenantId": "pg.citya",
    "serviceCode": "StreetLightNotWorking",
    "description": "The street light near main road is not working for 3 days",
    "accountId": "<citizen_uuid>",
    "address": {
      "city": "City A",
      "locality": {
        "code": "SUN04"
      }
    },
    "citizen": {
      "name": "Ramesh Kumar",
      "mobileNumber": "9876543210"
    },
    "source": "web"
  },
  "workflow": {
    "action": "APPLY"
  }
}
```

**Response:**
```json
{
  "ServiceWrappers": [{
    "service": {
      "serviceRequestId": "PG-PGR-2026-01-15-000001",
      "tenantId": "pg.citya",
      "serviceCode": "StreetLightNotWorking",
      "description": "...",
      "accountId": "citizen-uuid",
      "applicationStatus": "PENDINGFORASSIGNMENT",
      "address": { "..." },
      "citizen": { "..." },
      "auditDetails": {
        "createdBy": "citizen-uuid",
        "createdTime": 1709000000000,
        "lastModifiedBy": "citizen-uuid",
        "lastModifiedTime": 1709000000000
      }
    },
    "workflow": {
      "action": "APPLY",
      "businessId": "PG-PGR-2026-01-15-000001",
      "state": { "state": "CREATED", "applicationStatus": "PENDINGFORASSIGNMENT" }
    }
  }]
}
```

### Search Complaints

```
POST /pgr-services/v2/request/_search?tenantId=pg.citya
```

**Query parameters:**
| Param | Description |
|-------|-------------|
| `tenantId` | Required. City-level tenant ID |
| `serviceRequestId` | Filter by specific complaint ID |
| `applicationStatus` | Filter: `PENDINGFORASSIGNMENT`, `PENDINGATLME`, `PENDINGFORREASSIGNMENT`, `RESOLVED`, `REJECTED`, `CLOSEDAFTERRESOLUTION` |
| `limit` | Max results (default: 50) |
| `offset` | Pagination offset |

**Body:** `{ "RequestInfo": { ... } }`

**Response:** `{ "ServiceWrappers": [{ "service": {...}, "workflow": {...} }] }`

### Update Complaint (Workflow Actions)

```
POST /pgr-services/v2/request/_update?tenantId=pg.citya
```

```json
{
  "RequestInfo": { "..." },
  "service": { "... (full service object from search)" },
  "workflow": {
    "action": "ASSIGN",
    "assignes": ["employee-uuid"],
    "comments": "Assigning to field team",
    "verificationDocuments": []
  }
}
```

**Available actions by status:**

| Current Status | Action | Role Required | Next Status |
|---------------|--------|---------------|-------------|
| `PENDINGFORASSIGNMENT` | `ASSIGN` | GRO | `PENDINGATLME` |
| `PENDINGFORASSIGNMENT` | `REJECT` | GRO | `REJECTED` |
| `PENDINGATLME` | `RESOLVE` | PGR_LME | `RESOLVED` |
| `PENDINGATLME` | `REASSIGN` | GRO | `PENDINGFORREASSIGNMENT` |
| `PENDINGFORREASSIGNMENT` | `ASSIGN` | GRO | `PENDINGATLME` |
| `RESOLVED` | `REOPEN` | CITIZEN | `PENDINGFORASSIGNMENT` |
| `RESOLVED` | `RATE` | CITIZEN | `CLOSEDAFTERRESOLUTION` |

**RATE action** (citizen closes with rating):
```json
{
  "workflow": {
    "action": "RATE",
    "rating": 4,
    "comments": "Issue resolved satisfactorily"
  }
}
```

### Count Complaints

```
POST /pgr-services/v2/request/_count?tenantId=pg.citya
```

Body: `{ "RequestInfo": { ... } }` with optional filter params.

Returns: `{ "count": 42 }`

---

## API Reference (Supporting Services)

### MDMS — Fetch Complaint Types

```
POST /mdms-v2/v2/_search
{
  "RequestInfo": { ... },
  "MdmsCriteria": {
    "tenantId": "pg",
    "schemaCode": "RAINMAKER-PGR.ServiceDefs",
    "limit": 100
  }
}
```

**Response records:**
```json
{
  "serviceCode": "StreetLightNotWorking",
  "serviceName": "Street Light Not Working",
  "department": "DEPT_25",
  "slaHours": 336,
  "menuPath": "StreetLights",
  "order": 1,
  "active": true
}
```

Use `serviceCode` as the key for creating complaints. Group by `menuPath` for hierarchical type selection UI.

### MDMS — Fetch Departments

```
POST /mdms-v2/v2/_search
{
  "RequestInfo": { ... },
  "MdmsCriteria": {
    "tenantId": "pg",
    "schemaCode": "common-masters.Department",
    "limit": 100
  }
}
```

### Boundary — Fetch Localities

```
POST /boundary-service/boundary-relationships/_search
{
  "RequestInfo": { ... },
  "BoundaryRelationship": {
    "tenantId": "pg.citya",
    "hierarchyType": "ADMIN",
    "boundaryType": "Locality"
  }
}
```

Returns locality codes needed for the complaint address. Display as dropdown for the user.

### Workflow — Get Audit Trail

```
POST /egov-workflow-v2/egov-wf/process/_search
{
  "RequestInfo": { ... },
  "criteria": {
    "tenantId": "pg.citya",
    "businessIds": ["PG-PGR-2026-01-15-000001"],
    "limit": 50,
    "offset": 0
  }
}
```

Returns ordered list of workflow transitions. Use this for the complaint timeline.

**Response:**
```json
{
  "ProcessInstances": [{
    "id": "uuid",
    "tenantId": "pg.citya",
    "businessId": "PG-PGR-2026-01-15-000001",
    "businessService": "PGR",
    "action": "ASSIGN",
    "state": {
      "state": "ASSIGNED",
      "applicationStatus": "PENDINGATLME"
    },
    "assigner": { "name": "GRO Officer", "uuid": "..." },
    "assignes": [{ "name": "Field Agent", "uuid": "..." }],
    "comment": "Assigning to field team",
    "auditDetails": { "createdTime": 1709000000000 }
  }]
}
```

### Workflow — Get Business Service Definition

```
POST /egov-workflow-v2/egov-wf/businessservice/_search?tenantId=pg&businessServices=PGR
{
  "RequestInfo": { ... }
}
```

Returns the state machine definition. Use this to determine which actions are available for the current status and user role.

### HRMS — Search Employees

```
POST /egov-hrms/employees/_search?tenantId=pg.citya&limit=100
{
  "RequestInfo": { ... }
}
```

Use for the "assign to" dropdown in the GRO's assignment UI.

### User — Search Users

```
POST /user/_search
{
  "RequestInfo": { ... },
  "tenantId": "pg.citya",
  "uuid": ["employee-uuid-1"]
}
```

Use to resolve employee UUIDs to names for display.

### Filestore — Upload Attachment

```
POST /filestore/v1/files
Content-Type: multipart/form-data

file=<binary>
tenantId=pg.citya
module=rainmaker-pgr
```

**Response:** `{ "files": [{ "fileStoreId": "858452c7-..." }] }`

### Filestore — Get Download URL

```
GET /filestore/v1/files/url?tenantId=pg.citya&fileStoreIds=858452c7-...
```

**Response:** `{ "fileStoreIds": [{ "url": "https://...", "id": "858452c7-..." }] }`

### Localization — Fetch UI Labels

```
POST /localization/messages/v1/_search?tenantId=pg&locale=en_IN&module=rainmaker-pgr
{
  "RequestInfo": { ... }
}
```

**Response:**
```json
{
  "messages": [
    { "code": "SERVICEDEFS.STREETLIGHTNOTWORKING", "message": "Street Light Not Working", "module": "rainmaker-pgr", "locale": "en_IN" },
    { "code": "CS_COMMON_PENDINGFORASSIGNMENT", "message": "Pending for Assignment", "locale": "en_IN" }
  ]
}
```

---

## Data Models

### Complaint (Service)

```typescript
interface Service {
  serviceRequestId: string;        // e.g. "PG-PGR-2026-01-15-000001"
  tenantId: string;                // e.g. "pg.citya"
  serviceCode: string;             // e.g. "StreetLightNotWorking"
  description: string;
  accountId: string;               // citizen UUID
  applicationStatus: ApplicationStatus;
  rating?: number;                 // 1-5, set after RATE
  address: Address;
  citizen: Citizen;
  source: 'web' | 'mobile' | 'whatsapp';
  auditDetails: AuditDetails;
}

type ApplicationStatus =
  | 'PENDINGFORASSIGNMENT'
  | 'PENDINGATLME'
  | 'PENDINGFORREASSIGNMENT'
  | 'RESOLVED'
  | 'REJECTED'
  | 'CLOSEDAFTERRESOLUTION';

interface Address {
  city?: string;
  locality: { code: string; name?: string };
  landmark?: string;
  geoLocation?: { latitude: number; longitude: number };
}

interface Citizen {
  name: string;
  mobileNumber: string;  // 10 digits
  emailId?: string;
}

interface AuditDetails {
  createdBy: string;
  createdTime: number;  // epoch ms
  lastModifiedBy: string;
  lastModifiedTime: number;
}
```

### Workflow Action

```typescript
interface WorkflowAction {
  action: 'APPLY' | 'ASSIGN' | 'REASSIGN' | 'RESOLVE' | 'REJECT' | 'REOPEN' | 'RATE';
  assignes?: string[];          // employee UUIDs (for ASSIGN/REASSIGN)
  comments?: string;
  rating?: number;              // 1-5 (for RATE)
  verificationDocuments?: VerificationDocument[];
}

interface VerificationDocument {
  documentType: string;
  fileStoreId: string;
}
```

### Service Definition (Complaint Type)

```typescript
interface ServiceDef {
  serviceCode: string;         // e.g. "StreetLightNotWorking"
  serviceName: string;         // e.g. "Street Light Not Working"
  department: string;          // e.g. "DEPT_25"
  slaHours: number;            // e.g. 336 (14 days)
  menuPath: string;            // e.g. "StreetLights" — for grouping
  order: number;               // display order
  active: boolean;
}
```

### PGR Roles

| Role | Code | Responsibility |
|------|------|---------------|
| Citizen | `CITIZEN` | File complaints, track status, reopen, rate |
| Grievance Routing Officer | `GRO` | Assign, reassign, reject complaints |
| Last Mile Employee | `PGR_LME` | Resolve assigned complaints |
| Department GRO | `DGRO` | Department-level routing (optional) |
| CSR (Customer Service Rep) | `CSR` | File complaints on behalf of citizens |

---

## User Flows

### Flow 1: Citizen Files a Complaint

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Login / OTP     │────▶│  Select City     │────▶│  Select Type  │
│  (mobile number) │     │  (tenant picker) │     │  (MDMS types) │
└─────────────────┘     └──────────────────┘     └───────┬───────┘
                                                          │
      ┌───────────────────────────────────────────────────┘
      ▼
┌─────────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Select Locality │────▶│  Enter Details   │────▶│  Upload Photos│
│  (boundary API)  │     │  (description)   │     │  (filestore)  │
└─────────────────┘     └──────────────────┘     └───────┬───────┘
                                                          │
      ┌───────────────────────────────────────────────────┘
      ▼
┌─────────────────┐     ┌──────────────────┐
│  Review & Submit │────▶│  Success Page    │
│  (pgr_create)    │     │  (complaint ID)  │
└─────────────────┘     └──────────────────┘
```

**API sequence:**
1. `POST /user/oauth/token` — login
2. `POST /mdms-v2/v2/_search` (schema: `tenant.tenants`) — get cities
3. `POST /mdms-v2/v2/_search` (schema: `RAINMAKER-PGR.ServiceDefs`) — get types
4. `POST /boundary-service/boundary-relationships/_search` — get localities
5. `POST /filestore/v1/files` — upload photos (if any)
6. `POST /pgr-services/v2/request/_create` — submit complaint

### Flow 2: Citizen Tracks Complaint

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────┐
│  My Complaints   │────▶│  Complaint Detail│────▶│  Timeline     │
│  (pgr_search     │     │  (full details + │     │  (workflow     │
│   by mobile)     │     │   current status)│     │   process)     │
└─────────────────┘     └──────────────────┘     └───────┬───────┘
                                                          │
                              ┌────────────────────┐      │
                              │  Rate / Reopen     │◀─────┘
                              │  (if RESOLVED)     │
                              └────────────────────┘
```

**API sequence:**
1. `POST /pgr-services/v2/request/_search` with mobile number filter
2. `POST /egov-workflow-v2/egov-wf/process/_search` — get timeline
3. `POST /pgr-services/v2/request/_update` — RATE or REOPEN

### Flow 3: GRO Assigns Complaint

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Inbox           │────▶│  Complaint Detail│────▶│  Assign Modal │
│  (pgr_search     │     │  (full details + │     │  (select      │
│   PENDING*)      │     │   workflow trail) │     │   employee)   │
└─────────────────┘     └──────────────────┘     └───────┬───────┘
                                                          │
                                                          ▼
                                                ┌─────────────────┐
                                                │  Submit          │
                                                │  (pgr_update     │
                                                │   action=ASSIGN) │
                                                └─────────────────┘
```

**API sequence:**
1. `POST /pgr-services/v2/request/_search` (status filter: `PENDINGFORASSIGNMENT`)
2. `POST /egov-hrms/employees/_search` — get assignable employees
3. `POST /pgr-services/v2/request/_update` — ASSIGN with employee UUID

### Flow 4: LME Resolves Complaint

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────┐
│  My Assignments  │────▶│  Complaint Detail│────▶│  Resolve      │
│  (pgr_search     │     │  (+ timeline)    │     │  (add comment │
│   PENDINGATLME)  │     │                  │     │   + photos)   │
└─────────────────┘     └──────────────────┘     └───────┬───────┘
                                                          │
                                                          ▼
                                                ┌─────────────────┐
                                                │  Submit          │
                                                │  (pgr_update     │
                                                │   action=RESOLVE)│
                                                └─────────────────┘
```

### Complete Workflow State Machine

```
                              ┌─────────────────────────────┐
                              │                             │
    APPLY                     │  REOPEN (citizen)           │
      │                       │                             │
      ▼                       │                             │
┌─────────────────┐    ┌──────┴──────────┐    ┌─────────────────────┐
│ PENDING FOR     │───▶│   RESOLVED      │───▶│ CLOSED AFTER        │
│ ASSIGNMENT      │    │                 │    │ RESOLUTION          │
│ (GRO action)    │    │ (LME resolved)  │    │ (citizen rated)     │
└───┬──────┬──────┘    └─────────────────┘    └─────────────────────┘
    │      │                    ▲
    │      │ REJECT             │ RESOLVE
    │      ▼                    │
    │  ┌──────────┐    ┌────────┴────────┐
    │  │ REJECTED  │    │ PENDING AT LME  │
    │  │ (closed)  │    │ (field work)    │
    │  └──────────┘    └────────┬────────┘
    │                           │
    │ ASSIGN                    │ REASSIGN
    ▼                           ▼
    │              ┌─────────────────────┐
    └─────────────▶│ PENDING FOR         │
                   │ REASSIGNMENT        │──── ASSIGN ────▶ PENDING AT LME
                   └─────────────────────┘
```

---

## DIGIT UI Component Library

### GitHub Repository

The official DIGIT UI library is at:
- **Repo**: [egovernments/DIGIT-Frontend](https://github.com/egovernments/DIGIT-Frontend)
- **Components**: `micro-ui/web/micro-ui-internals/packages/react-components/`
- **Package**: `@egovernments/digit-ui-react-components` (v1.9.0)
- **CSS**: `@egovernments/digit-ui-css` (v1.9.0)

### Technology Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 17.0.2 | UI framework |
| React Router | 5.3.0 | Routing |
| Redux | 4.1.2 | Global state |
| React Query | 3.6.1 | Server state / caching |
| React Hook Form | 6.15.8 | Form management |
| react-i18next | 11.16.2 | Internationalization |
| Tailwind CSS | 1.9.6 | Utility-first CSS |
| Axios | 0.21.1 | HTTP client |
| react-table | 7.7.0 | Data tables |

### Recommended Stack for New UI

If building from scratch (not using the existing DIGIT micro-frontend), you can use any modern React stack. Recommended:

| Technology | Why |
|-----------|-----|
| React 18+ or Next.js 14+ | Modern React with server components |
| TanStack Query (React Query v5) | Server state, caching, mutations |
| React Hook Form + Zod | Form validation |
| Tailwind CSS 3+ | Styling (matches DIGIT patterns) |
| Axios or fetch | HTTP client |
| i18next | Localization |

### Key Components from DIGIT (Reference)

These are the main components used in the DIGIT PGR module. You can reuse them or build equivalents:

#### Layout
- `Card` — Container card with optional header
- `Header` — Page title
- `ActionBar` — Bottom action bar (mobile)
- `BreadCrumb` — Navigation breadcrumb
- `TopBar` — App header with logo and actions

#### Form Inputs
- `TextInput` — Text/number/date input with validation
- `TextArea` — Multi-line text input
- `Dropdown` — Select dropdown with search
- `RadioButtons` — Radio button group
- `CheckBox` — Checkbox input
- `MobileNumber` — Phone input with validation
- `DatePicker` — Date selector
- `LocationSearch` — Location/address search
- `UploadFile` — File/image upload

#### Display
- `StatusTable` + `Row` — Key-value display pairs
- `Table` — Data table with pagination, sorting, search
- `ConnectingCheckPoints` + `CheckPoint` — Workflow timeline
- `Toast` — Notification toasts (success/error/warning)
- `Loader` — Loading spinner
- `Banner` — Success/error banner
- `DisplayPhotos` — Photo gallery display

#### Actions
- `SubmitBar` — Submit button (fixed bottom on mobile)
- `LinkButton` — Inline link-styled button
- `Menu` — Dropdown menu for actions

#### Composers (Higher-Order)
- `FormComposer` — Dynamic multi-step form builder
- `InboxComposer` — Configurable inbox with filters, search, table
- `Modal` — Dialog/popup with actions

### Request Wrapper Pattern

The DIGIT UI uses a centralized request wrapper. Here's the pattern to replicate:

```typescript
// api-client.ts
import axios from 'axios';

const API_BASE = 'https://your-digit-api.example.com';

interface RequestOptions {
  url: string;
  method?: 'GET' | 'POST';
  params?: Record<string, string>;
  data?: Record<string, unknown>;
  auth?: boolean;
  userService?: boolean;
}

function getRequestInfo(auth: boolean, userService: boolean) {
  const user = getStoredUser(); // from session storage
  const locale = getLocale();   // e.g. "en_IN"

  return {
    apiId: "Rainmaker",
    ver: "1.0",
    ts: Date.now(),
    action: "",
    did: "",
    key: "",
    msgId: `${Date.now()}|${locale}`,
    ...(auth && user?.access_token ? { authToken: user.access_token } : {}),
    ...(userService && user?.info ? { userInfo: user.info } : {}),
  };
}

export async function digitRequest<T>(options: RequestOptions): Promise<T> {
  const { url, method = 'POST', params, data, auth = true, userService = true } = options;

  const body = method === 'POST' ? {
    RequestInfo: getRequestInfo(auth, userService),
    ...data,
  } : undefined;

  const response = await axios({
    method,
    url: `${API_BASE}${url}`,
    params,
    data: body,
    headers: auth ? { 'auth-token': getStoredUser()?.access_token } : {},
  });

  return response.data as T;
}
```

### Service Layer Pattern

```typescript
// services/pgr.ts
import { digitRequest } from './api-client';

export const PGRService = {
  async search(tenantId: string, filters: Record<string, string> = {}) {
    return digitRequest({
      url: '/pgr-services/v2/request/_search',
      params: { tenantId, ...filters },
    });
  },

  async create(service: ServiceCreatePayload, tenantId: string) {
    return digitRequest({
      url: '/pgr-services/v2/request/_create',
      params: { tenantId },
      data: { service, workflow: { action: 'APPLY' } },
    });
  },

  async update(service: Service, workflow: WorkflowAction) {
    return digitRequest({
      url: '/pgr-services/v2/request/_update',
      params: { tenantId: service.tenantId },
      data: { service, workflow },
    });
  },

  async count(tenantId: string, params: Record<string, string> = {}) {
    return digitRequest({
      url: '/pgr-services/v2/request/_count',
      params: { tenantId, ...params },
    });
  },
};
```

---

## Localization

All UI text should use localization keys, not hardcoded strings. Fetch labels at app startup.

### Key Modules

| Module | Contains |
|--------|----------|
| `rainmaker-pgr` | PGR complaint type names, status labels, UI text |
| `rainmaker-common` | Common labels (Submit, Cancel, etc.) |
| `rainmaker-hr` | Employee/HRMS labels |

### Localization Key Conventions

| Pattern | Example | Resolves to |
|---------|---------|-------------|
| `SERVICEDEFS.<CODE>` | `SERVICEDEFS.STREETLIGHTNOTWORKING` | "Street Light Not Working" |
| `CS_COMMON_<STATUS>` | `CS_COMMON_PENDINGFORASSIGNMENT` | "Pending for Assignment" |
| `DEPT_<CODE>` | `DEPT_25` | "Street Lights" |
| `CS_COMPLAINT_DETAILS_<FIELD>` | `CS_COMPLAINT_DETAILS_COMPLAINT_NO` | "Complaint No" |

### Fetch and Cache

```typescript
// Fetch all PGR labels at startup
const response = await digitRequest({
  url: '/localization/messages/v1/_search',
  params: { tenantId: 'pg', locale: 'en_IN', module: 'rainmaker-pgr' },
});

// Build lookup map
const labels = new Map<string, string>();
for (const msg of response.messages) {
  labels.set(msg.code, msg.message);
}

// Usage
function t(key: string): string {
  return labels.get(key) || key;
}
```

---

## File Uploads

### Upload Flow

```typescript
async function uploadPhoto(file: File, tenantId: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('tenantId', tenantId);
  formData.append('module', 'rainmaker-pgr');

  const response = await axios.post(
    `${API_BASE}/filestore/v1/files`,
    formData,
    {
      headers: {
        'Content-Type': 'multipart/form-data',
        'auth-token': getStoredUser()?.access_token,
      },
    }
  );

  return response.data.files[0].fileStoreId;
}
```

### Display Uploaded Photos

```typescript
async function getPhotoUrls(fileStoreIds: string[], tenantId: string): Promise<string[]> {
  const ids = fileStoreIds.join(',');
  const response = await axios.get(
    `${API_BASE}/filestore/v1/files/url?tenantId=${tenantId}&fileStoreIds=${ids}`,
  );
  return response.data.fileStoreIds.map((f: any) => f.url);
}
```

---

## Error Handling

### Common API Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `InvalidAccessTokenException` | Token expired | Re-login, redirect to login page |
| `UnauthorizedAccessException` | Missing role | Check user roles for the action |
| `Schema definition not found` | Missing MDMS schema | Run `tenant_bootstrap` on the state root |
| `Action ASSIGN not found in config` | Invalid workflow transition | Check current status before offering actions |
| `NON_UNIQUE` / `DUPLICATE` | Record already exists | Check before create, handle idempotently |

### Error Response Format

```json
{
  "Errors": [{
    "code": "InvalidInput",
    "message": "Some fields are invalid",
    "description": "Detailed error description",
    "params": ["fieldName"]
  }]
}
```

### Auth Error Handling Pattern

```typescript
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 ||
        error.response?.data?.Errors?.[0]?.code === 'InvalidAccessTokenException') {
      // Clear session and redirect to login
      clearSession();
      window.location.href = '/login?session_expired=true';
    }
    return Promise.reject(error);
  }
);
```

---

## Complete Code Examples

### Example: Minimal Complaint Creation Page (React)

```tsx
import { useState, useEffect } from 'react';
import { digitRequest } from '../services/api-client';

interface ComplaintType {
  serviceCode: string;
  serviceName: string;
  department: string;
}

interface Locality {
  code: string;
  name: string;
}

export function CreateComplaint({ tenantId }: { tenantId: string }) {
  const [types, setTypes] = useState<ComplaintType[]>([]);
  const [localities, setLocalities] = useState<Locality[]>([]);
  const [form, setForm] = useState({
    serviceCode: '',
    description: '',
    localityCode: '',
    citizenName: '',
    citizenMobile: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Fetch complaint types on mount
  useEffect(() => {
    const root = tenantId.split('.')[0];

    // Fetch complaint types
    digitRequest({
      url: '/mdms-v2/v2/_search',
      data: {
        MdmsCriteria: {
          tenantId: root,
          schemaCode: 'RAINMAKER-PGR.ServiceDefs',
          limit: 100,
        },
      },
    }).then((res: any) => {
      const defs = res.mdms?.map((r: any) => r.data).filter((d: any) => d.active) || [];
      setTypes(defs);
    });

    // Fetch localities
    digitRequest({
      url: '/boundary-service/boundary-relationships/_search',
      data: {
        BoundaryRelationship: {
          tenantId,
          hierarchyType: 'ADMIN',
          boundaryType: 'Locality',
        },
      },
    }).then((res: any) => {
      // Extract locality codes from the boundary tree
      const locs: Locality[] = [];
      const extract = (items: any[]) => {
        for (const item of items) {
          if (item.boundaryType === 'Locality') {
            locs.push({ code: item.code, name: item.code });
          }
          if (item.children) extract(item.children);
        }
      };
      for (const tb of res.TenantBoundary || []) {
        if (tb.boundary) extract(tb.boundary);
      }
      setLocalities(locs);
    });
  }, [tenantId]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res: any = await digitRequest({
        url: '/pgr-services/v2/request/_create',
        params: { tenantId },
        data: {
          service: {
            tenantId,
            serviceCode: form.serviceCode,
            description: form.description,
            address: {
              locality: { code: form.localityCode },
            },
            citizen: {
              name: form.citizenName,
              mobileNumber: form.citizenMobile,
            },
            source: 'web',
          },
          workflow: { action: 'APPLY' },
        },
      });
      const id = res.ServiceWrappers?.[0]?.service?.serviceRequestId;
      setResult(id);
    } catch (err) {
      alert('Failed to create complaint: ' + (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-bold text-green-600">Complaint Filed!</h2>
        <p className="mt-2">Your complaint ID: <strong>{result}</strong></p>
        <p className="mt-1 text-gray-500">Track status in "My Complaints"</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">File a Complaint</h1>

      <label className="block mb-4">
        <span className="text-sm font-medium">Complaint Type</span>
        <select
          className="mt-1 block w-full border rounded p-2"
          value={form.serviceCode}
          onChange={(e) => setForm({ ...form, serviceCode: e.target.value })}
        >
          <option value="">Select type...</option>
          {types.map((t) => (
            <option key={t.serviceCode} value={t.serviceCode}>
              {t.serviceName}
            </option>
          ))}
        </select>
      </label>

      <label className="block mb-4">
        <span className="text-sm font-medium">Locality</span>
        <select
          className="mt-1 block w-full border rounded p-2"
          value={form.localityCode}
          onChange={(e) => setForm({ ...form, localityCode: e.target.value })}
        >
          <option value="">Select locality...</option>
          {localities.map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
      </label>

      <label className="block mb-4">
        <span className="text-sm font-medium">Description</span>
        <textarea
          className="mt-1 block w-full border rounded p-2"
          rows={4}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Describe your complaint..."
        />
      </label>

      <label className="block mb-4">
        <span className="text-sm font-medium">Your Name</span>
        <input
          className="mt-1 block w-full border rounded p-2"
          value={form.citizenName}
          onChange={(e) => setForm({ ...form, citizenName: e.target.value })}
        />
      </label>

      <label className="block mb-4">
        <span className="text-sm font-medium">Mobile Number</span>
        <input
          className="mt-1 block w-full border rounded p-2"
          value={form.citizenMobile}
          onChange={(e) => setForm({ ...form, citizenMobile: e.target.value })}
          maxLength={10}
          pattern="[0-9]{10}"
        />
      </label>

      <button
        className="w-full bg-blue-600 text-white py-3 rounded font-medium disabled:opacity-50"
        onClick={handleSubmit}
        disabled={submitting || !form.serviceCode || !form.localityCode || !form.description}
      >
        {submitting ? 'Submitting...' : 'Submit Complaint'}
      </button>
    </div>
  );
}
```

### Example: Employee Inbox with Assign Action

```tsx
import { useState, useEffect } from 'react';
import { digitRequest } from '../services/api-client';

export function EmployeeInbox({ tenantId }: { tenantId: string }) {
  const [complaints, setComplaints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('PENDINGFORASSIGNMENT');

  useEffect(() => {
    setLoading(true);
    digitRequest({
      url: '/pgr-services/v2/request/_search',
      params: { tenantId, applicationStatus: statusFilter, limit: '50' },
    }).then((res: any) => {
      setComplaints(res.ServiceWrappers || []);
    }).finally(() => setLoading(false));
  }, [tenantId, statusFilter]);

  async function handleAssign(serviceRequestId: string, service: any) {
    // In production: show modal to select employee from HRMS search
    const comment = prompt('Assignment comment:');
    if (!comment) return;

    await digitRequest({
      url: '/pgr-services/v2/request/_update',
      params: { tenantId },
      data: {
        service,
        workflow: {
          action: 'ASSIGN',
          comments: comment,
        },
      },
    });

    // Refresh list
    setComplaints(complaints.filter(c =>
      c.service.serviceRequestId !== serviceRequestId
    ));
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Complaint Inbox</h1>

      <div className="flex gap-2 mb-4">
        {['PENDINGFORASSIGNMENT', 'PENDINGATLME', 'RESOLVED'].map(status => (
          <button
            key={status}
            className={`px-3 py-1 rounded ${
              statusFilter === status ? 'bg-blue-600 text-white' : 'bg-gray-200'
            }`}
            onClick={() => setStatusFilter(status)}
          >
            {status.replace(/([A-Z])/g, ' $1').trim()}
          </button>
        ))}
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : complaints.length === 0 ? (
        <p className="text-gray-500">No complaints found</p>
      ) : (
        <div className="space-y-4">
          {complaints.map(({ service, workflow }) => (
            <div key={service.serviceRequestId} className="border rounded p-4">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-medium">{service.serviceRequestId}</p>
                  <p className="text-sm text-gray-600">{service.serviceCode}</p>
                  <p className="text-sm mt-1">{service.description}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(service.auditDetails.createdTime).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  {service.applicationStatus === 'PENDINGFORASSIGNMENT' && (
                    <>
                      <button
                        className="px-3 py-1 bg-green-600 text-white rounded text-sm"
                        onClick={() => handleAssign(service.serviceRequestId, service)}
                      >
                        Assign
                      </button>
                      <button className="px-3 py-1 bg-red-600 text-white rounded text-sm">
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### Example: Workflow Timeline Component

```tsx
interface TimelineEntry {
  action: string;
  state: { state: string; applicationStatus: string };
  assigner?: { name: string };
  assignes?: Array<{ name: string }>;
  comment?: string;
  auditDetails: { createdTime: number };
}

export function ComplaintTimeline({ entries }: { entries: TimelineEntry[] }) {
  const statusColors: Record<string, string> = {
    PENDINGFORASSIGNMENT: 'bg-yellow-100 text-yellow-800',
    PENDINGATLME: 'bg-blue-100 text-blue-800',
    PENDINGFORREASSIGNMENT: 'bg-orange-100 text-orange-800',
    RESOLVED: 'bg-green-100 text-green-800',
    REJECTED: 'bg-red-100 text-red-800',
    CLOSEDAFTERRESOLUTION: 'bg-gray-100 text-gray-800',
  };

  return (
    <div className="relative">
      {entries.map((entry, i) => (
        <div key={i} className="flex gap-4 mb-6">
          {/* Timeline dot and line */}
          <div className="flex flex-col items-center">
            <div className="w-3 h-3 rounded-full bg-blue-600" />
            {i < entries.length - 1 && (
              <div className="w-0.5 flex-1 bg-gray-300 mt-1" />
            )}
          </div>
          {/* Content */}
          <div className="flex-1 -mt-1">
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                statusColors[entry.state.applicationStatus] || 'bg-gray-100'
              }`}>
                {entry.action}
              </span>
              <span className="text-xs text-gray-400">
                {new Date(entry.auditDetails.createdTime).toLocaleString()}
              </span>
            </div>
            {entry.assigner && (
              <p className="text-sm text-gray-600 mt-1">
                By: {entry.assigner.name}
              </p>
            )}
            {entry.assignes?.length && (
              <p className="text-sm text-gray-600">
                Assigned to: {entry.assignes.map(a => a.name).join(', ')}
              </p>
            )}
            {entry.comment && (
              <p className="text-sm mt-1 italic">"{entry.comment}"</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

## Further Reading

- [DIGIT Platform Documentation](https://docs.digit.org/platform)
- [PGR Workflows](https://docs.digit.org/local-governance/v2.8/products/modules/public-grievances-and-redressal/pgr-workflows)
- [MDMS v2 Setup](https://docs.digit.org/platform/platform/core-services/mdms-v2-master-data-management-service)
- [DIGIT Frontend Repo](https://github.com/egovernments/DIGIT-Frontend)
- Use `api_catalog` MCP tool for the full OpenAPI 3.0 spec of all 37 endpoints
- Use `docs_search` MCP tool to search docs.digit.org for specific topics
