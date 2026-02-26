import {
  DriftedResource,
  InteractiveDecisions,
  PlanDecision,
  PlanMetadata,
  RemediationPlan,
} from './types';

const VALID_ACTIONS = new Set(['autofix', 'reimport', 'remove', 'skip']);

/**
 * Build a RemediationPlan from drift detection results and interactive decisions.
 */
export function buildPlan(
  metadata: PlanMetadata,
  decisions: InteractiveDecisions,
): RemediationPlan {
  const planDecisions: PlanDecision[] = [];
  const resources: Record<string, DriftedResource> = {};

  for (const r of decisions.autofix) {
    planDecisions.push({
      logicalResourceId: r.logicalResourceId,
      resourceType: r.resourceType,
      driftStatus: r.stackResourceDriftStatus,
      physicalResourceId: r.physicalResourceId,
      action: 'autofix',
    });
    resources[r.logicalResourceId] = r;
  }

  for (const { resource, physicalId } of decisions.reimport) {
    planDecisions.push({
      logicalResourceId: resource.logicalResourceId,
      resourceType: resource.resourceType,
      driftStatus: resource.stackResourceDriftStatus,
      physicalResourceId: resource.physicalResourceId,
      action: 'reimport',
      reimportPhysicalId: physicalId,
    });
    resources[resource.logicalResourceId] = resource;
  }

  for (const r of decisions.remove) {
    planDecisions.push({
      logicalResourceId: r.logicalResourceId,
      resourceType: r.resourceType,
      driftStatus: r.stackResourceDriftStatus,
      physicalResourceId: r.physicalResourceId,
      action: 'remove',
    });
    resources[r.logicalResourceId] = r;
  }

  for (const r of decisions.skip) {
    planDecisions.push({
      logicalResourceId: r.logicalResourceId,
      resourceType: r.resourceType,
      driftStatus: r.stackResourceDriftStatus,
      physicalResourceId: r.physicalResourceId,
      action: 'skip',
    });
    resources[r.logicalResourceId] = r;
  }

  return {
    version: 1,
    metadata,
    decisions: planDecisions,
    _resources: resources,
  };
}

/**
 * Serialize a plan to formatted JSON.
 */
export function serializePlan(plan: RemediationPlan): string {
  return JSON.stringify(plan, null, 2);
}

/**
 * Load and validate a plan from a JSON string.
 * Throws descriptive errors on validation failures.
 */
export function loadPlan(json: string, expectedStackName: string): RemediationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid plan file: not valid JSON');
  }

  const plan = parsed as Record<string, unknown>;

  if (plan.version !== 1) {
    throw new Error(
      `Unsupported plan version: ${plan.version}. This tool supports version 1.`,
    );
  }

  const metadata = plan.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('Invalid plan file: missing metadata');
  }

  if (metadata.stackName !== expectedStackName) {
    throw new Error(
      `Plan stack name "${metadata.stackName}" does not match target stack "${expectedStackName}"`,
    );
  }

  if (!Array.isArray(plan.decisions)) {
    throw new Error('Invalid plan file: decisions must be an array');
  }

  for (const decision of plan.decisions as PlanDecision[]) {
    if (!decision.logicalResourceId || !decision.action) {
      throw new Error(
        `Invalid plan decision: missing logicalResourceId or action in ${JSON.stringify(decision)}`,
      );
    }
    if (!VALID_ACTIONS.has(decision.action)) {
      throw new Error(
        `Invalid action "${decision.action}" for resource ${decision.logicalResourceId}. ` +
        `Valid actions: ${[...VALID_ACTIONS].join(', ')}`,
      );
    }
    if (decision.action === 'reimport' && !decision.reimportPhysicalId) {
      throw new Error(
        `Resource ${decision.logicalResourceId} has action "reimport" but no reimportPhysicalId`,
      );
    }
  }

  const resources = plan._resources as Record<string, DriftedResource> | undefined;
  if (!resources || typeof resources !== 'object') {
    throw new Error('Invalid plan file: missing _resources');
  }

  return plan as unknown as RemediationPlan;
}

/**
 * Convert a loaded plan back into InteractiveDecisions and resource arrays.
 */
export function planToDecisions(plan: RemediationPlan): {
  allDriftedResources: DriftedResource[];
  decisions: InteractiveDecisions;
} {
  const decisions: InteractiveDecisions = {
    autofix: [],
    reimport: [],
    remove: [],
    skip: [],
  };

  const seenIds = new Set<string>();

  for (const d of plan.decisions) {
    const resource = plan._resources[d.logicalResourceId];
    if (!resource) {
      throw new Error(
        `Resource "${d.logicalResourceId}" in decisions not found in plan _resources`,
      );
    }
    seenIds.add(d.logicalResourceId);

    switch (d.action) {
      case 'autofix':
        decisions.autofix.push(resource);
        break;
      case 'reimport':
        decisions.reimport.push({ resource, physicalId: d.reimportPhysicalId! });
        break;
      case 'remove':
        decisions.remove.push(resource);
        break;
      case 'skip':
        decisions.skip.push(resource);
        break;
    }
  }

  // Resources in _resources but not in decisions are treated as skip
  for (const [logicalId, resource] of Object.entries(plan._resources)) {
    if (!seenIds.has(logicalId)) {
      decisions.skip.push(resource);
    }
  }

  const allDriftedResources = Object.values(plan._resources);

  return { allDriftedResources, decisions };
}
