import { ENDPOINTS, OAUTH_CONFIG } from '../config/endpoints.js';
import { getEnvironment } from '../config/environments.js';
import type { RequestInfo, UserInfo, MdmsRecord, ApiError, Environment } from '../types/index.js';

class ApiClientError extends Error {
  public errors: ApiError[];
  public statusCode: number;

  constructor(errors: ApiError[], statusCode: number) {
    super(errors.map((e) => e.message).join(', '));
    this.name = 'ApiClientError';
    this.errors = errors;
    this.statusCode = statusCode;
  }
}

class DigitApiClient {
  private environment: Environment;
  private authToken: string | null = null;
  private userInfo: UserInfo | null = null;

  constructor() {
    this.environment = getEnvironment();
  }

  getEnvironmentInfo(): Environment {
    return this.environment;
  }

  setEnvironment(envKey: string): void {
    this.environment = getEnvironment(envKey);
    this.authToken = null;
    this.userInfo = null;
  }

  isAuthenticated(): boolean {
    return this.authToken !== null;
  }

  getAuthInfo(): { authenticated: boolean; user: UserInfo | null } {
    return { authenticated: this.isAuthenticated(), user: this.userInfo };
  }

  // Resolve endpoint path, applying environment overrides if present
  private endpoint(key: keyof typeof ENDPOINTS): string {
    return this.environment.endpointOverrides?.[key] || ENDPOINTS[key];
  }

  private buildRequestInfo(): RequestInfo {
    return {
      apiId: 'Rainmaker',
      ver: '1.0',
      ts: Date.now(),
      msgId: `${Date.now()}|en_IN`,
      authToken: this.authToken || '',
      userInfo: this.userInfo || undefined,
    };
  }

