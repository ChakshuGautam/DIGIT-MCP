import type { Environment } from '../types/index.js';

export const ENVIRONMENTS: Record<string, Environment> = {
  'chakshu-digit': {
    name: 'Chakshu Dev',
    url: 'https://api.egov.theflywheel.in',
    stateTenantId: 'pg',
    description: 'Chakshu development environment (Flywheel)',
    endpointOverrides: {
      MDMS_SEARCH: '/mdms-v2/v2/_search',
      MDMS_CREATE: '/mdms-v2/v2/_create',
      MDMS_UPDATE: '/mdms-v2/v2/_update',
    },
  },
};

export function getEnvironment(envKey?: string): Environment {
  const key = envKey || process.env.CRS_ENVIRONMENT || 'chakshu-digit';
  const env = ENVIRONMENTS[key];
  if (!env) {
    throw new Error(
      `Unknown environment: ${key}. Available: ${Object.keys(ENVIRONMENTS).join(', ')}`
    );
  }
  return env;
}
