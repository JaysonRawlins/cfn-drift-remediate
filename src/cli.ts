import * as fs from 'fs';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { Ora } from 'ora';
import { CfnClientWrapper } from './lib/cfn-client';
import { isResourceImportable, getAllRequiredCapabilities } from './lib/eligible-resources';
import {
  displayBlockedDeletedResources,
  displayCascadeWarning,
  displayNonImportableReport,
  displayPreflightWarnings,
  promptForDecisions,
} from './lib/interactive';
import { buildPlan, serializePlan, loadPlan, planToDecisions } from './lib/plan';
import { saveCheckpoint, loadCheckpoint, buildStepError } from './lib/recovery';
import { buildResourcesToImport, buildReimportDescriptor } from './lib/resource-importer';
import {
  parseTemplate,
  stringifyTemplate,
  collectReferences,
  addResolutionOutputs,
  parseResolvedOutputs,
  extractResolvedValues,
  resolvePropertyValue,
  setRetentionOnAllResources,
  transformTemplateForRemoval,
  analyzeCascadeRemovals,
} from './lib/template-transformer';
import {
  RemediationOptions,
  RemediationResult,
  RecoveryCheckpoint,
  CloudFormationTemplate,
  DriftedResource,
  InteractiveDecisions,
  PreflightWarning,
  RemediationStep,
  ResourceToImport,
  StepError,
  STEP_DESCRIPTIONS,
} from './lib/types';
import { deepClone } from './lib/utils';

const DEFAULT_CAPABILITIES = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'];

function packageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Execute a remediation step, saving the checkpoint on success and building
 * a StepError on failure.
 */
