import { isResourceImportable, getImportProperties } from './eligible-resources';
import { buildIdentifierFromPhysicalId } from './resource-identifier';
import { DriftedResource, ResourceToImport } from './types';

export interface BuildImportResult {
  /** Resources that can be imported */
  importable: ResourceToImport[];
  /** Resources that were skipped (not importable) */
  skipped: DriftedResource[];
}

/**
 * Build the list of resources to import from drifted resources.
 *
 * For each drifted resource, we need to determine the resource identifier
 * properties required for import. These can come from:
 * 1. The PhysicalResourceIdContext (for multi-key identifiers)
 * 2. The PhysicalResourceId (for single-key identifiers)
 * 3. The actual properties of the resource
 *
 * @param driftedResources - List of drifted resources to process
 * @param dynamicIdentifiers - Optional map of resource type to identifier properties from GetTemplateSummary
 */
export function buildResourcesToImport(
  driftedResources: DriftedResource[],
  dynamicIdentifiers?: Map<string, string[]>,
): BuildImportResult {
  const importable: ResourceToImport[] = [];
  const skipped: DriftedResource[] = [];

  for (const resource of driftedResources) {
    // Check if resource type supports import
    if (!isResourceImportable(resource.resourceType)) {
      skipped.push(resource);
      continue;
    }

    // Get identifier properties (prefer dynamic from API, fall back to static list)
    let identifierProps =
      dynamicIdentifiers?.get(resource.resourceType) || getImportProperties(resource.resourceType);

    if (identifierProps.length === 0) {
      skipped.push(resource);
      continue;
    }

    // Build resource identifier
    const resourceIdentifier = buildResourceIdentifier(resource, identifierProps);

    if (Object.keys(resourceIdentifier).length === 0) {
      skipped.push(resource);
      continue;
    }

    importable.push({
      ResourceType: resource.resourceType,
      LogicalResourceId: resource.logicalResourceId,
      ResourceIdentifier: resourceIdentifier,
    });
  }

  return { importable, skipped };
}

/**
 * Build the resource identifier map for a single drifted resource
 */
function buildResourceIdentifier(
  resource: DriftedResource,
  identifierProps: string[],
): Record<string, string> {
  const resourceIdentifier: Record<string, string> = {};

  // First, try to get values from PhysicalResourceIdContext
  // This contains multi-part identifiers
  const contextMap = new Map<string, string>();
  if (resource.physicalResourceIdContext) {
    for (const ctx of resource.physicalResourceIdContext) {
      contextMap.set(ctx.key, ctx.value);
    }
  }

  const remainingProps = [...identifierProps];

  // Try to fill from context
  for (const prop of identifierProps) {
    if (contextMap.has(prop)) {
      resourceIdentifier[prop] = contextMap.get(prop)!;
      const idx = remainingProps.indexOf(prop);
      if (idx > -1) remainingProps.splice(idx, 1);
    }
  }

  // Try to fill from actual properties
  if (resource.actualProperties) {
    for (const prop of remainingProps.slice()) {
      const value = resource.actualProperties[prop];
      if (value !== undefined && value !== null) {
        resourceIdentifier[prop] = String(value);
        const idx = remainingProps.indexOf(prop);
        if (idx > -1) remainingProps.splice(idx, 1);
      }
    }
  }

  // If we still have exactly one remaining property and we have a physical resource ID,
  // use that as the value (common case for single-identifier resources)
  if (remainingProps.length === 1 && resource.physicalResourceId) {
    resourceIdentifier[remainingProps[0]] = resource.physicalResourceId;
    remainingProps.splice(0, 1);
  }

  // Handle special cases for specific resource types
  if (remainingProps.length > 0) {
    fillSpecialCases(resource, resourceIdentifier, remainingProps);
  }

  return resourceIdentifier;
}

/**
 * Handle special cases for specific resource types where the identifier
 * property name doesn't match the physical resource ID format
 */
