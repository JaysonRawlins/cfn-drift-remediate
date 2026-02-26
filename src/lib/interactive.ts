import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  CascadeRemoval,
  DriftedResource,
  InteractiveDecisions,
  ResourceAction,
  PropertyDifference,
} from './types';

const REMOVE_WARNING =
  'Note: Also remove this resource from your source template (CDK/CFN) to prevent it being recreated on next deploy.';

/**
 * Format property-level drift as a colored diff for display.
 */
export function formatDriftDiff(diffs: PropertyDifference[]): string {
  const lines: string[] = [];
  for (const diff of diffs) {
    const path = chalk.dim(diff.propertyPath);
    switch (diff.differenceType) {
      case 'NOT_EQUAL':
        lines.push(`    ${path}: ${chalk.red(diff.expectedValue)} -> ${chalk.green(diff.actualValue)}`);
        break;
      case 'ADD':
        lines.push(`    ${chalk.green('+')} ${path}: ${chalk.green(diff.actualValue)}`);
        break;
      case 'REMOVE':
        lines.push(`    ${chalk.red('-')} ${path}: ${chalk.red(diff.expectedValue)}`);
        break;
    }
  }
  return lines.join('\n');
}

/**
 * Prompt the user for a single MODIFIED resource.
 */
export async function promptModifiedResource(
  resource: DriftedResource,
  index: number,
  total: number,
): Promise<ResourceAction> {
  console.log(chalk.bold(`\n[${index + 1}/${total}] ${resource.logicalResourceId}`));
  console.log(`  Type: ${resource.resourceType}`);
  console.log(`  Status: ${chalk.yellow('MODIFIED')}`);
  console.log(`  Physical ID: ${resource.physicalResourceId}`);

  if (resource.propertyDifferences && resource.propertyDifferences.length > 0) {
    console.log(chalk.dim('  Changes:'));
    console.log(formatDriftDiff(resource.propertyDifferences));
  }

  const action = await select<string>({
    message: 'Action:',
    default: 'autofix',
    choices: [
      { name: 'Autofix - reimport with actual AWS state', value: 'autofix' },
      { name: 'Skip - leave drift as-is', value: 'skip' },
      { name: 'Remove from stack - stop managing this resource', value: 'remove' },
    ],
  });

  if (action === 'remove') {
    console.log(chalk.yellow(`  ${REMOVE_WARNING}`));
  }

  switch (action) {
    case 'autofix': return { kind: 'autofix' };
    case 'skip': return { kind: 'skip' };
    case 'remove': return { kind: 'remove' };
    default: return { kind: 'autofix' };
  }
}

/**
 * Prompt the user for a single DELETED resource.
 */
export async function promptDeletedResource(
  resource: DriftedResource,
  index: number,
  total: number,
): Promise<ResourceAction> {
  console.log(chalk.bold(`\n[${index + 1}/${total}] ${resource.logicalResourceId}`));
  console.log(`  Type: ${resource.resourceType}`);
  console.log(`  Status: ${chalk.red('DELETED')}`);
  console.log(`  Former Physical ID: ${resource.physicalResourceId}`);

  const action = await select<string>({
    message: 'Action:',
    default: 'remove',
    choices: [
      { name: 'Remove from stack - accept deletion', value: 'remove' },
      { name: 'Re-import - provide resource name, ID, or ARN', value: 'reimport' },
      { name: 'Skip - leave as-is (stack stays drifted)', value: 'skip' },
    ],
  });

  if (action === 'reimport') {
    const physicalId = await input({
      message: `Enter resource name, ID, or ARN for ${resource.logicalResourceId} (${resource.resourceType}):`,
      validate: (val: string) => val.trim().length > 0 || 'Resource identifier is required',
    });
    return { kind: 'reimport', physicalId: physicalId.trim() };
  }

  if (action === 'remove') {
    console.log(chalk.yellow(`  ${REMOVE_WARNING}`));
  }

  switch (action) {
    case 'remove': return { kind: 'remove' };
    case 'skip': return { kind: 'skip' };
    default: return { kind: 'remove' };
  }
}

/**
 * Print a summary of planned actions and ask for final confirmation.
 */
