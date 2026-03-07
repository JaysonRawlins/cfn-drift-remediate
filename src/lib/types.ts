/**
 * Enumeration of remediation steps that mutate the stack (Steps 6-10).
 * Values match the step numbers in the remediation process.
 */
export enum RemediationStep {
  RETAIN_AND_REMOVE_DELETED = 6,
  RESOLVE_REFERENCES = 7,
  REMOVE_MODIFIED = 8,
  IMPORT_RESOURCES = 9,
  RESTORE_TEMPLATE = 10,
}

export const STEP_DESCRIPTIONS: Record<RemediationStep, string> = {
  [RemediationStep.RETAIN_AND_REMOVE_DELETED]: 'Step 6: Set DeletionPolicy:Retain and remove DELETED resources',
  [RemediationStep.RESOLVE_REFERENCES]: 'Step 7: Resolve cross-references to drifted resources',
  [RemediationStep.REMOVE_MODIFIED]: 'Step 8: Remove drifted resources from template',
  [RemediationStep.IMPORT_RESOURCES]: 'Step 9: Import resources via change set',
  [RemediationStep.RESTORE_TEMPLATE]: 'Step 10: Restore original template',
};

export const STEP_STATE_AFTER_FAILURE: Record<RemediationStep, string> = {
  [RemediationStep.RETAIN_AND_REMOVE_DELETED]: 'Stack resources may have DeletionPolicy:Retain. DELETED resources may or may not be removed.',
  [RemediationStep.RESOLVE_REFERENCES]: 'All resources have DeletionPolicy:Retain. DELETED resources removed. Temporary resolution Outputs may be present.',
  [RemediationStep.REMOVE_MODIFIED]: 'All resources have DeletionPolicy:Retain. DELETED resources removed. MODIFIED resources may or may not be removed.',
  [RemediationStep.IMPORT_RESOURCES]: 'Drifted resources removed from stack but still exist in AWS (Retain). Import may be partially complete.',
  [RemediationStep.RESTORE_TEMPLATE]: 'Resources imported successfully. Template still has DeletionPolicy:Retain set.',
};

/**
 * Structured error from a failed remediation step, including recovery guidance.
 */
export interface StepError {
  step: RemediationStep;
  message: string;
  stackState: string;
  guidance: string[];
}

/**
 * Warning about a resource type that may not support CloudControl read operations.
 */
export interface PreflightWarning {
  resourceType: string;
  reason: string;
}

/**
 * Represents a drifted CloudFormation resource
 */
export interface DriftedResource {
  /** Logical resource ID in the CloudFormation template */
  logicalResourceId: string;
  /** AWS resource type (e.g., AWS::S3::Bucket) */
  resourceType: string;
  /** Physical resource ID (e.g., bucket name, instance ID) */
  physicalResourceId: string;
  /** Drift status - MODIFIED means properties changed, DELETED means resource was removed */
  stackResourceDriftStatus: 'MODIFIED' | 'DELETED';
  /** List of property differences if available */
  propertyDifferences?: PropertyDifference[];
  /** Actual properties of the resource as it exists in AWS */
  actualProperties?: Record<string, unknown>;
  /** Expected properties according to the CloudFormation template */
  expectedProperties?: Record<string, unknown>;
  /** Context for physical resource identification */
  physicalResourceIdContext?: PhysicalResourceIdContext[];
}

/**
 * Context information for identifying a physical resource
 */
export interface PhysicalResourceIdContext {
  key: string;
  value: string;
}

/**
 * Represents a difference in a resource property
 */
export interface PropertyDifference {
  /** JSONPath to the property that differs */
  propertyPath: string;
  /** Expected value according to CloudFormation template */
  expectedValue: string;
  /** Actual value in AWS */
  actualValue: string;
  /** Type of difference */
  differenceType: 'ADD' | 'REMOVE' | 'NOT_EQUAL';
}

/**
 * Resource to import back into CloudFormation
 */
export interface ResourceToImport {
  /** AWS resource type */
  ResourceType: string;
  /** Logical resource ID in the template */
  LogicalResourceId: string;
  /** Map of identifier property names to values */
  ResourceIdentifier: Record<string, string>;
}

/**
 * Action the user chose for a single drifted resource
 */
export type ResourceAction =
  | { kind: 'autofix' }
  | { kind: 'skip' }
  | { kind: 'remove' }
  | { kind: 'reimport'; physicalId: string };

/**
 * Structured result of the interactive prompting phase.
 * Partitions user decisions into groups for the orchestrator.
 */
export interface InteractiveDecisions {
  /** MODIFIED resources to autofix (remove + reimport with actual state) */
  autofix: DriftedResource[];
  /** DELETED resources to reimport with user-provided physical IDs */
  reimport: Array<{ resource: DriftedResource; physicalId: string }>;
  /** Resources to permanently remove from stack (retain in AWS) */
  remove: DriftedResource[];
  /** Resources the user chose to skip entirely */
  skip: DriftedResource[];
}

/**
 * Options for the remediation process
 */