function fillSpecialCases(
  resource: DriftedResource,
  identifier: Record<string, string>,
  remainingProps: string[],
): void {
  const { resourceType, physicalResourceId, actualProperties } = resource;

  switch (resourceType) {
    case 'AWS::S3::Bucket':
      // Physical resource ID is the bucket name
      if (remainingProps.includes('BucketName') && physicalResourceId) {
        identifier.BucketName = physicalResourceId;
      }
      break;

    case 'AWS::SQS::Queue':
      // Physical resource ID is the queue URL
      if (remainingProps.includes('QueueUrl') && physicalResourceId) {
        identifier.QueueUrl = physicalResourceId;
      }
      break;

    case 'AWS::SNS::Topic':
      // Physical resource ID is the topic ARN
      if (remainingProps.includes('TopicArn') && physicalResourceId) {
        identifier.TopicArn = physicalResourceId;
      }
      break;

    case 'AWS::Lambda::Function':
      // Physical resource ID is the function name
      if (remainingProps.includes('FunctionName') && physicalResourceId) {
        identifier.FunctionName = physicalResourceId;
      }
      break;

    case 'AWS::DynamoDB::Table':
      // Physical resource ID is the table name
      if (remainingProps.includes('TableName') && physicalResourceId) {
        identifier.TableName = physicalResourceId;
      }
      break;

    case 'AWS::EC2::SecurityGroup':
      // Physical resource ID is the group ID
      if (remainingProps.includes('GroupId') && physicalResourceId) {
        identifier.GroupId = physicalResourceId;
      }
      break;

    case 'AWS::Logs::LogGroup':
      // Physical resource ID is the log group name
      if (remainingProps.includes('LogGroupName') && physicalResourceId) {
        identifier.LogGroupName = physicalResourceId;
      }
      break;

    case 'AWS::IAM::Role':
      // Physical resource ID is the role name
      if (remainingProps.includes('RoleName') && physicalResourceId) {
        identifier.RoleName = physicalResourceId;
      }
      break;

    case 'AWS::ECS::Cluster':
      // Physical resource ID is the cluster name
      if (remainingProps.includes('ClusterName') && physicalResourceId) {
        identifier.ClusterName = physicalResourceId;
      }
      break;

    case 'AWS::ECS::Service':
      // Physical resource ID is the service ARN, need cluster from context/properties
      if (remainingProps.includes('ServiceArn') && physicalResourceId) {
        identifier.ServiceArn = physicalResourceId;
      }
      if (remainingProps.includes('Cluster') && actualProperties?.Cluster) {
        identifier.Cluster = String(actualProperties.Cluster);
      }
      break;

    default:
      // No special handling needed
      break;
  }
}

/**
 * Build a ResourceToImport from a user-provided physical ID for a DELETED resource.
 * Uses resource-identifier.ts for ARN parsing and identifier extraction.
 *
 * For deleted resources being re-imported, the original template properties are used
 * (since we cannot describe the actual state of a resource that was deleted from the stack).
 *
 * @param resource - The deleted DriftedResource
 * @param userProvidedPhysicalId - ARN, name, or ID entered by the user
 * @param dynamicIdentifiers - Optional identifier properties from GetTemplateSummary
 * @returns ResourceToImport or null if identifier cannot be determined
 */
export function buildReimportDescriptor(
  resource: DriftedResource,
  userProvidedPhysicalId: string,
  dynamicIdentifiers?: Map<string, string[]>,
): ResourceToImport | null {
  const identifier = buildIdentifierFromPhysicalId(resource.resourceType, userProvidedPhysicalId);
  if (!identifier) return null;

  // Validate all required properties are present
  const requiredProps = dynamicIdentifiers?.get(resource.resourceType)
    || getImportProperties(resource.resourceType);
  const allPresent = requiredProps.every((prop) => prop in identifier);
  if (!allPresent) return null;

  return {
    ResourceType: resource.resourceType,
    LogicalResourceId: resource.logicalResourceId,
    ResourceIdentifier: identifier,
  };
}

/**
 * Validate that all required identifier properties are present
 */
export function validateResourceIdentifier(
  resourceType: string,
  identifier: Record<string, string>,
): boolean {
  const requiredProps = getImportProperties(resourceType);

  for (const prop of requiredProps) {
    if (!identifier[prop]) {
      return false;
    }
  }

  return true;
}