  async login(username: string, password: string, tenantId: string): Promise<void> {
    const formData = new URLSearchParams();
    formData.append('username', username);
    formData.append('password', password);
    formData.append('userType', 'EMPLOYEE');
    formData.append('tenantId', tenantId);
    formData.append('scope', OAUTH_CONFIG.scope);
    formData.append('grant_type', OAUTH_CONFIG.grantType);

    const basicAuth = Buffer.from(
      `${OAUTH_CONFIG.clientId}:${OAUTH_CONFIG.clientSecret}`
    ).toString('base64');

    const response = await fetch(`${this.environment.url}${this.endpoint('AUTH')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        (error as Record<string, string>).error_description ||
        (error as Record<string, string>).message ||
        `Login failed: ${response.status}`
      );
    }

    const data = await response.json() as { access_token: string; UserRequest: UserInfo };
    this.authToken = data.access_token;
    this.userInfo = data.UserRequest;
  }

  private async request<T = unknown>(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.environment.url}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await response.json() as Record<string, unknown>;

    if (!response.ok || (data.Errors as ApiError[] | undefined)?.length) {
      const errors: ApiError[] = (data.Errors as ApiError[]) || [
        {
          code: `HTTP_${response.status}`,
          message: (data.message as string) || `Request failed: ${response.status}`,
        },
      ];
      throw new ApiClientError(errors, response.status);
    }

    return data as T;
  }

  // MDMS v2 Search — returns typed array
  async mdmsV2Search<T = Record<string, unknown>>(
    tenantId: string,
    schemaCode: string,
    options?: { limit?: number; offset?: number; uniqueIdentifiers?: string[] }
  ): Promise<T[]> {
    const data = await this.request<{ mdms?: MdmsRecord[] }>(this.endpoint('MDMS_SEARCH'), {
      RequestInfo: this.buildRequestInfo(),
      MdmsCriteria: {
        tenantId,
        schemaCode,
        limit: options?.limit || 100,
        offset: options?.offset || 0,
        uniqueIdentifiers: options?.uniqueIdentifiers,
      },
    });

    return (data.mdms || []).map((record) => record.data as T);
  }

  // MDMS v2 Search — returns raw MdmsRecord[]
  async mdmsV2SearchRaw(
    tenantId: string,
    schemaCode: string,
    options?: { limit?: number; offset?: number; uniqueIdentifiers?: string[] }
  ): Promise<MdmsRecord[]> {
    const data = await this.request<{ mdms?: MdmsRecord[] }>(this.endpoint('MDMS_SEARCH'), {
      RequestInfo: this.buildRequestInfo(),
      MdmsCriteria: {
        tenantId,
        schemaCode,
        limit: options?.limit || 100,
        offset: options?.offset || 0,
        uniqueIdentifiers: options?.uniqueIdentifiers,
      },
    });

    return data.mdms || [];
  }

  // MDMS v2 Create
  async mdmsV2Create(
    tenantId: string,
    schemaCode: string,
    uniqueIdentifier: string,
    recordData: Record<string, unknown>
  ): Promise<MdmsRecord> {
    const data = await this.request<{ Mdms: MdmsRecord }>(
      `${this.endpoint('MDMS_CREATE')}/${schemaCode}`,
      {
        RequestInfo: this.buildRequestInfo(),
        Mdms: {
          tenantId,
          schemaCode,
          uniqueIdentifier,
          data: recordData,
          isActive: true,
        },
      }
    );

    return data.Mdms;
  }

  // Boundary search
  async boundarySearch(
    tenantId: string,
    hierarchyType?: string,
    options?: { limit?: number; offset?: number }
  ): Promise<Record<string, unknown>[]> {
    const data = await this.request<{ TenantBoundary?: Record<string, unknown>[] }>(
      this.endpoint('BOUNDARY_SEARCH'),
      {
        RequestInfo: this.buildRequestInfo(),
        Boundary: {
          tenantId,
          hierarchyType,
          limit: options?.limit || 100,
          offset: options?.offset || 0,
        },
      }
    );

    return data.TenantBoundary || [];
  }

  // HRMS employee search — criteria as query params
  async employeeSearch(
    tenantId: string,
    options?: { codes?: string[]; departments?: string[]; limit?: number; offset?: number }
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId });
    if (options?.codes?.length) params.append('codes', options.codes.join(','));
    if (options?.departments?.length) params.append('departments', options.departments.join(','));
    params.append('limit', String(options?.limit || 100));
    params.append('offset', String(options?.offset || 0));

    const data = await this.request<{ Employees?: Record<string, unknown>[] }>(
      `${this.endpoint('HRMS_EMPLOYEES_SEARCH')}?${params.toString()}`,
      { RequestInfo: this.buildRequestInfo() }
    );

    return data.Employees || [];
  }

  // Localization search — locale & tenantId are query params
  async localizationSearch(
    tenantId: string,
    locale: string,
    module?: string
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId, locale });
    if (module) params.append('module', module);

    const data = await this.request<{ messages?: Record<string, unknown>[] }>(
      `${this.endpoint('LOCALIZATION_SEARCH')}?${params.toString()}`,
      { RequestInfo: this.buildRequestInfo() }
    );

    return data.messages || [];
  }

  // Localization upsert — tenantId & locale as query params, messages in body
  async localizationUpsert(
    tenantId: string,
    locale: string,
    messages: { code: string; message: string; module: string }[]
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId, locale });

    const data = await this.request<{ messages?: Record<string, unknown>[] }>(
      `${this.endpoint('LOCALIZATION_UPSERT')}?${params.toString()}`,
      {
        RequestInfo: this.buildRequestInfo(),
        messages: messages.map((m) => ({ ...m, locale })),
      }
    );

    return data.messages || [];
  }

  // PGR complaint search — criteria as query params (Spring @ModelAttribute)
  async pgrSearch(
    tenantId: string,
    options?: { serviceRequestId?: string; status?: string; limit?: number; offset?: number }
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId });
    if (options?.serviceRequestId) params.append('serviceRequestId', options.serviceRequestId);
    if (options?.status) params.append('applicationStatus', options.status);
    params.append('limit', String(options?.limit || 50));
    params.append('offset', String(options?.offset || 0));

    const data = await this.request<{ ServiceWrappers?: Record<string, unknown>[] }>(
      `${this.endpoint('PGR_SEARCH')}?${params.toString()}`,
      { RequestInfo: this.buildRequestInfo() }
    );

    return data.ServiceWrappers || [];
  }

  // PGR complaint create
  async pgrCreate(
    tenantId: string,
    serviceCode: string,
    description: string,
    address: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const data = await this.request<{ ServiceWrappers?: Record<string, unknown>[] }>(
      this.endpoint('PGR_CREATE'),
      {
        RequestInfo: this.buildRequestInfo(),
        ServiceWrapper: {
          service: {
            tenantId,
            serviceCode,
            description,
            address,
            source: 'mcp-server',
            active: true,
          },
          workflow: {
            action: 'APPLY',
          },
        },
      }
    );

    return (data.ServiceWrappers || [])[0] || {};
  }

  // PGR complaint update
  async pgrUpdate(
    serviceWrapper: Record<string, unknown>,
    action: string,
    comment?: string
  ): Promise<Record<string, unknown>> {
    const data = await this.request<{ ServiceWrappers?: Record<string, unknown>[] }>(
      this.endpoint('PGR_UPDATE'),
      {
        RequestInfo: this.buildRequestInfo(),
        ServiceWrapper: {
          ...serviceWrapper,
          workflow: {
            action,
            comments: comment,
          },
        },
      }
    );

    return (data.ServiceWrappers || [])[0] || {};
  }

  // Workflow business service search
  async workflowBusinessServiceSearch(
    tenantId: string,
    businessServices?: string[]
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId });
    if (businessServices?.length) {
      params.append('businessServices', businessServices.join(','));
    }

    const data = await this.request<{ BusinessServices?: Record<string, unknown>[] }>(
      `${this.endpoint('WORKFLOW_BUSINESS_SERVICE_SEARCH')}?${params.toString()}`,
      { RequestInfo: this.buildRequestInfo() }
    );

    return data.BusinessServices || [];
  }

  // Workflow process instance search
  async workflowProcessSearch(
    tenantId: string,
    businessIds?: string[],
    options?: { limit?: number; offset?: number }
  ): Promise<Record<string, unknown>[]> {
    const data = await this.request<{ ProcessInstances?: Record<string, unknown>[] }>(
      this.endpoint('WORKFLOW_PROCESS_SEARCH'),
      {
        RequestInfo: this.buildRequestInfo(),
        criteria: {
          tenantId,
          businessIds,
          limit: options?.limit || 50,
          offset: options?.offset || 0,
        },
      }
    );

    return data.ProcessInstances || [];
  }

  // Filestore get URL
  async filestoreGetUrl(
    tenantId: string,
    fileStoreIds: string[]
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId, fileStoreIds: fileStoreIds.join(',') });

    const url = `${this.environment.url}${this.endpoint('FILESTORE_URL')}?${params.toString()}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

    const response = await fetch(url, { method: 'GET', headers });
    const data = await response.json() as Record<string, unknown>;

    return (data.fileStoreIds as Record<string, unknown>[]) || [];
  }

  // Access control roles search — tenantId as query param
  async accessRolesSearch(
    tenantId: string
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId });

    const data = await this.request<{ roles?: Record<string, unknown>[] }>(
      `${this.endpoint('ACCESS_ROLES_SEARCH')}?${params.toString()}`,
      { RequestInfo: this.buildRequestInfo() }
    );

    return data.roles || [];
  }

  // Access control actions search
  async accessActionsSearch(
    tenantId: string,
    roleCodes?: string[]
  ): Promise<Record<string, unknown>[]> {
    const data = await this.request<{ actions?: Record<string, unknown>[] }>(
      this.endpoint('ACCESS_ACTIONS_SEARCH'),
      {
        RequestInfo: this.buildRequestInfo(),
        roleCodes: roleCodes || [],
        tenantId,
      }
    );

    return data.actions || [];
  }

  // ID Generation — generate IDs using configured formats
  async idgenGenerate(
    tenantId: string,
    idRequests: { idName: string; tenantId?: string; format?: string }[]
  ): Promise<{ id: string }[]> {
    const data = await this.request<{ idResponses?: { id: string }[] }>(
      this.endpoint('IDGEN_GENERATE'),
      {
        RequestInfo: this.buildRequestInfo(),
        idRequests: idRequests.map((r) => ({
          idName: r.idName,
          tenantId: r.tenantId || tenantId,
          format: r.format,
        })),
      }
    );

    return data.idResponses || [];
  }

  // Location — search boundaries via egov-location service
  async locationBoundarySearch(
    tenantId: string,
    boundaryType?: string,
    hierarchyType?: string
  ): Promise<Record<string, unknown>[]> {
    const data = await this.request<{ TenantBoundary?: Record<string, unknown>[] }>(
      this.endpoint('LOCATION_BOUNDARY_SEARCH'),
      {
        RequestInfo: this.buildRequestInfo(),
        tenantId,
        boundaryType,
        hierarchyType,
      }
    );

    return data.TenantBoundary || [];
  }

  // Encryption — encrypt values (no RequestInfo needed)
  async encryptData(
    tenantId: string,
    values: string[]
  ): Promise<string[]> {
    const data = await this.request<string[]>(
      this.endpoint('ENC_ENCRYPT'),
      {
        encryptionRequests: values.map((value) => ({
          tenantId,
          type: 'Normal',
          value,
        })),
      }
    );

    // The response is a flat array of encrypted strings
    return Array.isArray(data) ? data : [];
  }

  // Decryption — decrypt encrypted values (no RequestInfo needed)
  async decryptData(
    tenantId: string,
    encryptedValues: string[]
  ): Promise<string[]> {
    const data = await this.request<string[]>(
      this.endpoint('ENC_DECRYPT'),
      {
        decryptionRequests: encryptedValues.map((value) => ({
          tenantId,
          type: 'Normal',
          value,
        })),
      }
    );

    return Array.isArray(data) ? data : [];
  }

  // Boundary Management — process (upload/update boundary data)
  async boundaryMgmtProcess(
    tenantId: string,
    resourceDetails: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ tenantId });
    const data = await this.request<Record<string, unknown>>(
      `${this.endpoint('BNDRY_MGMT_PROCESS')}?${params.toString()}`,
      {
        RequestInfo: this.buildRequestInfo(),
        ResourceDetails: resourceDetails,
      }
    );

    return data;
  }

  // Boundary Management — search processed boundaries
  async boundaryMgmtSearch(
    tenantId: string
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId });
    const data = await this.request<{ ResourceDetails?: Record<string, unknown>[] }>(
      `${this.endpoint('BNDRY_MGMT_PROCESS_SEARCH')}?${params.toString()}`,
      {
        RequestInfo: this.buildRequestInfo(),
      }
    );

    return data.ResourceDetails || [];
  }

  // Boundary Management — generate boundary codes
  async boundaryMgmtGenerate(
    tenantId: string,
    resourceDetails: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ tenantId });
    const data = await this.request<Record<string, unknown>>(
      `${this.endpoint('BNDRY_MGMT_GENERATE')}?${params.toString()}`,
      {
        RequestInfo: this.buildRequestInfo(),
        ResourceDetails: resourceDetails,
      }
    );

    return data;
  }

  // Boundary Management — download/search generated boundaries
  async boundaryMgmtDownload(
    tenantId: string
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ tenantId });
    const data = await this.request<{ ResourceDetails?: Record<string, unknown>[] }>(
      `${this.endpoint('BNDRY_MGMT_GENERATE_SEARCH')}?${params.toString()}`,
      {
        RequestInfo: this.buildRequestInfo(),
      }
    );

    return data.ResourceDetails || [];
  }
}

// Singleton
export const digitApi = new DigitApiClient();
