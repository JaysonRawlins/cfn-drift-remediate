import * as yaml from 'yaml-cfn';
import { CloudFormationTemplate, TransformResult } from './types';
import { deepClone } from './utils';

/**
 * CloudFormation pseudo-references that should never be resolved
 */
const CFN_PSEUDO_REFS = new Set([
  'AWS::AccountId',
  'AWS::NotificationARNs',
  'AWS::NoValue',
  'AWS::Partition',
  'AWS::Region',
  'AWS::StackId',
  'AWS::StackName',
  'AWS::URLSuffix',
]);

/**
 * Regex for parsing ${Variable} references in Fn::Sub template strings
 */
const SUB_VARIABLE_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Placeholder template used when all resources are removed
 */
const EMPTY_TEMPLATE: CloudFormationTemplate = {
  Conditions: {
    FalseCondition: {
      'Fn::Equals': [1, 2],
    },
  },
  Resources: {
    PlaceholderResource: {
      Condition: 'FalseCondition',
      Type: 'AWS::S3::Bucket',
    },
  },
};

/**
 * Resolves property values, replacing Ref/GetAtt references to drifted resources
 * with their actual resolved values.
 *
 * @param value - The property value to resolve
 * @param driftedLogicalIds - Set of logical IDs that are drifted
 * @param resolvedValues - Map of resolved reference values
 * @param collectMode - If true, collect references instead of replacing them
 * @returns The resolved value, or the original if not resolvable
 */
export function resolvePropertyValue(
  value: unknown,
  driftedLogicalIds: Set<string>,
  resolvedValues: Map<string, unknown>,
  collectMode: boolean = false,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle primitives
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) =>
      resolvePropertyValue(item, driftedLogicalIds, resolvedValues, collectMode),
    );
  }

  // Handle objects
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Handle Ref
    if ('Ref' in obj && typeof obj.Ref === 'string') {
      const refTarget = obj.Ref;
      if (driftedLogicalIds.has(refTarget)) {
        const key = `Ref:${refTarget}`;
        if (collectMode) {
          // Collect the reference for later resolution
          resolvedValues.set(key, { Ref: refTarget });
          return obj;
        } else if (resolvedValues.has(key)) {
          // Replace with resolved value
          return resolvedValues.get(key);
        }
      }
      return obj;
    }

    // Handle Fn::GetAtt (array form: ['LogicalId', 'Attribute'])
    if ('Fn::GetAtt' in obj) {
      const getAtt = obj['Fn::GetAtt'];
      let logicalId: string;
      let attributeName: string;

      if (Array.isArray(getAtt) && getAtt.length === 2) {
        [logicalId, attributeName] = getAtt as [string, string];
      } else if (typeof getAtt === 'string') {
        // Handle string form: 'LogicalId.Attribute'
        const parts = getAtt.split('.');
        logicalId = parts[0];
        attributeName = parts.slice(1).join('.');
      } else {
        return obj;
      }

      if (driftedLogicalIds.has(logicalId)) {
        const key = `GetAtt:${logicalId}:${attributeName}`;
        if (collectMode) {
          resolvedValues.set(key, { 'Fn::GetAtt': [logicalId, attributeName] });
          return obj;
        } else if (resolvedValues.has(key)) {
          return resolvedValues.get(key);
        }
      }
      return obj;
    }

    // Handle Fn::Sub - contains embedded ${Variable} references
    if ('Fn::Sub' in obj) {
      const subValue = obj['Fn::Sub'];

      if (typeof subValue === 'string') {
        return resolveSubStringForm(subValue, driftedLogicalIds, resolvedValues, collectMode);
      }

      if (Array.isArray(subValue) && subValue.length === 2) {
        return resolveSubArrayForm(
          subValue[0] as string,
          subValue[1] as Record<string, unknown>,
          driftedLogicalIds,
          resolvedValues,
          collectMode,
        );
      }

      return obj;
    }

    // Recursively process other objects
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolvePropertyValue(val, driftedLogicalIds, resolvedValues, collectMode);
    }
    return result;
  }

  return value;
}

