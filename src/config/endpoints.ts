// DIGIT API endpoint paths
export const ENDPOINTS = {
  // Authentication / User
  AUTH: '/user/oauth/token',
  USER_SEARCH: '/user/_search',
  USER_CREATE: '/user/users/_createnovalidate',
  USER_UPDATE: '/user/users/_updatenovalidate',

  // MDMS v2
  MDMS_SEARCH: '/egov-mdms-service/v2/_search',
  MDMS_CREATE: '/egov-mdms-service/v2/_create',
  MDMS_SCHEMA_CREATE: '/mdms-v2/schema/v1/_create',
  MDMS_SCHEMA_SEARCH: '/mdms-v2/schema/v1/_search',

  // Boundary
  BOUNDARY_SEARCH: '/boundary-service/boundary/_search',
  BOUNDARY_CREATE: '/boundary-service/boundary/_create',
  BOUNDARY_HIERARCHY_SEARCH: '/boundary-service/boundary-hierarchy-definition/_search',
  BOUNDARY_HIERARCHY_CREATE: '/boundary-service/boundary-hierarchy-definition/_create',
  BOUNDARY_RELATIONSHIP_CREATE: '/boundary-service/boundary-relationships/_create',
  BOUNDARY_RELATIONSHIP_SEARCH: '/boundary-service/boundary-relationships/_search',

  // HRMS
  HRMS_EMPLOYEES_SEARCH: '/egov-hrms/employees/_search',
  HRMS_EMPLOYEES_CREATE: '/egov-hrms/employees/_create',
  HRMS_EMPLOYEES_UPDATE: '/egov-hrms/employees/_update',

  // Localization
  LOCALIZATION_SEARCH: '/localization/messages/v1/_search',
  LOCALIZATION_UPSERT: '/localization/messages/v1/_upsert',

  // PGR
  PGR_CREATE: '/pgr-services/v2/request/_create',
  PGR_SEARCH: '/pgr-services/v2/request/_search',
  PGR_UPDATE: '/pgr-services/v2/request/_update',

  // Workflow
  WORKFLOW_BUSINESS_SERVICE_SEARCH: '/egov-workflow-v2/egov-wf/businessservice/_search',
  WORKFLOW_BUSINESS_SERVICE_CREATE: '/egov-workflow-v2/egov-wf/businessservice/_create',
  WORKFLOW_PROCESS_SEARCH: '/egov-workflow-v2/egov-wf/process/_search',

  // Filestore
  FILESTORE_UPLOAD: '/filestore/v1/files',
  FILESTORE_URL: '/filestore/v1/files/url',

  // Access Control
  ACCESS_ROLES_SEARCH: '/access/v1/roles/_search',
  ACCESS_ACTIONS_SEARCH: '/access/v1/actions/_search',

  // ID Generation
  IDGEN_GENERATE: '/egov-idgen/id/_generate',

  // Location
  LOCATION_BOUNDARY_SEARCH: '/egov-location/location/v11/boundarys/_search',

  // Encryption
  ENC_ENCRYPT: '/egov-enc-service/crypto/v1/_encrypt',
  ENC_DECRYPT: '/egov-enc-service/crypto/v1/_decrypt',

  // Boundary Management
  BNDRY_MGMT_PROCESS: '/egov-bndry-mgmnt/v1/_process',
  BNDRY_MGMT_GENERATE: '/egov-bndry-mgmnt/v1/_generate',
  BNDRY_MGMT_PROCESS_SEARCH: '/egov-bndry-mgmnt/v1/_process-search',
  BNDRY_MGMT_GENERATE_SEARCH: '/egov-bndry-mgmnt/v1/_generate-search',
} as const;

// OAuth credentials
export const OAUTH_CONFIG = {
  clientId: 'egov-user-client',
  clientSecret: '',
  grantType: 'password',
  scope: 'read',
} as const;
