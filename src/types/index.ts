// Shared types for CRS Validator MCP

// Tool groups for progressive disclosure
export type ToolGroup = 'core' | 'mdms' | 'boundary' | 'masters' | 'employees' | 'localization' | 'pgr' | 'admin' | 'idgen' | 'location' | 'encryption' | 'docs' | 'monitoring' | 'tracing';

export const ALL_GROUPS: ToolGroup[] = ['core', 'mdms', 'boundary', 'masters', 'employees', 'localization', 'pgr', 'admin', 'idgen', 'location', 'encryption', 'docs', 'monitoring', 'tracing'];

// Tool metadata stored in the registry
export interface ToolMetadata {
  name: string;
  group: ToolGroup;
  category: 'discovery' | 'environment' | 'mdms' | 'validation' | 'localization' | 'pgr' | 'workflow' | 'filestore' | 'access-control' | 'idgen' | 'location' | 'encryption' | 'boundary-mgmt' | 'hrms' | 'user' | 'docs' | 'monitoring' | 'tracing';
  risk: 'read' | 'write';
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

// DIGIT API types
export interface RequestInfo {
  apiId: string;
  ver?: string;
  ts?: number;
  action?: string;
  did?: string;
  key?: string;
  msgId: string;
  authToken: string;
  userInfo?: UserInfo;
}

export interface UserInfo {
  id?: number;
  uuid?: string;
  userName: string;
  name: string;
  mobileNumber?: string;
  emailId?: string;
  type?: string;
  tenantId: string;
  roles?: Role[];
}

export interface Role {
  code: string;
  name: string;
  tenantId?: string;
  description?: string;
}

export interface MdmsRecord {
  id: string;
  tenantId: string;
  schemaCode: string;
  uniqueIdentifier: string;
  data: Record<string, unknown>;
  isActive: boolean;
  auditDetails?: {
    createdBy: string;
    createdTime: number;
    lastModifiedBy: string;
    lastModifiedTime: number;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  summary: string;
}

export interface ValidationError {
  field: string;
  value?: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  value?: string;
  message: string;
}

export interface ApiError {
  code: string;
  message: string;
  description?: string;
}

export interface Environment {
  name: string;
  url: string;
  stateTenantId: string;
  description: string;
  endpointOverrides?: Record<string, string>; // Keys should match ENDPOINTS keys — validated at runtime
}

// MDMS Schema codes
export const MDMS_SCHEMAS = {
  DEPARTMENT: 'common-masters.Department',
  DESIGNATION: 'common-masters.Designation',
  GENDER_TYPE: 'common-masters.GenderType',
  EMPLOYEE_STATUS: 'egov-hrms.EmployeeStatus',
  EMPLOYEE_TYPE: 'egov-hrms.EmployeeType',
  ROLES: 'ACCESSCONTROL-ROLES.roles',
  PGR_SERVICE_DEFS: 'RAINMAKER-PGR.ServiceDefs',
  TENANT: 'tenant.tenants',
} as const;
