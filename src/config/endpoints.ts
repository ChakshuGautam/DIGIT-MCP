// DIGIT API endpoint paths
export const ENDPOINTS = {
  // Authentication
  AUTH: '/user/oauth/token',
  USER_SEARCH: '/user/_search',

  // MDMS v2
  MDMS_SEARCH: '/egov-mdms-service/v2/_search',
  MDMS_CREATE: '/egov-mdms-service/v2/_create',

  // Boundary
  BOUNDARY_SEARCH: '/boundary-service/boundary/_search',
  BOUNDARY_HIERARCHY_SEARCH: '/boundary-service/boundary-hierarchy-definition/_search',

  // HRMS
  HRMS_EMPLOYEES_SEARCH: '/egov-hrms/employees/_search',

  // Localization
  LOCALIZATION_SEARCH: '/localization/messages/v1/_search',
  LOCALIZATION_UPSERT: '/localization/messages/v1/_upsert',

  // PGR
  PGR_CREATE: '/pgr-services/v2/request/_create',
  PGR_SEARCH: '/pgr-services/v2/request/_search',
  PGR_UPDATE: '/pgr-services/v2/request/_update',

  // Workflow
  WORKFLOW_BUSINESS_SERVICE_SEARCH: '/egov-workflow-v2/egov-wf/businessservice/_search',
  WORKFLOW_PROCESS_SEARCH: '/egov-workflow-v2/egov-wf/process/_search',

  // Filestore
  FILESTORE_UPLOAD: '/filestore/v1/files',
  FILESTORE_URL: '/filestore/v1/files/url',

  // Access Control
  ACCESS_ROLES_SEARCH: '/access/v1/roles/_search',
  ACCESS_ACTIONS_SEARCH: '/access/v1/actions/_search',
} as const;

// OAuth credentials
export const OAUTH_CONFIG = {
  clientId: 'egov-user-client',
  clientSecret: '',
  grantType: 'password',
  scope: 'read',
} as const;
