export type SurfaceName =
  | 'mdms-schemas'
  | 'mdms-data'
  | 'localization'
  | 'workflow'
  | 'boundary'
  | 'access-control';

export const ALL_SURFACES: SurfaceName[] = [
  'mdms-schemas',
  'mdms-data',
  'localization',
  'workflow',
  'boundary',
  'access-control',
];

export type IncludeScope = 'self' | 'root' | 'children';

export type ConflictPolicy = 'skip' | 'overwrite' | 'fail';

export interface Manifest {
  version: string;
  tenant_id: string;
  include: IncludeScope[];
  created_at: string;
  created_by: string;
  source_env: string;
  surfaces: SurfaceName[];
  counts: Record<SurfaceName, number>;
  sha256: string;
  schema_version: 1;
}

export interface DumpOpts {
  tenantIds: string[];
  include: IncludeScope[];
}

export interface RestoreOpts {
  onConflict: ConflictPolicy;
  dryRun: boolean;
}

export interface SurfaceReport {
  surface: SurfaceName;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ identifier: string; message: string }>;
  abortedAt?: { identifier: string };
}

export interface ApplyReport {
  ok: boolean;
  partial: boolean;
  surfaces: SurfaceReport[];
  totals: { created: number; updated: number; skipped: number; failed: number };
  warning?: string;
  error?: string;
}

export interface RegistryRow {
  tenant_id: string;
  version: string;
  filestore_id: string;
  created_at: string;
  size_bytes: number;
  sha256: string;
  surfaces: SurfaceName[];
  include: IncludeScope[];
}
