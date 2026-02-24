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
  /** Enable verbose output */
  verbose?: boolean;
}

/**
 * Result of the remediation process
 */
export interface RemediationResult {
  /** Whether remediation was successful */
  success: boolean;
  /** List of resource logical IDs that were remediated */
  remediatedResources: string[];
  /** List of resource logical IDs that were skipped (not importable) */
  skippedResources: string[];
  /** Error messages if any */
  errors: string[];
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
}
