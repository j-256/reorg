export const PLAN_EXPORT_FORMAT = 'reorg-plan';
export const PLAN_EXPORT_VERSION = 1;
export const PLAN_EXPORT_FILENAME = 'reorg-plan.json';

export function createPlanExport(scan, plan, view = null) {
  if (!scan || !Array.isArray(scan.nodes) || typeof scan.root !== 'string') {
    throw new Error('Cannot export a plan without its source scan');
  }
  return {
    format: PLAN_EXPORT_FORMAT,
    version: PLAN_EXPORT_VERSION,
    root: scan.root,
    scannedAt: scan.generated || null,
    scan,
    plan,
    ...(view ? { view } : {}),
  };
}

export function parsePlanExport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plan input must be a JSON object');
  }

  if (value.format === undefined) {
    return { sourceRoot: null, scan: null, plan: value };
  }
  if (value.format !== PLAN_EXPORT_FORMAT) {
    throw new Error(`Unsupported plan format: ${String(value.format)}`);
  }
  if (value.version !== PLAN_EXPORT_VERSION) {
    throw new Error(`Unsupported ${PLAN_EXPORT_FORMAT} version: ${String(value.version)}`);
  }
  if (!value.scan || !Array.isArray(value.scan.nodes) || typeof value.scan.root !== 'string') {
    throw new Error('Exported plan is missing its source scan');
  }
  if (!value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan)) {
    throw new Error('Exported plan is missing its plan data');
  }
  if (typeof value.root !== 'string' || value.root !== value.scan.root) {
    throw new Error('Exported plan root does not match its source scan');
  }
  if (value.view != null && (typeof value.view !== 'object' || Array.isArray(value.view))) {
    throw new Error('Exported plan view must be an object');
  }

  return {
    sourceRoot: value.root,
    scan: value.scan,
    plan: value.plan,
    view: value.view || null,
  };
}