/**
 * Resolve Fn::Sub string form: {'Fn::Sub': 'arn:...${MyBucket}'}
 * Parses ${LogicalId} and ${LogicalId.Attribute} from the template string.
 */
function resolveSubStringForm(
  templateStr: string,
  driftedLogicalIds: Set<string>,
  resolvedValues: Map<string, unknown>,
  collectMode: boolean,
): unknown {
  let allResolved = true;
  let hasDriftedRefs = false;

  const result = templateStr.replace(SUB_VARIABLE_PATTERN, (match, varName: string) => {
    if (CFN_PSEUDO_REFS.has(varName)) {
      allResolved = false;
      return match;
    }

    const dotIndex = varName.indexOf('.');
    let logicalId: string;
    let key: string;

    if (dotIndex > 0) {
      logicalId = varName.substring(0, dotIndex);
      const attribute = varName.substring(dotIndex + 1);
      key = `GetAtt:${logicalId}:${attribute}`;
    } else {
      logicalId = varName;
      key = `Ref:${logicalId}`;
    }

    if (!driftedLogicalIds.has(logicalId)) {
      allResolved = false;
      return match;
    }

    hasDriftedRefs = true;

    if (collectMode) {
      if (dotIndex > 0) {
        const attribute = varName.substring(dotIndex + 1);
        resolvedValues.set(key, { 'Fn::GetAtt': [logicalId, attribute] });
      } else {
        resolvedValues.set(key, { Ref: logicalId });
      }
      allResolved = false;
      return match;
    }

    if (resolvedValues.has(key)) {
      return String(resolvedValues.get(key));
    }

    allResolved = false;
    return match;
  });

  if (collectMode || !hasDriftedRefs) {
    return { 'Fn::Sub': templateStr };
  }

  if (allResolved) {
    return result;
  }

  return { 'Fn::Sub': result };
}

/**
 * Resolve Fn::Sub array form: {'Fn::Sub': ['template', {VarMap}]}
 * Resolves values in the variable map and direct references in the template string.
 */
function resolveSubArrayForm(
  templateStr: string,
  variableMap: Record<string, unknown>,
  driftedLogicalIds: Set<string>,
  resolvedValues: Map<string, unknown>,
  collectMode: boolean,
): unknown {
  // Resolve variable map values (they may contain Ref/GetAtt)
  const resolvedMap: Record<string, unknown> = {};
  let mapChanged = false;

  for (const [varName, varValue] of Object.entries(variableMap)) {
    const resolved = resolvePropertyValue(varValue, driftedLogicalIds, resolvedValues, collectMode);
    resolvedMap[varName] = resolved;
    if (resolved !== varValue) {
      mapChanged = true;
    }
  }

  // Resolve direct references in the template string (variables NOT in the map)
  const processedStr = resolveSubStringForm(
    templateStr,
    driftedLogicalIds,
    resolvedValues,
    collectMode,
  );

  if (collectMode) {
    return { 'Fn::Sub': [templateStr, variableMap] };
  }

  const newTemplateStr = typeof processedStr === 'string'
    ? processedStr
    : (processedStr as Record<string, unknown>)['Fn::Sub'] as string;

  if (mapChanged || newTemplateStr !== templateStr) {
    // Filter map to only keys still referenced in template
    const filteredMap: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolvedMap)) {
      if (newTemplateStr.includes(`\${${k}}`)) {
        filteredMap[k] = v;
      }
    }
    if (Object.keys(filteredMap).length === 0) {
      return { 'Fn::Sub': newTemplateStr };
    }
    return { 'Fn::Sub': [newTemplateStr, filteredMap] };
  }

  return { 'Fn::Sub': [templateStr, variableMap] };
}

/**
 * Collect all Ref/GetAtt references to drifted resources in a template
 */
export function collectReferences(
  template: CloudFormationTemplate,
  driftedLogicalIds: Set<string>,
): Map<string, unknown> {
  const references = new Map<string, unknown>();
  resolvePropertyValue(template, driftedLogicalIds, references, true);
  return references;
}

/**
 * Set DeletionPolicy: Retain on all resources in a template
 */