async function executeStep(
  step: RemediationStep,
  checkpoint: RecoveryCheckpoint,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    checkpoint.lastCompletedStep = step;
    saveCheckpoint(checkpoint);
  } catch (error) {
    throw buildStepError(step, error instanceof Error ? error : new Error(String(error)), checkpoint);
  }
}

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
    s3BucketName: options.s3Bucket,
  });

  const result: RemediationResult = {
    success: false,
    remediatedResources: [],
    skippedResources: [],
    removedResources: [],
    nonImportableResources: [],
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
    // ----------------------------------------------------------------
    // Resume path: reconstruct state from checkpoint and jump ahead
    // ----------------------------------------------------------------
    if (options.resume) {
      return await resumeRemediation(options, client, result, log);
    }

    // ----------------------------------------------------------------
    // Normal path: Steps 1-10
    // ----------------------------------------------------------------

    // Step 1: Get stack info and original template
    log('Fetching stack information...');
    const stackInfo = await client.getStackInfo(options.stackName);

    // Concurrent execution guard: fail fast if stack is mid-operation
    if (stackInfo.stackStatus.endsWith('_IN_PROGRESS')) {
      result.errors.push(
        `Stack is currently in ${stackInfo.stackStatus} status. `
        + 'Wait for the current operation to complete before running drift remediation.',
      );
      return result;
    }

    log('Fetching original template...');
    const originalTemplateBody = await client.getTemplate(stackInfo.stackId, true);
    const originalTemplate = parseTemplate(originalTemplateBody);

    if (options.verbose) {
      console.log(`Found stack: ${stackInfo.stackName} (${stackInfo.stackId})`);
    }

    // Steps 2-4: Detect drift and collect decisions (or load from plan)
    let allDriftedResources: DriftedResource[];
    let decisions: InteractiveDecisions;

    if (options.applyPlan) {
      // Apply a previously exported plan — skip drift detection and prompting
      log('Loading remediation plan...');
      const planJson = fs.readFileSync(path.resolve(options.applyPlan), 'utf-8');
      const plan = loadPlan(planJson, options.stackName);
      const loaded = planToDecisions(plan);
      allDriftedResources = loaded.allDriftedResources;
      decisions = loaded.decisions;

      if (spinner) spinner.start('Processing...');
    } else {
      // Normal flow: detect drift and prompt interactively

      // Step 2: Detect drift
      log('Detecting stack drift...');
      const detectionId = await client.detectDrift(stackInfo.stackId);

      log('Waiting for drift detection to complete...');
      const detectionResult = await client.waitForDriftDetection(detectionId);

      if (detectionResult.status !== 'DETECTION_COMPLETE' && detectionResult.status !== 'DETECTION_FAILED') {
        result.errors.push(`Drift detection did not complete: ${detectionResult.status}`);
        return result;
      }

      // When detection failed for some resources, warn but continue with partial results
      if (detectionResult.status === 'DETECTION_FAILED') {
        if (spinner) spinner.stop();
        console.log(chalk.yellow(
          `\nWarning: Drift detection failed for some resources:\n  ${detectionResult.statusReason}`,
        ));
        console.log(chalk.dim('Continuing with resources that were successfully checked.\n'));
      }

      if (detectionResult.driftStatus === 'IN_SYNC' && detectionResult.status === 'DETECTION_COMPLETE') {
        if (spinner) spinner.succeed('Stack is in sync - no drift detected');
        result.success = true;
        return result;
      }

      // Step 3: Get drifted resources and separate by type
      log('Analyzing drifted resources...');
      allDriftedResources = await client.getDriftedResources(stackInfo.stackId);

      if (allDriftedResources.length === 0) {
        if (detectionResult.status === 'DETECTION_FAILED') {
          result.errors.push(
            `Drift detection failed and no drifted resources could be detected: ${detectionResult.statusReason}`,
          );
          return result;
        }
        if (spinner) spinner.succeed('No drifted resources found');
        result.success = true;
        return result;
      }

      // Categorize drifted resources by importability and drift status
      const modifiedResources: DriftedResource[] = [];
      const deletedResources: DriftedResource[] = [];
      const nonImportableModified: DriftedResource[] = [];
      const nonImportableDeleted: DriftedResource[] = [];

      for (const resource of allDriftedResources) {
        const importable = isResourceImportable(resource.resourceType);
        if (resource.stackResourceDriftStatus === 'DELETED') {
          if (importable) {
            deletedResources.push(resource);
          } else {
            nonImportableDeleted.push(resource);
          }
        } else {
          if (importable) {
            modifiedResources.push(resource);
          } else {
            nonImportableModified.push(resource);
          }
        }
      }

      // Track non-importable resources in result
      for (const r of nonImportableModified) {
        result.nonImportableResources.push({
          logicalResourceId: r.logicalResourceId,
          resourceType: r.resourceType,
          physicalResourceId: r.physicalResourceId,
          driftStatus: 'MODIFIED',
          propertyDifferences: r.propertyDifferences,
        });
      }
      for (const r of nonImportableDeleted) {
        result.nonImportableResources.push({
          logicalResourceId: r.logicalResourceId,
          resourceType: r.resourceType,
          physicalResourceId: r.physicalResourceId,
          driftStatus: 'DELETED',
        });
      }

      // Display non-importable report before prompts
      if (nonImportableModified.length > 0 || nonImportableDeleted.length > 0) {
        if (spinner) spinner.stop();
        displayNonImportableReport(nonImportableModified, nonImportableDeleted);
      }

      // If all drifted resources are non-importable MODIFIED, report and return
      if (modifiedResources.length === 0 && deletedResources.length === 0 && nonImportableDeleted.length === 0) {
        if (nonImportableModified.length > 0) {
          result.success = true;
          return result;
        }
        result.errors.push('All drifted resources are not eligible for import');
        return result;
      }

      // Step 4: Interactive decisions (importable resources only)
      if (spinner) spinner.stop();

      decisions = await promptForDecisions(
        modifiedResources,
        deletedResources,
        options.yes ?? false,
      );

      // Non-importable DELETED resources are always removed (no prompt needed)
      for (const r of nonImportableDeleted) {
        decisions.remove.push(r);
      }

      if (spinner) spinner.start('Processing...');

      // Export plan if requested (exit without executing)
      if (options.exportPlan) {
        const planMetadata = {
          stackName: stackInfo.stackName,
          region: client.region,
          createdAt: new Date().toISOString(),
          toolVersion: packageVersion(),
          driftDetectionId: detectionId,
        };
        const plan = buildPlan(planMetadata, decisions, nonImportableModified);
        const planPath = path.resolve(options.exportPlan);
        fs.writeFileSync(planPath, serializePlan(plan));
        if (spinner) spinner.succeed(`Plan exported to ${planPath}`);
        result.success = true;
        return result;
      }
    }

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
    const resourceIdentifiers = await client.getResourceIdentifiers(stackInfo.stackId);

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

    // Analyze cascade removals (resources with broken Ref/GetAtt to removed resources)
    const cascadeRemovals = analyzeCascadeRemovals(originalTemplate, logicalIdsToRemove);

    // Partition into permanent (depend on user-removed resources) vs temporary (depend on autofix/reimport)
    const permanentlyRemovedIds = new Set(decisions.remove.map((r) => r.logicalResourceId));
    const permanentCascade = cascadeRemovals.filter((c) => permanentlyRemovedIds.has(c.dependsOn));
    const temporaryCascade = cascadeRemovals.filter((c) => !permanentlyRemovedIds.has(c.dependsOn));

    if (cascadeRemovals.length > 0) {
      if (spinner) spinner.stop();
      displayCascadeWarning(permanentCascade, temporaryCascade);
      if (spinner) spinner.start('Processing...');
    }

    // Pre-flight check: warn about resource types that don't support CloudControl read
    const preflight = await runPreflightCheck(client, cascadeRemovals, allDriftedResources, logicalIdsToRemove);

    // Block DELETED resources whose cascade deps can't be safely read via CloudControl
    if (preflight.blockedDeletedResourceIds.length > 0) {
      if (spinner) spinner.stop();
      displayBlockedDeletedResources(
        preflight.blockedDeletedResourceIds,
        cascadeRemovals,
        allDriftedResources,
      );

      // Move blocked DELETED resources from remove → skip
      const blockedSet = new Set(preflight.blockedDeletedResourceIds);
      const blockedResources = decisions.remove.filter((r) => blockedSet.has(r.logicalResourceId));
      decisions.remove = decisions.remove.filter((r) => !blockedSet.has(r.logicalResourceId));
      decisions.skip.push(...blockedResources);
      for (const r of blockedResources) {
        result.skippedResources.push(r.logicalResourceId);
      }

      // Remove their cascade deps from analysis
      const filteredCascadeRemovals = cascadeRemovals.filter(
        (c) => !blockedSet.has(c.dependsOn),
      );
      cascadeRemovals.length = 0;
      cascadeRemovals.push(...filteredCascadeRemovals);

      // Rebuild logicalIdsToRemove and allImportable without blocked resources
      for (const id of preflight.blockedDeletedResourceIds) {
        logicalIdsToRemove.delete(id);
      }

      // If nothing remediable remains, return success
      const remainingActions = decisions.autofix.length + decisions.reimport.length + decisions.remove.length;
      if (remainingActions === 0 && allImportable.length === 0) {
        if (spinner) spinner.succeed('No safely remediable resources remain');
        result.success = true;
        return result;
      }
      if (spinner) spinner.start('Processing...');
    }

    if (preflight.warnings.length > 0 && preflight.blockedDeletedResourceIds.length === 0) {
      if (spinner) spinner.stop();
      displayPreflightWarnings(preflight.warnings);
      if (!options.yes) {
        const proceed = await confirm({
          message: 'Continue despite CloudControl warnings?',
          default: true,
        });
        if (!proceed) {
          if (spinner) spinner.succeed('Aborted by user');
          result.success = true;
          result.skippedResources = [...result.skippedResources, ...allImportable.map((r) => r.LogicalResourceId)];
          return result;
        }
      } else if (options.verbose) {
        console.log(chalk.dim('Continuing despite CloudControl warnings (--yes mode).'));
      }
      if (spinner) spinner.start('Processing...');
    }

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
      if (permanentCascade.length > 0) {
        console.log('\nResources permanently cascade-removed (broken references):');
        for (const c of permanentCascade) {
          console.log(`  - ${c.logicalResourceId} (${c.resourceType}) -> depends on ${c.dependsOn}`);
        }
      }
      if (temporaryCascade.length > 0) {
        console.log('\nResources temporarily removed and recreated:');
        for (const c of temporaryCascade) {
          console.log(`  - ${c.logicalResourceId} (${c.resourceType}) -> depends on ${c.dependsOn}`);
        }
      }
      const reportOnly = result.nonImportableResources.filter((r) => r.driftStatus === 'MODIFIED');
      if (reportOnly.length > 0) {
        console.log('\nNon-importable drifted resources (manual action required):');
        for (const r of reportOnly) {
          console.log(`  - ${r.logicalResourceId} (${r.resourceType}) [MODIFIED]`);
        }
      }
      result.success = true;
      result.remediatedResources = allImportable.map((r) => r.LogicalResourceId);
      result.removedResources = [
        ...decisions.remove.map((r) => r.logicalResourceId),
        ...permanentCascade.map((c) => c.logicalResourceId),
      ];
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
      checkpointVersion: 2,
      capabilities,
      decisionsJson: JSON.stringify({
        autofix: decisions.autofix,
        reimport: decisions.reimport,
        remove: decisions.remove,
        skip: decisions.skip,
      }),
      resourcesToImportJson: JSON.stringify(allImportable),
      checkpointPath: backupPath,
    };
    saveCheckpoint(checkpoint);
    log(`Recovery checkpoint saved to: ${backupPath}`);
    if (options.verbose) {
      console.log(`Recovery checkpoint: ${backupPath}`);
    }

    // Execute Steps 6-10 with checkpoint tracking
    await executeMutationSteps(
      client, options, stackInfo, originalTemplate, originalTemplateBody,
      allDriftedResources, decisions, allImportable, logicalIdsToRemove,
      capabilities, checkpoint, log,
    );

    result.success = true;
    result.remediatedResources = allImportable.map((r) => r.LogicalResourceId);
    result.removedResources = [
      ...decisions.remove.map((r) => r.logicalResourceId),
      ...permanentCascade.map((c) => c.logicalResourceId),
    ];

    if (options.verbose) {
      console.log(`Remediation complete. Recovery checkpoint can be removed: ${backupPath}`);
    }

  } catch (error) {
    if (error && typeof error === 'object' && 'step' in error) {
      const stepError = error as StepError;
      result.stepError = stepError;
      result.errors.push(`${STEP_DESCRIPTIONS[stepError.step]} failed: ${stepError.message}`);
    } else {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  } finally {
    await client.cleanupTemplates();
  }

  return result;
}

