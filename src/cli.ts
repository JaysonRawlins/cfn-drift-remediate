import * as fs from 'fs';
import * as path from 'path';
import { Ora } from 'ora';
import { CfnClientWrapper } from './lib/cfn-client';
import { isResourceImportable, getAllRequiredCapabilities } from './lib/eligible-resources';
import { promptForDecisions } from './lib/interactive';
import { buildResourcesToImport, buildReimportDescriptor } from './lib/resource-importer';
import {
  parseTemplate,
  stringifyTemplate,
  collectReferences,
  addResolutionOutputs,
  parseResolvedOutputs,
  setRetentionOnAllResources,
  transformTemplateForRemoval,
} from './lib/template-transformer';
import {
  RemediationOptions,
  RemediationResult,
  RecoveryCheckpoint,
  DriftedResource,
  ResourceToImport,
} from './lib/types';
import { deepClone } from './lib/utils';

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
    removedResources: [],
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

    // Step 3: Get drifted resources and separate by type
    log('Analyzing drifted resources...');
    const allDriftedResources = await client.getDriftedResources(stackInfo.stackId);

    if (allDriftedResources.length === 0) {
      if (spinner) spinner.succeed('No drifted resources found');
      result.success = true;
      return result;
    }

    // Filter to only importable resources
    const modifiedResources: DriftedResource[] = [];
    const deletedResources: DriftedResource[] = [];

    for (const resource of allDriftedResources) {
      if (!isResourceImportable(resource.resourceType)) {
        result.skippedResources.push(resource.logicalResourceId);
        continue;
      }
      if (resource.stackResourceDriftStatus === 'DELETED') {
        deletedResources.push(resource);
      } else {
        modifiedResources.push(resource);
      }
    }

    if (modifiedResources.length === 0 && deletedResources.length === 0) {
      result.errors.push('All drifted resources are not eligible for import');
      return result;
    }

    // Step 4: Interactive decisions
    if (spinner) spinner.stop();

    const decisions = await promptForDecisions(
      modifiedResources,
      deletedResources,
      options.yes ?? false,
    );

    if (spinner) spinner.start('Processing...');

    // Record skipped resources
    for (const r of decisions.skip) {
      result.skippedResources.push(r.logicalResourceId);
    }

    // If everything was skipped or cancelled, we're done
    if (decisions.autofix.length === 0 && decisions.reimport.length === 0 && decisions.remove.length === 0) {
      if (spinner) spinner.succeed('No actions selected');
      result.success = true;
      return result;
    }

    // Step 5: Build resources to import from decisions
    const resourceIdentifiers = await client.getResourceIdentifiers(originalTemplateBody);

    // Autofix resources: use existing buildResourcesToImport
    const { importable: autofixImportable, skipped: autofixSkipped } =
      buildResourcesToImport(decisions.autofix, resourceIdentifiers);

    for (const s of autofixSkipped) {
      if (!result.skippedResources.includes(s.logicalResourceId)) {
        result.skippedResources.push(s.logicalResourceId);
      }
    }

    // Reimport resources: build from user-provided physical IDs
    const reimportImportable: ResourceToImport[] = [];
    for (const { resource, physicalId } of decisions.reimport) {
      const descriptor = buildReimportDescriptor(resource, physicalId, resourceIdentifiers);
      if (descriptor) {
        reimportImportable.push(descriptor);
      } else {
        result.errors.push(
          `Could not determine import identifier for ${resource.logicalResourceId} from "${physicalId}"`,
        );
        result.skippedResources.push(resource.logicalResourceId);
      }
    }

    // Combined importable list
    const allImportable = [...autofixImportable, ...reimportImportable];

    // If nothing to import AND nothing to remove, we're stuck
    if (allImportable.length === 0 && decisions.remove.length === 0) {
      result.errors.push('Could not determine import identifiers for any selected resources');
      return result;
    }

    // Build the set of logical IDs that need removal from the template
    // This includes everything being acted on (autofix, reimport, remove)
    const logicalIdsToRemove = new Set([
      ...autofixImportable.map((r) => r.LogicalResourceId),
      ...reimportImportable.map((r) => r.LogicalResourceId),
      ...decisions.remove.map((r) => r.logicalResourceId),
    ]);

    // Dry run - show what would be done
    if (options.dryRun) {
      if (spinner) spinner.info('Dry run - planned actions:');
      if (allImportable.length > 0) {
        console.log('\nResources to remediate:');
        for (const resource of allImportable) {
          console.log(`  - ${resource.LogicalResourceId} (${resource.ResourceType})`);
          console.log(`    Identifier: ${JSON.stringify(resource.ResourceIdentifier)}`);
        }
      }
      if (decisions.remove.length > 0) {
        console.log('\nResources to remove from stack:');
        for (const r of decisions.remove) {
          console.log(`  - ${r.logicalResourceId} (${r.resourceType})`);
        }
      }
      result.success = true;
      result.remediatedResources = allImportable.map((r) => r.LogicalResourceId);
      result.removedResources = decisions.remove.map((r) => r.logicalResourceId);
      return result;
    }

    // Determine required capabilities
    const resourceTypes = allImportable.map((r) => r.ResourceType);
    const additionalCaps = getAllRequiredCapabilities(resourceTypes);
    const capabilities = [...new Set([...DEFAULT_CAPABILITIES, ...additionalCaps])];

    // Save recovery checkpoint before any stack mutations
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `.cfn-drift-remediate-backup-${stackInfo.stackName}-${timestamp}.json`;
    const backupPath = path.resolve(process.cwd(), backupFileName);
    const checkpoint: RecoveryCheckpoint = {
      stackName: stackInfo.stackName,
      stackId: stackInfo.stackId,
      originalTemplateBody,
      parameters: stackInfo.parameters,
      driftedResourceIds: Array.from(logicalIdsToRemove),
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(backupPath, JSON.stringify(checkpoint, null, 2));
    log(`Recovery checkpoint saved to: ${backupPath}`);
    if (options.verbose) {
      console.log(`Recovery checkpoint: ${backupPath}`);
    }

    // Step 6: Set DeletionPolicy: Retain on all resources
    // DELETED resources must be removed from the template first — CloudFormation
    // cannot update metadata on resources that no longer exist in AWS.
    log('Setting DeletionPolicy: Retain on all resources...');
    const deletedLogicalIds = new Set(
      allDriftedResources
        .filter((r) => r.stackResourceDriftStatus === 'DELETED' && logicalIdsToRemove.has(r.logicalResourceId))
        .map((r) => r.logicalResourceId),
    );

    let retainTemplate = setRetentionOnAllResources(originalTemplate);

    if (deletedLogicalIds.size > 0) {
      // Remove deleted resources and clean up their dangling references
      const { template: cleanedTemplate } = transformTemplateForRemoval(
        retainTemplate,
        deletedLogicalIds,
        new Map(), // no resolved values — just strip unresolvable references
      );
      retainTemplate = cleanedTemplate;
    }

    await client.updateStack(
      stackInfo.stackId,
      stringifyTemplate(retainTemplate),
      retainTemplate.Parameters ? stackInfo.parameters : undefined,
      capabilities,
    );

    // Step 7: Resolve cross-references to MODIFIED resources being removed
    // (DELETED resources are already removed from the template, so only MODIFIED refs remain)
    const modifiedIdsToRemove = new Set(
      [...logicalIdsToRemove].filter((id) => !deletedLogicalIds.has(id)),
    );
    const references = collectReferences(retainTemplate, modifiedIdsToRemove);

    let resolvedValues = new Map<string, unknown>();
    if (references.size > 0) {
      log('Resolving references to drifted resources...');

      const outputTemplate = addResolutionOutputs(retainTemplate, references);
      await client.updateStack(
        stackInfo.stackId,
        stringifyTemplate(outputTemplate),
        outputTemplate.Parameters ? stackInfo.parameters : undefined,
        capabilities,
      );

      const updatedStackInfo = await client.getStackInfo(stackInfo.stackId);
      resolvedValues = parseResolvedOutputs(updatedStackInfo.outputs || [], references);
    }

    // Step 8: Remove remaining (MODIFIED) resources from template
    log('Removing resources from stack (resources retained in AWS)...');
    const { template: removalTemplate } = transformTemplateForRemoval(
      retainTemplate,
      modifiedIdsToRemove,
      resolvedValues,
    );

    const removalParams = removalTemplate.Parameters ? stackInfo.parameters : undefined;
    await client.updateStack(
      stackInfo.stackId,
      stringifyTemplate(removalTemplate),
      removalParams,
      capabilities,
    );

    // Step 9: Import resources (only if there are resources to import)
    if (allImportable.length > 0) {
      log('Preparing import template with actual resource state...');

      // Build import template from the removal template (current stack state)
      // and add back the resources being imported with their actual properties
      const importTemplate = deepClone(removalTemplate);

      for (const importable of allImportable) {
        const logicalId = importable.LogicalResourceId;
        const originalResource = originalTemplate.Resources?.[logicalId];
        if (!originalResource) continue;

        // Start with original resource definition
        importTemplate.Resources[logicalId] = deepClone(originalResource);

        // For autofix resources, override with actual (drifted) properties
        const autofixResource = decisions.autofix.find((r) => r.logicalResourceId === logicalId);
        if (autofixResource?.actualProperties && Object.keys(autofixResource.actualProperties).length > 0) {
          importTemplate.Resources[logicalId].Properties = autofixResource.actualProperties;
        }

        importTemplate.Resources[logicalId].DeletionPolicy = 'Retain';
      }

      // Ensure Retain on all resources in import template
      for (const logicalId of Object.keys(importTemplate.Resources)) {
        importTemplate.Resources[logicalId].DeletionPolicy = 'Retain';
      }

      log('Creating import change set...');
      const changeSetName = await client.createImportChangeSet(
        stackInfo.stackName,
        stringifyTemplate(importTemplate),
        allImportable,
        capabilities,
      );

      log('Executing import...');
      await client.executeChangeSet(stackInfo.stackName, changeSetName);
    }

    // Step 10: Restore template
    if (decisions.remove.length > 0) {
      // Some resources permanently removed — restore original MINUS removed resources
      log('Restoring template (excluding removed resources)...');
      const restoredTemplate = deepClone(originalTemplate);
      for (const r of decisions.remove) {
        delete restoredTemplate.Resources[r.logicalResourceId];
      }
      // Clean up references and outputs pointing to removed resources
      const { template: cleanedTemplate } = transformTemplateForRemoval(
        restoredTemplate,
        new Set(decisions.remove.map((r) => r.logicalResourceId)),
        resolvedValues,
      );
      // Restore original DeletionPolicy values (transformTemplateForRemoval sets Retain on all)
      for (const [logicalId, resource] of Object.entries(cleanedTemplate.Resources || {})) {
        const originalResource = originalTemplate.Resources?.[logicalId];
        if (originalResource?.DeletionPolicy) {
          resource.DeletionPolicy = originalResource.DeletionPolicy;
        } else {
          delete resource.DeletionPolicy;
        }
      }
      await client.updateStack(
        stackInfo.stackName,
        stringifyTemplate(cleanedTemplate),
        cleanedTemplate.Parameters ? stackInfo.parameters : undefined,
        capabilities,
      );
    } else {
      // No removals — restore exact original
      log('Restoring original template...');
      await client.updateStack(
        stackInfo.stackName,
        originalTemplateBody,
        stackInfo.parameters,
        capabilities,
      );
    }

    result.success = true;
    result.remediatedResources = allImportable.map((r) => r.LogicalResourceId);
    result.removedResources = decisions.remove.map((r) => r.logicalResourceId);

    if (options.verbose) {
      console.log(`Remediation complete. Recovery checkpoint can be removed: ${backupPath}`);
    }

  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  return result;
}
