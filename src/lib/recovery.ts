import * as fs from 'fs';
import * as path from 'path';
import {
  RecoveryCheckpoint,
  RemediationStep,
  StepError,
  STEP_STATE_AFTER_FAILURE,
} from './types';

/**
 * Save a recovery checkpoint to disk.
 */
export function saveCheckpoint(checkpoint: RecoveryCheckpoint): void {
  const filePath = checkpoint.checkpointPath;
  if (!filePath) {
    throw new Error('Cannot save checkpoint: checkpointPath is not set');
  }
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Load and validate a recovery checkpoint from disk.
 * Validates that the file exists, is a v2 checkpoint, and matches the expected stack name.
 */
export function loadCheckpoint(filePath: string, stackName: string): RecoveryCheckpoint {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Checkpoint file not found: ${resolved}`);
  }

  let checkpoint: RecoveryCheckpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse checkpoint file: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate required fields
  if (!checkpoint.stackName || !checkpoint.stackId || !checkpoint.originalTemplateBody) {
    throw new Error('Invalid checkpoint file: missing required fields (stackName, stackId, originalTemplateBody)');
  }

  // Validate v2 checkpoint (must have lastCompletedStep for resume)
  if (checkpoint.checkpointVersion !== 2 || checkpoint.lastCompletedStep === undefined) {
    throw new Error(
      'This checkpoint was created before --resume support was added.\n'
      + 'It can still be used for manual recovery (original template is preserved),\n'
      + 'but automatic resume is not possible. Re-run without --resume to start fresh.',
    );
  }

  // Validate stack name matches
  if (checkpoint.stackName !== stackName) {
    throw new Error(
      `Checkpoint stack name mismatch: checkpoint is for "${checkpoint.stackName}" but you specified "${stackName}"`,
    );
  }

  // Restore the checkpoint path
  checkpoint.checkpointPath = resolved;

  return checkpoint;
}

/**
 * Build a structured StepError with recovery guidance for the given failed step.
 */
export function buildStepError(
  step: RemediationStep,
  error: Error,
  checkpoint: RecoveryCheckpoint,
): StepError {
  const guidance = buildRecoveryGuidance(step, checkpoint);

  return {
    step,
    message: error.message,
    stackState: STEP_STATE_AFTER_FAILURE[step],
    guidance,
  };
}

function buildRecoveryGuidance(step: RemediationStep, checkpoint: RecoveryCheckpoint): string[] {
  const lines: string[] = [];
  const resumeCmd = checkpoint.checkpointPath
    ? `cfn-drift-remediate ${checkpoint.stackName} --resume ${checkpoint.checkpointPath}`
    : `cfn-drift-remediate ${checkpoint.stackName} --resume <checkpoint-file>`;

  // First line is always the resume command
  lines.push(`To retry from where it left off:\n  ${resumeCmd}`);

  // Always include event tailing guidance
  lines.push(
    'View failed resource events:\n'
    + `  aws cloudformation describe-stack-events --stack-name ${checkpoint.stackName} `
    + "--query 'StackEvents[?contains(ResourceStatus,`FAILED`)].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' "
    + '--output table',
  );

  switch (step) {
    case RemediationStep.RETAIN_AND_REMOVE_DELETED:
      lines.push(
        'Check stack status:\n'
        + `  aws cloudformation describe-stacks --stack-name ${checkpoint.stackName} --query 'Stacks[0].StackStatus'`,
      );
      lines.push(
        'If stack is in *_COMPLETE state, retry with --resume.',
      );
      lines.push(
        'If stack rolled back, restore the original template from the checkpoint file:\n'
        + `  aws cloudformation update-stack --stack-name ${checkpoint.stackName} --template-body file://<(jq -r .originalTemplateBody ${checkpoint.checkpointPath || '<checkpoint-file>'})`,
      );
      break;

    case RemediationStep.RESOLVE_REFERENCES:
      lines.push(
        'All resources have DeletionPolicy:Retain. Retry with --resume is safe.',
      );
      lines.push(
        'Temporary resolution Outputs (if any) are harmless and will be cleaned up on retry.',
      );
      break;

    case RemediationStep.REMOVE_MODIFIED:
      lines.push(
        'All resources have DeletionPolicy:Retain. Retry with --resume is safe.',
      );
      break;

    case RemediationStep.IMPORT_RESOURCES:
      lines.push(
        'Resources have been removed from the stack but still exist in AWS (DeletionPolicy:Retain).',
      );
      lines.push(
        'Check stack status:\n'
        + `  aws cloudformation describe-stacks --stack-name ${checkpoint.stackName} --query 'Stacks[0].StackStatus'`,
      );
      lines.push(
        'If IMPORT_ROLLBACK_COMPLETE or *_COMPLETE, retry with --resume to re-attempt the import.',
      );
      break;

    case RemediationStep.RESTORE_TEMPLATE:
      lines.push(
        'Import succeeded! Only the final template restore failed.',
      );
      lines.push(
        'Retry with --resume, or manually restore the original template:\n'
        + `  aws cloudformation update-stack --stack-name ${checkpoint.stackName} --template-body file://<(jq -r .originalTemplateBody ${checkpoint.checkpointPath || '<checkpoint-file>'})`,
      );
      break;
  }

  return lines;
}
