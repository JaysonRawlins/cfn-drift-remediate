import * as fs from 'fs';
import * as path from 'path';
import { Ora } from 'ora';
import { CfnClientWrapper } from './lib/cfn-client';
import { isResourceImportable, getAllRequiredCapabilities } from './lib/eligible-resources';
import { buildResourcesToImport } from './lib/resource-importer';
import {
  parseTemplate,
  stringifyTemplate,
  collectReferences,
  addResolutionOutputs,
  parseResolvedOutputs,
  setRetentionOnAllResources,
  transformTemplateForRemoval,
  prepareTemplateForImport,
} from './lib/template-transformer';
import { RemediationOptions, RemediationResult, RecoveryCheckpoint, DriftedResource } from './lib/types';

const DEFAULT_CAPABILITIES = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'];

/**
 * Main remediation function that orchestrates the drift remediation process
 */
export async function remediate(
  options: RemediationOptions,
  spinner?: Ora,
): Promise<RemediationResult> {
  const client = new CfnClientWrapper({
    region: options.region,
    profile: options.profile,
  });

  const result: RemediationResult = {
    success: false,
    remediatedResources: [],
    skippedResources: [],
    errors: [],
  };

  const log = (message: string) => {
    if (spinner) {
      spinner.text = message;
    } else if (options.verbose) {
      console.log(message);
    }
  };

  try {
    // Step 1: Get stack info and original template
    log('Fetching stack information...');
    const stackInfo = await client.getStackInfo(options.stackName);

    log('Fetching original template...');
    const originalTemplateBody = await client.getTemplate(stackInfo.stackId, true);
    const originalTemplate = parseTemplate(originalTemplateBody);

    if (options.verbose) {
      console.log(`Found stack: ${stackInfo.stackName} (${stackInfo.stackId})`);
    }

    // Step 2: Detect drift
    log('Detecting stack drift...');
    const detectionId = await client.detectDrift(stackInfo.stackId);

    log('Waiting for drift detection to complete...');
    const detectionResult = await client.waitForDriftDetection(detectionId);

    if (detectionResult.status !== 'DETECTION_COMPLETE') {
      result.errors.push(`Drift detection did not complete: ${detectionResult.status}`);
      return result;
    }

    if (detectionResult.driftStatus === 'IN_SYNC') {
      if (spinner) spinner.succeed('Stack is in sync - no drift detected');
      result.success = true;
      return result;
    }

    // Step 3: Get drifted resources
    log('Analyzing drifted resources...');
    const allDriftedResources = await client.getDriftedResources(stackInfo.stackId);

    if (allDriftedResources.length === 0) {
      if (spinner) spinner.succeed('No drifted resources found');
      result.success = true;
      return result;
    }

    // Filter to only importable resources
    const importableResources: DriftedResource[] = [];
    for (const resource of allDriftedResources) {
      if (isResourceImportable(resource.resourceType)) {
        importableResources.push(resource);
      } else {
        result.skippedResources.push(resource.logicalResourceId);
      }
    }

    // Separate MODIFIED from DELETED resources
    // DELETED resources cannot be re-imported (physical resource no longer exists)
    const modifiedResources: DriftedResource[] = [];
    const deletedResources: DriftedResource[] = [];

    for (const resource of importableResources) {
      if (resource.stackResourceDriftStatus === 'DELETED') {
        deletedResources.push(resource);
        result.skippedResources.push(resource.logicalResourceId);
      } else {
        modifiedResources.push(resource);
      }
    }

    if (deletedResources.length > 0) {
      log(`Skipping ${deletedResources.length} DELETED resources (no longer exist in AWS)`);
      if (options.verbose) {
        for (const r of deletedResources) {
          console.warn(`  DELETED: ${r.logicalResourceId} (${r.resourceType})`);
        }
      }
    }

    if (modifiedResources.length === 0) {
      if (deletedResources.length > 0) {
        result.errors.push('All drifted resources are either deleted or not eligible for import');
      } else {
        result.errors.push('All drifted resources are not eligible for import');
      }
      if (result.skippedResources.length > 0) {
        result.errors.push(`Skipped resources: ${result.skippedResources.join(', ')}`);
      }
      return result;
    }

    if (options.verbose) {
      console.log(`Found ${modifiedResources.length} drifted resources eligible for remediation:`);
      for (const r of modifiedResources) {
        console.log(`  - ${r.logicalResourceId} (${r.resourceType}): ${r.stackResourceDriftStatus}`);
      }
      if (result.skippedResources.length > 0) {
        console.log(`Skipped ${result.skippedResources.length} non-importable/deleted resources`);
      }
    }

    // Step 4: Build resources to import
    const resourceIdentifiers = await client.getResourceIdentifiers(originalTemplateBody);
    const { importable, skipped } = buildResourcesToImport(modifiedResources, resourceIdentifiers);

    for (const s of skipped) {
      if (!result.skippedResources.includes(s.logicalResourceId)) {
        result.skippedResources.push(s.logicalResourceId);
      }
    }

    if (importable.length === 0) {
      result.errors.push('Could not determine import identifiers for any drifted resources');
      return result;
    }

    // Dry run - just show what would be done
    if (options.dryRun) {
      if (spinner) spinner.info('Dry run - would remediate the following resources:');
      console.log('\nResources to remediate:');
      for (const resource of importable) {
        console.log(`  - ${resource.LogicalResourceId} (${resource.ResourceType})`);
        console.log(`    Identifier: ${JSON.stringify(resource.ResourceIdentifier)}`);
      }
      result.success = true;
      result.remediatedResources = importable.map((r) => r.LogicalResourceId);
      return result;
    }

    // Determine required capabilities
    const resourceTypes = importable.map((r) => r.ResourceType);
    const additionalCaps = getAllRequiredCapabilities(resourceTypes);
    const capabilities = [...new Set([...DEFAULT_CAPABILITIES, ...additionalCaps])];

    // Build set of drifted logical IDs (includes both MODIFIED and DELETED
    // since both need removal from template and reference resolution)
    const driftedLogicalIds = new Set([
      ...modifiedResources.map((r) => r.logicalResourceId),
      ...deletedResources.map((r) => r.logicalResourceId),
    ]);

    // Save recovery checkpoint before any stack mutations
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `.cfn-drift-remediate-backup-${stackInfo.stackName}-${timestamp}.json`;
    const backupPath = path.resolve(process.cwd(), backupFileName);
    const checkpoint: RecoveryCheckpoint = {
      stackName: stackInfo.stackName,
      stackId: stackInfo.stackId,
      originalTemplateBody,
      parameters: stackInfo.parameters,
      driftedResourceIds: Array.from(driftedLogicalIds),
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(backupPath, JSON.stringify(checkpoint, null, 2));
    log(`Recovery checkpoint saved to: ${backupPath}`);
    if (options.verbose) {
      console.log(`Recovery checkpoint: ${backupPath}`);
    }

    // Step 5: Set DeletionPolicy: Retain on all resources
    log('Setting DeletionPolicy: Retain on all resources...');
    const retainTemplate = setRetentionOnAllResources(originalTemplate);
    await client.updateStack(
      stackInfo.stackId,
      stringifyTemplate(retainTemplate),
      stackInfo.parameters,
      capabilities,
    );

    // Step 6: De-reference Ref/GetAtt pointing to drifted resources (if needed)
    const references = collectReferences(retainTemplate, driftedLogicalIds);

    let resolvedValues = new Map<string, unknown>();
    if (references.size > 0) {
      log('Resolving references to drifted resources...');

      // Add temporary outputs to resolve references
      const outputTemplate = addResolutionOutputs(retainTemplate, references);
      await client.updateStack(
        stackInfo.stackId,
        stringifyTemplate(outputTemplate),
        stackInfo.parameters,
        capabilities,
      );

      // Get resolved output values
      const updatedStackInfo = await client.getStackInfo(stackInfo.stackId);
      resolvedValues = parseResolvedOutputs(updatedStackInfo.outputs || [], references);
    }

    // Step 7: Remove drifted resources from template
    log('Removing drifted resources from stack (resources retained)...');
    const { template: removalTemplate } = transformTemplateForRemoval(
      retainTemplate,
      driftedLogicalIds,
      resolvedValues,
    );

    // Only pass parameters if the template defines them
    const removalParams = removalTemplate.Parameters ? stackInfo.parameters : undefined;
    await client.updateStack(
      stackInfo.stackId,
      stringifyTemplate(removalTemplate),
      removalParams,
      capabilities,
    );

    // Step 8: Create import template with actual properties
    log('Preparing import template with actual resource state...');
    const importTemplate = prepareTemplateForImport(originalTemplate, modifiedResources);

    // Set Retain on import template
    for (const logicalId of Object.keys(importTemplate.Resources)) {
      importTemplate.Resources[logicalId].DeletionPolicy = 'Retain';
    }

    // Step 9: Create and execute import change set
    log('Creating import change set...');
    const changeSetName = await client.createImportChangeSet(
      stackInfo.stackName,
      stringifyTemplate(importTemplate),
      importable,
      capabilities,
    );

    log('Executing import...');
    await client.executeChangeSet(stackInfo.stackName, changeSetName);

    // Step 10: Restore original template to complete remediation
    log('Restoring original template...');
    await client.updateStack(
      stackInfo.stackName,
      originalTemplateBody,
      stackInfo.parameters,
      capabilities,
    );

    result.success = true;
    result.remediatedResources = importable.map((r) => r.LogicalResourceId);

    if (options.verbose) {
      console.log(`Remediation complete. Recovery checkpoint can be removed: ${backupPath}`);
    }

  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  return result;
}
