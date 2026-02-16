import type { Environment } from '../types/index.js';

export const ENVIRONMENTS: Record<string, Environment> = {
  'chakshu-digit': {
    name: 'Chakshu Dev',
    url: 'https://chakshu-digit.egov.theflywheel.in',
    stateTenantId: 'statea',
    description: 'Chakshu development environment (Flywheel)',
  },
  dev: {
    name: 'Unified Dev',
    url: 'https://unified-dev.digit.org',
    stateTenantId: 'statea',
    description: 'DIGIT unified development environment',
  },
  local: {
    name: 'Local',
    url: 'http://0.0.0.0:18000',
    stateTenantId: 'pg',
    description: 'Local Docker compose (Kong gateway on port 18000)',
    endpointOverrides: {
      MDMS_SEARCH: '/mdms-v2/v2/_search',
      MDMS_CREATE: '/mdms-v2/v2/_create',
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