export async function confirmActions(decisions: InteractiveDecisions): Promise<boolean> {
  console.log(chalk.bold('\nPlanned actions:'));
  if (decisions.autofix.length > 0) {
    console.log(chalk.green(`  Autofix: ${decisions.autofix.length} resource(s)`));
    for (const r of decisions.autofix) {
      console.log(chalk.dim(`    - ${r.logicalResourceId} (${r.resourceType})`));
    }
  }
  if (decisions.reimport.length > 0) {
    console.log(chalk.cyan(`  Re-import: ${decisions.reimport.length} resource(s)`));
    for (const { resource, physicalId } of decisions.reimport) {
      console.log(chalk.dim(`    - ${resource.logicalResourceId} -> ${physicalId}`));
    }
  }
  if (decisions.remove.length > 0) {
    console.log(chalk.red(`  Remove: ${decisions.remove.length} resource(s)`));
    for (const r of decisions.remove) {
      console.log(chalk.dim(`    - ${r.logicalResourceId} (${r.resourceType})`));
    }
  }
  if (decisions.skip.length > 0) {
    console.log(chalk.dim(`  Skip: ${decisions.skip.length} resource(s)`));
  }

  const actionCount = decisions.autofix.length + decisions.reimport.length + decisions.remove.length;
  if (actionCount === 0) {
    return false;
  }

  return confirm({
    message: `Proceed with ${actionCount} action(s)?`,
    default: true,
  });
}

/**
 * Display a warning about resources that will be cascade-removed
 * because they reference resources being removed.
 */
export function displayCascadeWarning(cascadeRemovals: CascadeRemoval[]): void {
  if (cascadeRemovals.length === 0) return;

  console.log(chalk.bold.yellow(
    `\nWarning: ${cascadeRemovals.length} additional resource(s) will be removed from the stack due to broken references:`,
  ));

  for (const removal of cascadeRemovals) {
    console.log(chalk.yellow(
      `  - ${removal.logicalResourceId} (${removal.resourceType})` +
      chalk.dim(` references removed resource ${removal.dependsOn}`),
    ));
  }

  console.log(chalk.dim(
    '\nThese resources have Ref/GetAtt references to resources being removed and cannot remain in the stack.\n',
  ));
}

/**
 * Run the full interactive prompt flow for all drifted resources.
 * When `autoAccept` is true, returns default actions without prompting.
 */
export async function promptForDecisions(
  modifiedResources: DriftedResource[],
  deletedResources: DriftedResource[],
  autoAccept: boolean,
): Promise<InteractiveDecisions> {
  const decisions: InteractiveDecisions = {
    autofix: [],
    reimport: [],
    remove: [],
    skip: [],
  };

  const totalCount = modifiedResources.length + deletedResources.length;

  // Non-TTY guard
  if (!autoAccept && typeof process !== 'undefined' && process.stdin && !process.stdin.isTTY) {
    throw new Error('Interactive mode requires a terminal. Use --yes (-y) for non-interactive mode.');
  }

  if (!autoAccept && totalCount > 0) {
    console.log(chalk.bold(`\nFound ${totalCount} drifted resource(s). Choose an action for each:\n`));
  }

  let idx = 0;

  for (const resource of modifiedResources) {
    if (autoAccept) {
      decisions.autofix.push(resource);
    } else {
      const action = await promptModifiedResource(resource, idx, totalCount);
      switch (action.kind) {
        case 'autofix': decisions.autofix.push(resource); break;
        case 'skip': decisions.skip.push(resource); break;
        case 'remove': decisions.remove.push(resource); break;
      }
    }
    idx++;
  }

  for (const resource of deletedResources) {
    if (autoAccept) {
      decisions.remove.push(resource);
    } else {
      const action = await promptDeletedResource(resource, idx, totalCount);
      switch (action.kind) {
        case 'remove': decisions.remove.push(resource); break;
        case 'reimport':
          decisions.reimport.push({ resource, physicalId: (action as { kind: 'reimport'; physicalId: string }).physicalId });
          break;
        case 'skip': decisions.skip.push(resource); break;
      }
    }
    idx++;
  }

  // Show summary and confirm (unless auto-accepting)
  if (!autoAccept) {
    const confirmed = await confirmActions(decisions);
    if (!confirmed) {
      // User cancelled — move everything to skip
      return {
        autofix: [],
        reimport: [],
        remove: [],
        skip: [...modifiedResources, ...deletedResources],
      };
    }
  }

  return decisions;
}
