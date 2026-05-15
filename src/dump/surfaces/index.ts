import { mdmsSchemasSurface } from './mdmsSchemas.js';
import { mdmsDataSurface } from './mdmsData.js';
import { localizationSurface } from './localization.js';
import { workflowSurface } from './workflow.js';
import { boundarySurface } from './boundary.js';
import { accessControlSurface } from './accessControl.js';
import type { SurfaceName } from '../types.js';

// Each surface module declares its own private `Client` interface, so we keep
// SURFACE_REGISTRY's value type opaque to the type system. Consumers index by
// SurfaceName and call .name / .dump / .restore — the engine wires in a
// concrete client that satisfies every surface's structural contract.
export const SURFACE_REGISTRY: Record<SurfaceName, unknown> = {
  'mdms-schemas': mdmsSchemasSurface,
  'mdms-data':    mdmsDataSurface,
  'localization': localizationSurface,
  'workflow':     workflowSurface,
  'boundary':     boundarySurface,
  'access-control': accessControlSurface,
};

// Restore order — dependencies first
export const RESTORE_ORDER: SurfaceName[] = [
  'mdms-schemas',
  'mdms-data',
  'localization',
  'workflow',
  'boundary',
  'access-control',
];
