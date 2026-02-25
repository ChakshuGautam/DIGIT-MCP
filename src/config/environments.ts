import type { Environment } from '../types/index.js';
import { ENDPOINTS } from './endpoints.js';

export const ENVIRONMENTS: Record<string, Environment> = {
  'chakshu-digit': {
    name: 'Chakshu Dev',
    url: process.env.CRS_API_URL || 'https://api.egov.theflywheel.in',
    stateTenantId: process.env.CRS_STATE_TENANT || 'pg',
    description: 'Chakshu development environment',
    endpointOverrides: {
      MDMS_SEARCH: '/mdms-v2/v2/_search',
      MDMS_CREATE: '/mdms-v2/v2/_create',
      MDMS_UPDATE: '/mdms-v2/v2/_update',
    },
  },
};

const VALID_ENDPOINT_KEYS = new Set(Object.keys(ENDPOINTS));

export function getEnvironment(envKey?: string): Environment {
  const key = envKey || process.env.CRS_ENVIRONMENT || 'chakshu-digit';
  const env = ENVIRONMENTS[key];
  if (!env) {
    throw new Error(
      `Unknown environment: ${key}. Available: ${Object.keys(ENVIRONMENTS).join(', ')}`
    );
  }

  // Validate endpoint override keys at load time to catch typos early
  if (env.endpointOverrides) {
    for (const overrideKey of Object.keys(env.endpointOverrides)) {
      if (!VALID_ENDPOINT_KEYS.has(overrideKey)) {
        throw new Error(
          `Invalid endpoint override key "${overrideKey}" in environment "${key}". ` +
          `Valid keys: ${[...VALID_ENDPOINT_KEYS].join(', ')}`
        );
      }
    }
  }

  return env;
}