/**
 * Execute the mutation steps (6-10), each wrapped in executeStep for checkpoint tracking.
 */
async function executeMutationSteps(
  client: CfnClientWrapper,
  options: RemediationOptions,
  stackInfo: {
    stackId: string;
    stackName: string;
    parameters: Array<{ ParameterKey?: string; ParameterValue?: string }>;
    outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
  },
  originalTemplate: CloudFormationTemplate,
  originalTemplateBody: string,
  allDriftedResources: DriftedResource[],
  decisions: InteractiveDecisions,
  allImportable: ResourceToImport[],
  logicalIdsToRemove: Set<string>,
  capabilities: string[],
  checkpoint: RecoveryCheckpoint,
  log: (msg: string) => void,
  startFromStep?: RemediationStep,
  resumeState?: {
    retainTemplate?: CloudFormationTemplate;
    resolvedValues?: Map<string, unknown>;
    removalTemplate?: CloudFormationTemplate;
  },
): Promise<void> {
  let retainTemplate = resumeState?.retainTemplate;
  let resolvedValues = resumeState?.resolvedValues ?? new Map<string, unknown>();
  let removalTemplate = resumeState?.removalTemplate;

  const shouldRun = (step: RemediationStep) => !startFromStep || step >= startFromStep;

  // Step 6: Set DeletionPolicy: Retain on all resources, then remove DELETED resources.
  if (shouldRun(RemediationStep.RETAIN_AND_REMOVE_DELETED)) {
    await executeStep(RemediationStep.RETAIN_AND_REMOVE_DELETED, checkpoint, async () => {
      log('Setting DeletionPolicy: Retain on all resources...');
      const deletedLogicalIds = new Set(
        allDriftedResources
          .filter((r) => r.stackResourceDriftStatus === 'DELETED' && logicalIdsToRemove.has(r.logicalResourceId))
          .map((r) => r.logicalResourceId),
      );

      retainTemplate = setRetentionOnAllResources(originalTemplate);

      if (deletedLogicalIds.size > 0) {
        // Identify cascade-dependent resources (those with Ref/GetAtt to DELETED resources)
        const cascadeDeps = analyzeCascadeRemovals(originalTemplate, deletedLogicalIds);
        const cascadeDepIds = new Set(cascadeDeps.map((c) => c.logicalResourceId));

        if (cascadeDepIds.size > 0) {
          // Phase 1: Resolve broken refs in cascade deps and set Retain.
          log(`Phase 1: Resolving properties for ${cascadeDepIds.size} cascade-dependent resources...`);

          const cascadeResolvedValues = new Map<string, unknown>();

          for (const deletedResource of allDriftedResources) {
            if (deletedLogicalIds.has(deletedResource.logicalResourceId) && deletedResource.physicalResourceId) {
              cascadeResolvedValues.set(`Ref:${deletedResource.logicalResourceId}`, deletedResource.physicalResourceId);
            }
          }

          for (const cascadeDep of cascadeDeps) {
            const resource = originalTemplate.Resources?.[cascadeDep.logicalResourceId];
            if (!resource?.Properties) continue;

            const physicalId = await client.getPhysicalResourceId(
              options.stackName, cascadeDep.logicalResourceId,
            );
            if (!physicalId) continue;

            const actualProps = await client.getResourceProperties(resource.Type, physicalId);
            if (!actualProps) {
              if (options.verbose) {
                console.log(`  Warning: Could not read properties for ${cascadeDep.logicalResourceId} via CloudControl`);
              }
              continue;
            }

            extractResolvedValues(resource.Properties, actualProps, deletedLogicalIds, cascadeResolvedValues);
          }

          if (originalTemplate.Outputs && stackInfo.outputs) {
            const actualOutputsMap: Record<string, Record<string, unknown>> = {};
            for (const output of stackInfo.outputs) {
              if (output.OutputKey) {
                actualOutputsMap[output.OutputKey] = { Value: output.OutputValue };
              }
            }
            extractResolvedValues(originalTemplate.Outputs, actualOutputsMap, deletedLogicalIds, cascadeResolvedValues);
          }

          const phase1Template = deepClone(originalTemplate);
          for (const id of cascadeDepIds) {
            const resource = phase1Template.Resources?.[id];
            if (!resource?.Properties) continue;
            resource.Properties = resolvePropertyValue(
              resource.Properties,
              deletedLogicalIds,
              cascadeResolvedValues,
              false,
            ) as Record<string, unknown>;
            resource.DeletionPolicy = 'Retain';
          }

          if (phase1Template.Outputs) {
            phase1Template.Outputs = resolvePropertyValue(
              phase1Template.Outputs,
              deletedLogicalIds,
              cascadeResolvedValues,
              false,
            ) as Record<string, unknown>;
          }

          await client.updateStack(
            stackInfo.stackId,
            stringifyTemplate(phase1Template),
            phase1Template.Parameters ? stackInfo.parameters : undefined,
            capabilities,
          );
        }

        // Phase 2: Remove DELETED resources and cascade deps from template.
        log('Phase 2: Removing deleted resources from stack...');
        const { template } = transformTemplateForRemoval(
          originalTemplate, deletedLogicalIds, new Map(),
        );
        retainTemplate = template;
      }

      const retainedCount = Object.keys(retainTemplate!.Resources || {}).length;
      log(`DeletionPolicy: Retain set on ${retainedCount} resources. Proceeding...`);

      await client.updateStack(
        stackInfo.stackId,
        stringifyTemplate(retainTemplate!),
        retainTemplate!.Parameters ? stackInfo.parameters : undefined,
        capabilities,
      );

      // Save intermediate state
      checkpoint.retainTemplateBody = stringifyTemplate(retainTemplate!);
    });
  }

  // Step 7: Resolve cross-references to MODIFIED resources being removed
  if (shouldRun(RemediationStep.RESOLVE_REFERENCES)) {
    // Reconstruct retainTemplate from checkpoint if needed
    if (!retainTemplate && checkpoint.retainTemplateBody) {
      retainTemplate = parseTemplate(checkpoint.retainTemplateBody);
    }

    await executeStep(RemediationStep.RESOLVE_REFERENCES, checkpoint, async () => {
      const deletedLogicalIds = new Set(
        allDriftedResources
          .filter((r) => r.stackResourceDriftStatus === 'DELETED' && logicalIdsToRemove.has(r.logicalResourceId))
          .map((r) => r.logicalResourceId),
      );
      const modifiedIdsToRemove = new Set(
        [...logicalIdsToRemove].filter((id) => !deletedLogicalIds.has(id)),
      );
      const references = collectReferences(retainTemplate!, modifiedIdsToRemove);

      resolvedValues = new Map<string, unknown>();
      if (references.size > 0) {
        log('Resolving references to drifted resources...');

        const outputTemplate = addResolutionOutputs(retainTemplate!, references);
        await client.updateStack(
          stackInfo.stackId,
          stringifyTemplate(outputTemplate),
          outputTemplate.Parameters ? stackInfo.parameters : undefined,
          capabilities,
        );

        const updatedStackInfo = await client.getStackInfo(stackInfo.stackId);
        resolvedValues = parseResolvedOutputs(updatedStackInfo.outputs || [], references);
      }

      // Save intermediate state
      checkpoint.resolvedValuesJson = JSON.stringify([...resolvedValues.entries()]);
    });
  }

  // Step 8: Remove remaining (MODIFIED) resources from template
  if (shouldRun(RemediationStep.REMOVE_MODIFIED)) {
    // Reconstruct state from checkpoint if needed
    if (!retainTemplate && checkpoint.retainTemplateBody) {
      retainTemplate = parseTemplate(checkpoint.retainTemplateBody);
    }
    if (resolvedValues.size === 0 && checkpoint.resolvedValuesJson) {
      resolvedValues = new Map(JSON.parse(checkpoint.resolvedValuesJson));
    }

    await executeStep(RemediationStep.REMOVE_MODIFIED, checkpoint, async () => {
      log('Removing resources from stack (resources retained in AWS)...');
      const deletedLogicalIds = new Set(
        allDriftedResources
          .filter((r) => r.stackResourceDriftStatus === 'DELETED' && logicalIdsToRemove.has(r.logicalResourceId))
          .map((r) => r.logicalResourceId),
      );
      const modifiedIdsToRemove = new Set(
        [...logicalIdsToRemove].filter((id) => !deletedLogicalIds.has(id)),
      );

      const { template } = transformTemplateForRemoval(
        retainTemplate!,
        modifiedIdsToRemove,
        resolvedValues,
      );
      removalTemplate = template;

      const removalParams = removalTemplate.Parameters ? stackInfo.parameters : undefined;
      await client.updateStack(
        stackInfo.stackId,
        stringifyTemplate(removalTemplate),
        removalParams,
        capabilities,
      );

      // Save intermediate state
      checkpoint.removalTemplateBody = stringifyTemplate(removalTemplate);
    });
  }

  // Step 9: Import resources (only if there are resources to import)
  if (shouldRun(RemediationStep.IMPORT_RESOURCES) && allImportable.length > 0) {
    // Reconstruct removalTemplate from checkpoint if needed
    if (!removalTemplate && checkpoint.removalTemplateBody) {
      removalTemplate = parseTemplate(checkpoint.removalTemplateBody);
    }

    await executeStep(RemediationStep.IMPORT_RESOURCES, checkpoint, async () => {
      // On resume, filter out resources already imported (partial import recovery)
      let resourcesToImport = allImportable;
      if (startFromStep === RemediationStep.IMPORT_RESOURCES) {
        const existingIds = await client.getStackResourceIds(stackInfo.stackName);
        const alreadyImported = allImportable.filter((r) => existingIds.has(r.LogicalResourceId));
        if (alreadyImported.length > 0) {
          const msg = `Found ${alreadyImported.length} already-imported resource(s), skipping: ${alreadyImported.map((r) => r.LogicalResourceId).join(', ')}`;
          log(msg);
          console.log(msg);
          resourcesToImport = allImportable.filter((r) => !existingIds.has(r.LogicalResourceId));
        }
        if (resourcesToImport.length === 0) {
          const msg = 'All resources already imported. Skipping import step.';
          log(msg);
          console.log(msg);
          checkpoint.importComplete = true;
          return;
        }
      }

      log('Preparing import template with actual resource state...');

      const importTemplate = deepClone(removalTemplate!);

      for (const importable of resourcesToImport) {
        const logicalId = importable.LogicalResourceId;
        const originalResource = originalTemplate.Resources?.[logicalId];
        if (!originalResource) continue;

        importTemplate.Resources[logicalId] = deepClone(originalResource);

        const autofixResource = decisions.autofix.find((r) => r.logicalResourceId === logicalId);
        if (autofixResource?.actualProperties && Object.keys(autofixResource.actualProperties).length > 0) {
          importTemplate.Resources[logicalId].Properties = autofixResource.actualProperties;
        }

        importTemplate.Resources[logicalId].DeletionPolicy = 'Retain';
      }

      for (const logicalId of Object.keys(importTemplate.Resources)) {
        importTemplate.Resources[logicalId].DeletionPolicy = 'Retain';
      }

      log('Creating import change set...');
      const changeSetName = await client.createImportChangeSet(
        stackInfo.stackName,
        stringifyTemplate(importTemplate),
        resourcesToImport,
        capabilities,
      );

      log('Executing import...');
      await client.executeChangeSet(stackInfo.stackName, changeSetName);

      checkpoint.importComplete = true;
    });
  }

  // Step 10: Restore template
  if (shouldRun(RemediationStep.RESTORE_TEMPLATE)) {
    // Reconstruct resolvedValues from checkpoint if needed
    if (resolvedValues.size === 0 && checkpoint.resolvedValuesJson) {
      resolvedValues = new Map(JSON.parse(checkpoint.resolvedValuesJson));
    }

    await executeStep(RemediationStep.RESTORE_TEMPLATE, checkpoint, async () => {
      if (decisions.remove.length > 0) {
        log('Restoring template (excluding removed resources)...');
        const restoredTemplate = deepClone(originalTemplate);
        for (const r of decisions.remove) {
          delete restoredTemplate.Resources[r.logicalResourceId];
        }
        const { template: cleanedTemplate } = transformTemplateForRemoval(
          restoredTemplate,
          new Set(decisions.remove.map((r) => r.logicalResourceId)),
          resolvedValues,
        );
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
        log('Restoring original template...');
        await client.updateStack(
          stackInfo.stackName,
          originalTemplateBody,
          stackInfo.parameters,
          capabilities,
        );
      }
    });
  }
}

