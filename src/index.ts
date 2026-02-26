#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { program } from 'commander';
import ora from 'ora';
import { remediate } from './cli';

// Get version from package.json
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

program
  .name('cfn-drift-remediate')
  .description('Remediate CloudFormation stack drift by re-importing drifted resources with their actual state')
  .version(packageJson.version);

program
  .argument('<stack-name>', 'Name or ID of the CloudFormation stack')
  .option('-r, --region <region>', 'AWS region (defaults to AWS_REGION env var)')
  .option('-p, --profile <profile>', 'AWS profile to use (defaults to AWS_PROFILE env var)')
  .option('--dry-run', 'Show what would be done without making changes', false)
  .option('-y, --yes', 'Skip interactive prompts, accept defaults', false)
  .option('-v, --verbose', 'Enable verbose output', false)
  .option('--export-plan <file>', 'Export remediation plan to file without executing')
  .option('--apply-plan <file>', 'Apply a previously exported remediation plan')
  .action(async (stackName: string, options: {
    region?: string;
    profile?: string;
    dryRun: boolean;
    yes: boolean;
    verbose: boolean;
    exportPlan?: string;
    applyPlan?: string;
  }) => {
    if (options.exportPlan && options.applyPlan) {
      console.error(chalk.red('Error: --export-plan and --apply-plan are mutually exclusive'));
      process.exit(1);
    }

    const spinner = ora('Starting drift remediation...').start();

    try {
      const result = await remediate(
        {
          stackName,
          region: options.region,
          profile: options.profile,
          dryRun: options.dryRun,
          yes: options.yes,
          verbose: options.verbose,
          exportPlan: options.exportPlan,
          applyPlan: options.applyPlan,
        },
        spinner,
      );

      if (result.success) {
        if (options.exportPlan) {
          // spinner.succeed already called in remediate() — nothing more to print
        } else if (result.remediatedResources.length > 0 || result.removedResources.length > 0) {
          spinner.succeed(chalk.green('Drift remediation completed successfully!'));
          if (result.remediatedResources.length > 0) {
            console.log(chalk.cyan('\nRemediated resources:'));
            for (const resource of result.remediatedResources) {
              console.log(chalk.cyan(`  - ${resource}`));
            }
          }
          if (result.removedResources.length > 0) {
            console.log(chalk.yellow('\nRemoved from stack (still exist in AWS):'));
            for (const resource of result.removedResources) {
              console.log(chalk.yellow(`  - ${resource}`));
            }
          }
        } else {
          spinner.succeed(chalk.green('Stack is already in sync - no remediation needed'));
        }

        if (result.skippedResources.length > 0) {
          console.log(chalk.yellow('\nSkipped resources:'));
          for (const resource of result.skippedResources) {
            console.log(chalk.yellow(`  - ${resource}`));
          }
        }
      } else {
        spinner.fail(chalk.red('Drift remediation failed'));
        for (const error of result.errors) {
          console.error(chalk.red(`  - ${error}`));
        }
        process.exit(1);
      }
    } catch (error) {
      // Handle Ctrl+C during interactive prompts
      if (error instanceof Error && error.name === 'ExitPromptError') {
        spinner.stop();
        console.log(chalk.yellow('\nAborted by user'));
        process.exit(130);
      }
      spinner.fail(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
      process.exit(1);
    }
  });

program.parse();

// Export library functions for programmatic use
export { remediate } from './cli';
export { CfnClientWrapper } from './lib/cfn-client';
export * from './lib/types';
export * from './lib/eligible-resources';
export * from './lib/template-transformer';
export * from './lib/resource-importer';
export * from './lib/resource-identifier';
export { promptForDecisions, formatDriftDiff, displayCascadeWarning } from './lib/interactive';
export { buildPlan, serializePlan, loadPlan, planToDecisions } from './lib/plan';