export function setRetentionOnAllResources(template: CloudFormationTemplate): CloudFormationTemplate {
  const result = deepClone(template);

  for (const logicalId of Object.keys(result.Resources || {})) {
    result.Resources[logicalId].DeletionPolicy = 'Retain';
  }

  return result;
}

/**
 * Check if a value contains unresolved Ref/GetAtt/Fn::Sub references to specified logical IDs.
 * Used to detect broken references after resource removal.
 */
function hasUnresolvedReferences(
  value: unknown,
  removedLogicalIds: Set<string>,
): boolean {
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasUnresolvedReferences(item, removedLogicalIds));
  }

  const obj = value as Record<string, unknown>;

  if ('Ref' in obj && typeof obj.Ref === 'string') {
    return removedLogicalIds.has(obj.Ref);
  }

  if ('Fn::GetAtt' in obj) {
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && getAtt.length >= 1) {
      return removedLogicalIds.has(getAtt[0] as string);
    }
    if (typeof getAtt === 'string') {
      return removedLogicalIds.has(getAtt.split('.')[0]);
    }
  }

  if ('Fn::Sub' in obj) {
    const subValue = obj['Fn::Sub'];
    const templateStr = typeof subValue === 'string'
      ? subValue
      : (Array.isArray(subValue) ? subValue[0] as string : '');
    for (const match of templateStr.matchAll(SUB_VARIABLE_PATTERN)) {
      const varName = match[1];
      if (CFN_PSEUDO_REFS.has(varName)) continue;
      const logicalId = varName.includes('.') ? varName.split('.')[0] : varName;
      if (removedLogicalIds.has(logicalId)) return true;
    }
    if (Array.isArray(subValue) && subValue.length === 2) {
      if (hasUnresolvedReferences(subValue[1], removedLogicalIds)) return true;
    }
    return false;
  }

  for (const val of Object.values(obj)) {
    if (hasUnresolvedReferences(val, removedLogicalIds)) return true;
  }

  return false;
}

/**
 * Transform template for removing drifted resources:
 * 1. Set DeletionPolicy: Retain on all resources
 * 2. Resolve Ref/GetAtt pointing to drifted resources
 * 3. Remove drifted resources from template
 */
export function transformTemplateForRemoval(
  template: CloudFormationTemplate,
  driftedLogicalIds: Set<string>,
  resolvedValues: Map<string, unknown>,
): TransformResult {
  let transformedTemplate = deepClone(template);
  const removedResources: string[] = [];

  // Step 1: Set DeletionPolicy: Retain on ALL resources
  transformedTemplate = setRetentionOnAllResources(transformedTemplate);

  // Step 2: De-reference Ref/GetAtt in non-drifted resources
  for (const [logicalId, resource] of Object.entries(transformedTemplate.Resources || {})) {
    if (!driftedLogicalIds.has(logicalId)) {
      if (resource.Properties) {
        resource.Properties = resolvePropertyValue(
          resource.Properties,
          driftedLogicalIds,
          resolvedValues,
          false,
        ) as Record<string, unknown>;
      }
    }
  }

  // Also process Outputs section if present
  if (transformedTemplate.Outputs) {
    transformedTemplate.Outputs = resolvePropertyValue(
      transformedTemplate.Outputs,
      driftedLogicalIds,
      resolvedValues,
      false,
    ) as Record<string, unknown>;
  }

  // Step 3: Remove drifted resources
  for (const logicalId of driftedLogicalIds) {
    if (transformedTemplate.Resources?.[logicalId]) {
      delete transformedTemplate.Resources[logicalId];
      removedResources.push(logicalId);
    }
  }

  // Step 3b: Clean up DependsOn references to removed resources
  for (const resource of Object.values(transformedTemplate.Resources || {})) {
    if (resource.DependsOn) {
      if (typeof resource.DependsOn === 'string') {
        if (driftedLogicalIds.has(resource.DependsOn)) {
          delete resource.DependsOn;
        }
      } else if (Array.isArray(resource.DependsOn)) {
        resource.DependsOn = resource.DependsOn.filter(
          (dep) => !driftedLogicalIds.has(dep),
        );
        if (resource.DependsOn.length === 0) {
          delete resource.DependsOn;
        }
      }
    }
  }

  // Step 3c: Remove Outputs that still reference removed resources
  if (transformedTemplate.Outputs) {
    const outputsToRemove: string[] = [];

    for (const [outputName, outputDef] of Object.entries(transformedTemplate.Outputs)) {
      if (hasUnresolvedReferences(outputDef, driftedLogicalIds)) {
        outputsToRemove.push(outputName);
      }
    }

    for (const outputName of outputsToRemove) {
      delete transformedTemplate.Outputs[outputName];
    }

    if (Object.keys(transformedTemplate.Outputs).length === 0) {
      delete transformedTemplate.Outputs;
    }
  }

  // Step 4: If all resources removed, use placeholder template
  if (Object.keys(transformedTemplate.Resources || {}).length === 0) {
    transformedTemplate = deepClone(EMPTY_TEMPLATE);
  }

  return {
    template: transformedTemplate,
    removedResources,
    resolvedReferences: resolvedValues,
  };
}