/**
 * Resume a previously failed remediation from a checkpoint file.
 */
async function resumeRemediation(
  options: RemediationOptions,
  client: CfnClientWrapper,
  result: RemediationResult,
  log: (msg: string) => void,
): Promise<RemediationResult> {
  log('Loading checkpoint for resume...');
  const checkpoint = loadCheckpoint(options.resume!, options.stackName);

  // Concurrent execution guard: fail fast if stack is mid-operation
  try {
    const currentStackInfo = await client.getStackInfo(options.stackName);
    if (currentStackInfo.stackStatus.endsWith('_IN_PROGRESS')) {
      result.errors.push(
        `Stack is currently in ${currentStackInfo.stackStatus} status. `
        + 'Wait for the current operation to complete before resuming remediation.',
      );
      return result;
    }
  } catch {
    // Stack may not be describable (e.g. deleted) — let the step execution handle it
  }

  const lastCompleted = checkpoint.lastCompletedStep!;
  const nextStep = (lastCompleted + 1) as RemediationStep;

  log(`Resuming from ${STEP_DESCRIPTIONS[lastCompleted]} (completed). Next: ${STEP_DESCRIPTIONS[nextStep] ?? 'done'}`);

  // Reconstruct state from checkpoint
  const originalTemplate = parseTemplate(checkpoint.originalTemplateBody);
  const originalTemplateBody = checkpoint.originalTemplateBody;
  const capabilities = checkpoint.capabilities ?? [...DEFAULT_CAPABILITIES];

  // Reconstruct decisions
  const decisions: InteractiveDecisions = checkpoint.decisionsJson
    ? JSON.parse(checkpoint.decisionsJson)
    : { autofix: [], reimport: [], remove: [], skip: [] };

  // Reconstruct allImportable
  const allImportable: ResourceToImport[] = checkpoint.resourcesToImportJson
    ? JSON.parse(checkpoint.resourcesToImportJson)
    : [];

  const logicalIdsToRemove = new Set(checkpoint.driftedResourceIds);

  // Reconstruct allDriftedResources from decisions
  const allDriftedResources: DriftedResource[] = [
    ...decisions.autofix,
    ...decisions.reimport.map((r: { resource: DriftedResource }) => r.resource),
    ...decisions.remove,
    ...decisions.skip,
  ];

  // Reconstruct intermediate state from checkpoint
  const resumeState: {
    retainTemplate?: CloudFormationTemplate;
    resolvedValues?: Map<string, unknown>;
    removalTemplate?: CloudFormationTemplate;
  } = {};

  if (checkpoint.retainTemplateBody) {
    resumeState.retainTemplate = parseTemplate(checkpoint.retainTemplateBody);
  }
  if (checkpoint.resolvedValuesJson) {
    resumeState.resolvedValues = new Map(JSON.parse(checkpoint.resolvedValuesJson));
  }
  if (checkpoint.removalTemplateBody) {
    resumeState.removalTemplate = parseTemplate(checkpoint.removalTemplateBody);
  }

  // Reconstruct stackInfo from checkpoint
  const stackInfo = {
    stackId: checkpoint.stackId,
    stackName: checkpoint.stackName,
    parameters: checkpoint.parameters,
    outputs: undefined as Array<{ OutputKey?: string; OutputValue?: string }> | undefined,
  };

  try {
    await executeMutationSteps(
      client, options, stackInfo, originalTemplate, originalTemplateBody,
      allDriftedResources, decisions, allImportable, logicalIdsToRemove,
      capabilities, checkpoint, log,
      nextStep, resumeState,
    );

    result.success = true;
    result.remediatedResources = allImportable.map((r) => r.LogicalResourceId);
    result.removedResources = decisions.remove.map((r: DriftedResource) => r.logicalResourceId);

    if (options.verbose) {
      console.log(`Remediation resumed and completed. Recovery checkpoint can be removed: ${checkpoint.checkpointPath}`);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'step' in error) {
      const stepError = error as StepError;
      result.stepError = stepError;
      result.errors.push(`${STEP_DESCRIPTIONS[stepError.step]} failed: ${stepError.message}`);
    } else {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  } finally {
    await client.cleanupTemplates();
  }

  return result;
}

interface PreflightResult {
  warnings: PreflightWarning[];
  blockedDeletedResourceIds: string[];
}

/**
 * Run pre-flight checks on cascade dependency resource types using CloudControl DescribeType.
 * Returns warnings for types that don't support CloudControl read operations, and
 * logical IDs of DELETED resources whose cascade deps lack CloudControl read support
 * (these must be skipped to prevent data loss).
 */
async function runPreflightCheck(
  client: CfnClientWrapper,
  cascadeRemovals: Array<{ logicalResourceId: string; resourceType: string; dependsOn: string }>,
  allDriftedResources: DriftedResource[],
  logicalIdsToRemove: Set<string>,
): Promise<PreflightResult> {
  // Collect unique resource types from cascade deps of DELETED resources
  const deletedLogicalIds = new Set(
    allDriftedResources
      .filter((r) => r.stackResourceDriftStatus === 'DELETED' && logicalIdsToRemove.has(r.logicalResourceId))
      .map((r) => r.logicalResourceId),
  );

  // Map: cascade dep type → whether it's safe (has read handler)
  const cascadeDepTypes = new Set<string>();
  for (const c of cascadeRemovals) {
    if (deletedLogicalIds.has(c.dependsOn)) {
      cascadeDepTypes.add(c.resourceType);
    }
  }

  if (cascadeDepTypes.size === 0) return { warnings: [], blockedDeletedResourceIds: [] };

  const warnings: PreflightWarning[] = [];
  const unsafeTypes = new Set<string>();

  for (const typeName of cascadeDepTypes) {
    const typeInfo = await client.describeResourceType(typeName);
    if (!typeInfo) {
      warnings.push({
        resourceType: typeName,
        reason: 'Could not describe resource type (may not be registered in CloudFormation registry)',
      });
      unsafeTypes.add(typeName);
    } else if (typeInfo.provisioningType === 'NON_PROVISIONABLE') {
      warnings.push({
        resourceType: typeName,
        reason: 'NON_PROVISIONABLE type — CloudControl operations not supported',
      });
      unsafeTypes.add(typeName);
    } else if (!typeInfo.hasReadHandler) {
      warnings.push({
        resourceType: typeName,
        reason: 'No read handler — actual resource properties cannot be retrieved',
      });
      unsafeTypes.add(typeName);
    }
  }

  // Identify DELETED resources whose cascade deps include unsafe types
  const blockedDeletedResourceIds: string[] = [];
  if (unsafeTypes.size > 0) {
    for (const deletedId of deletedLogicalIds) {
      const depsOfDeleted = cascadeRemovals.filter((c) => c.dependsOn === deletedId);
      const hasUnsafeDep = depsOfDeleted.some((c) => unsafeTypes.has(c.resourceType));
      if (hasUnsafeDep) {
        blockedDeletedResourceIds.push(deletedId);
      }
    }
  }

  return { warnings, blockedDeletedResourceIds };
}