export interface RemediationOptions {
  /** Name of the CloudFormation stack */
  stackName: string;
  /** AWS region */
  region?: string;
  /** AWS profile to use */
  profile?: string;
  /** If true, only show what would be done without making changes */
  dryRun?: boolean;
  /** Skip interactive prompts; accept default action for every resource */
  yes?: boolean;
  /** Enable verbose output */
  verbose?: boolean;
  /** File path to export the remediation plan to (exits without executing) */
  exportPlan?: string;
  /** File path to load and apply a previously exported remediation plan */
  applyPlan?: string;
  /** S3 bucket for uploading large templates (auto-detects CDK bootstrap bucket if omitted) */
  s3Bucket?: string;
  /** Path to checkpoint file for resuming a previously failed remediation */
  resume?: string;
}

/**
 * A drifted resource that cannot be imported via CloudFormation.
 * MODIFIED resources are report-only; DELETED resources are auto-removed.
 */
export interface NonImportableResource {
  logicalResourceId: string;
  resourceType: string;
  physicalResourceId: string;
  driftStatus: 'MODIFIED' | 'DELETED';
  propertyDifferences?: PropertyDifference[];
}

/**
 * Result of the remediation process
 */
export interface RemediationResult {
  /** Whether remediation was successful */
  success: boolean;
  /** List of resource logical IDs that were remediated (autofix + reimport) */
  remediatedResources: string[];
  /** List of resource logical IDs that were skipped */
  skippedResources: string[];
  /** List of resource logical IDs permanently removed from the stack */
  removedResources: string[];
  /** Non-importable drifted resources reported for manual action */
  nonImportableResources: NonImportableResource[];
  /** Error messages if any */
  errors: string[];
  /** Structured error with recovery guidance when a step fails */
  stepError?: StepError;
}

/**
 * CloudFormation template structure
 */
export interface CloudFormationTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Metadata?: Record<string, unknown>;
  Parameters?: Record<string, unknown>;
  Mappings?: Record<string, unknown>;
  Conditions?: Record<string, unknown>;
  Transform?: string | string[];
  Resources: Record<string, CloudFormationResource>;
  Outputs?: Record<string, unknown>;
}

/**
 * CloudFormation resource definition
 */
export interface CloudFormationResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  Condition?: string;
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate';
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot';
  Metadata?: Record<string, unknown>;
}

/**
 * Result of transforming a template for drift remediation
 */
export interface TransformResult {
  /** The transformed template */
  template: CloudFormationTemplate;
  /** List of logical IDs that were removed */
  removedResources: string[];
  /** Map of resolved reference values */
  resolvedReferences: Map<string, unknown>;
}

/**
 * Recovery checkpoint saved before stack mutations for manual recovery
 */
export interface RecoveryCheckpoint {
  /** Stack name */
  stackName: string;
  /** Stack ARN */
  stackId: string;
  /** Original template body (before any mutations) */
  originalTemplateBody: string;
  /** Stack parameters */
  parameters: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  /** Logical IDs of drifted resources being remediated */
  driftedResourceIds: string[];
  /** ISO timestamp when checkpoint was created */
  timestamp: string;

  // Resume fields (v2)
  /** Checkpoint format version — v2 supports resume */
  checkpointVersion?: 2;
  /** Last step that completed successfully */
  lastCompletedStep?: RemediationStep;
  /** Template body after Step 6 (Retain + DELETED removal) */
  retainTemplateBody?: string;
  /** JSON.stringify([...resolvedValues.entries()]) after Step 7 */
  resolvedValuesJson?: string;
  /** Template body after Step 8 (MODIFIED removal) */
  removalTemplateBody?: string;
  /** True after Step 9 import completes */
  importComplete?: boolean;
  /** Capabilities used for stack operations */
  capabilities?: string[];
  /** Serialized InteractiveDecisions for resume */
  decisionsJson?: string;
  /** Serialized ResourceToImport[] for resume */
  resourcesToImportJson?: string;
  /** File path where this checkpoint is saved */
  checkpointPath?: string;
}

/**
 * Describes a resource that will be cascade-removed because it has
 * unresolvable references to a removed resource.
 */
export interface CascadeRemoval {
  /** Logical ID of the resource that will be cascade-removed */
  logicalResourceId: string;
  /** AWS resource type of the cascade-removed resource */
  resourceType: string;
  /** Logical ID of the removed resource that this one depends on */
  dependsOn: string;
}

/**
 * Metadata about when and where a remediation plan was created
 */
export interface PlanMetadata {
  stackName: string;
  region: string;
  createdAt: string;
  toolVersion: string;
  driftDetectionId: string;
}

/**
 * A single resource decision in a remediation plan (human-readable/editable)
 */
export interface PlanDecision {
  logicalResourceId: string;
  resourceType: string;
  driftStatus: 'MODIFIED' | 'DELETED';
  physicalResourceId: string;
  action: 'autofix' | 'reimport' | 'remove' | 'skip' | 'report_only';
  /** Only present when action is 'reimport' */
  reimportPhysicalId?: string;
}

/**
 * Serializable remediation plan for export/import workflow
 */
export interface RemediationPlan {
  version: 1;
  metadata: PlanMetadata;
  /** Human-readable/editable list of resource decisions */
  decisions: PlanDecision[];
  /** Internal resource data needed to execute the plan (do not edit) */
  _resources: Record<string, DriftedResource>;
}