/**
 * Add temporary outputs to a template to resolve Ref/GetAtt values
 */
export function addResolutionOutputs(
  template: CloudFormationTemplate,
  references: Map<string, unknown>,
): CloudFormationTemplate {
  const result = deepClone(template);

  if (!result.Outputs) {
    result.Outputs = {};
  }

  let index = 0;
  for (const [key, value] of references) {
    const outputKey = `DriftResolve${index++}`;
    result.Outputs[outputKey] = {
      Value: value,
      Description: `Temporary output for resolving: ${key}`,
    };
  }

  return result;
}

/**
 * Parse resolved outputs back into the references map
 */
export function parseResolvedOutputs(
  outputs: Array<{ OutputKey?: string; OutputValue?: string }>,
  references: Map<string, unknown>,
): Map<string, unknown> {
  const resolved = new Map<string, unknown>();
  const refKeys = Array.from(references.keys());

  for (const output of outputs) {
    if (output.OutputKey?.startsWith('DriftResolve')) {
      const index = parseInt(output.OutputKey.replace('DriftResolve', ''), 10);
      if (!isNaN(index) && index < refKeys.length) {
        resolved.set(refKeys[index], output.OutputValue);
      }
    }
  }

  return resolved;
}

/**
 * Prepare template for re-importing drifted resources with their actual properties
 * Note: Outputs must be removed during import as CloudFormation doesn't allow modifying them
 */
export function prepareTemplateForImport(
  originalTemplate: CloudFormationTemplate,
  driftedResources: Array<{ logicalResourceId: string; actualProperties?: Record<string, unknown> }>,
): CloudFormationTemplate {
  const importTemplate = deepClone(originalTemplate);

  // Remove Outputs - CloudFormation doesn't allow modifying outputs during import
  delete importTemplate.Outputs;

  for (const drifted of driftedResources) {
    const resource = importTemplate.Resources?.[drifted.logicalResourceId];
    if (resource) {
      // Ensure DeletionPolicy is set
      resource.DeletionPolicy = 'Retain';

      // Update properties to match actual state if available
      if (drifted.actualProperties && Object.keys(drifted.actualProperties).length > 0) {
        resource.Properties = drifted.actualProperties;
      } else if (drifted.actualProperties !== undefined) {
        console.warn(
          `Warning: actualProperties for ${drifted.logicalResourceId} is empty, ` +
          'keeping original template properties',
        );
      }
    }
  }

  return importTemplate;
}

/**
 * Parse a CloudFormation template from string (YAML or JSON)
 */
export function parseTemplate(templateBody: string): CloudFormationTemplate {
  try {
    // yaml-cfn handles both YAML and JSON, and properly parses CloudFormation intrinsic functions
    return yaml.yamlParse(templateBody) as CloudFormationTemplate;
  } catch {
    // Fall back to JSON parse if yaml-cfn fails
    return JSON.parse(templateBody) as CloudFormationTemplate;
  }
}

/**
 * Stringify a CloudFormation template to JSON
 */
export function stringifyTemplate(template: CloudFormationTemplate): string {
  return JSON.stringify(template, null, 2);
}
