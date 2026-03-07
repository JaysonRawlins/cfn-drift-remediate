import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveCheckpoint, loadCheckpoint, buildStepError } from '../src/lib/recovery';
import {
  RecoveryCheckpoint,
  RemediationStep,
  STEP_STATE_AFTER_FAILURE,
} from '../src/lib/types';

describe('recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeV2Checkpoint = (overrides?: Partial<RecoveryCheckpoint>): RecoveryCheckpoint => ({
    stackName: 'TestStack',
    stackId: 'arn:aws:cloudformation:us-east-2:123456789012:stack/TestStack/abc123',
    originalTemplateBody: JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        MyBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'test-bucket' } },
      },
    }),
    parameters: [{ ParameterKey: 'Env', ParameterValue: 'test' }],
    driftedResourceIds: ['MyBucket'],
    timestamp: '2026-03-04T12:00:00.000Z',
    checkpointVersion: 2,
    lastCompletedStep: RemediationStep.RETAIN_AND_REMOVE_DELETED,
    capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
    checkpointPath: path.join(tmpDir, 'checkpoint.json'),
    ...overrides,
  });

  describe('saveCheckpoint / loadCheckpoint round-trip', () => {
    it('round-trips all v2 checkpoint fields', () => {
      const checkpoint = makeV2Checkpoint({
        retainTemplateBody: '{"Resources":{}}',
        resolvedValuesJson: JSON.stringify([['Ref:MyBucket', 'test-bucket']]),
        removalTemplateBody: '{"Resources":{}}',
        importComplete: true,
        decisionsJson: JSON.stringify({ autofix: [], reimport: [], remove: [], skip: [] }),
        resourcesToImportJson: JSON.stringify([]),
      });

      saveCheckpoint(checkpoint);

      const loaded = loadCheckpoint(checkpoint.checkpointPath!, 'TestStack');

      expect(loaded.stackName).toBe('TestStack');
      expect(loaded.stackId).toContain('arn:aws:cloudformation');
      expect(loaded.checkpointVersion).toBe(2);
      expect(loaded.lastCompletedStep).toBe(RemediationStep.RETAIN_AND_REMOVE_DELETED);
      expect(loaded.retainTemplateBody).toBe('{"Resources":{}}');
      expect(loaded.resolvedValuesJson).toBeTruthy();
      expect(loaded.removalTemplateBody).toBe('{"Resources":{}}');
      expect(loaded.importComplete).toBe(true);
      expect(loaded.capabilities).toEqual(['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']);
      expect(loaded.decisionsJson).toBeTruthy();
      expect(loaded.resourcesToImportJson).toBeTruthy();
    });

    it('preserves original template body through round-trip', () => {
      const checkpoint = makeV2Checkpoint();
      saveCheckpoint(checkpoint);

      const loaded = loadCheckpoint(checkpoint.checkpointPath!, 'TestStack');
      const template = JSON.parse(loaded.originalTemplateBody);
      expect(template.Resources.MyBucket.Type).toBe('AWS::S3::Bucket');
    });
  });

  describe('loadCheckpoint validation', () => {
    it('throws for non-existent file', () => {
      expect(() => loadCheckpoint('/nonexistent/path.json', 'TestStack'))
        .toThrow('Checkpoint file not found');
    });

    it('throws for invalid JSON', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, 'not json');

      expect(() => loadCheckpoint(filePath, 'TestStack'))
        .toThrow('Failed to parse checkpoint file');
    });

    it('throws for missing required fields', () => {
      const filePath = path.join(tmpDir, 'empty.json');
      fs.writeFileSync(filePath, JSON.stringify({ foo: 'bar' }));

      expect(() => loadCheckpoint(filePath, 'TestStack'))
        .toThrow('missing required fields');
    });

    it('rejects v1 checkpoints (no checkpointVersion or lastCompletedStep)', () => {
      const v1Checkpoint = {
        stackName: 'TestStack',
        stackId: 'arn:aws:cloudformation:us-east-2:123456789012:stack/TestStack/abc123',
        originalTemplateBody: '{}',
        parameters: [],
        driftedResourceIds: [],
        timestamp: '2026-03-04T12:00:00.000Z',
      };
      const filePath = path.join(tmpDir, 'v1.json');
      fs.writeFileSync(filePath, JSON.stringify(v1Checkpoint));

      expect(() => loadCheckpoint(filePath, 'TestStack'))
        .toThrow('before --resume support was added');
    });

    it('rejects mismatched stack name', () => {
      const checkpoint = makeV2Checkpoint();
      saveCheckpoint(checkpoint);

      expect(() => loadCheckpoint(checkpoint.checkpointPath!, 'OtherStack'))
        .toThrow('stack name mismatch');
    });

    it('restores checkpointPath on load', () => {
      const checkpoint = makeV2Checkpoint();
      saveCheckpoint(checkpoint);

      const loaded = loadCheckpoint(checkpoint.checkpointPath!, 'TestStack');
      expect(loaded.checkpointPath).toBe(path.resolve(checkpoint.checkpointPath!));
    });
  });

  describe('buildStepError', () => {
    it.each([
      RemediationStep.RETAIN_AND_REMOVE_DELETED,
      RemediationStep.RESOLVE_REFERENCES,
      RemediationStep.REMOVE_MODIFIED,
      RemediationStep.IMPORT_RESOURCES,
      RemediationStep.RESTORE_TEMPLATE,
    ])('produces correct structure for step %s', (step) => {
      const checkpoint = makeV2Checkpoint({ lastCompletedStep: step });
      const error = new Error('Something went wrong');

      const stepError = buildStepError(step, error, checkpoint);

      expect(stepError.step).toBe(step);
      expect(stepError.message).toBe('Something went wrong');
      expect(stepError.stackState).toBe(STEP_STATE_AFTER_FAILURE[step]);
      expect(stepError.guidance.length).toBeGreaterThan(0);
    });

    it('includes --resume command in guidance for all steps', () => {
      for (const step of [
        RemediationStep.RETAIN_AND_REMOVE_DELETED,
        RemediationStep.RESOLVE_REFERENCES,
        RemediationStep.REMOVE_MODIFIED,
        RemediationStep.IMPORT_RESOURCES,
        RemediationStep.RESTORE_TEMPLATE,
      ]) {
        const checkpoint = makeV2Checkpoint({ lastCompletedStep: step });
        const stepError = buildStepError(step, new Error('fail'), checkpoint);

        const hasResumeCmd = stepError.guidance.some((g) => g.includes('--resume'));
        expect(hasResumeCmd).toBe(true);
      }
    });

    it('includes stack-specific AWS CLI commands in guidance', () => {
      const checkpoint = makeV2Checkpoint();

      // Step 6 should have describe-stacks guidance
      const step6Error = buildStepError(RemediationStep.RETAIN_AND_REMOVE_DELETED, new Error('fail'), checkpoint);
      expect(step6Error.guidance.some((g) => g.includes('describe-stacks'))).toBe(true);

      // Step 9 should mention IMPORT_ROLLBACK_COMPLETE
      const step9Error = buildStepError(RemediationStep.IMPORT_RESOURCES, new Error('fail'), checkpoint);
      expect(step9Error.guidance.some((g) => g.includes('IMPORT_ROLLBACK_COMPLETE'))).toBe(true);

      // Step 10 should mention import succeeded
      const step10Error = buildStepError(RemediationStep.RESTORE_TEMPLATE, new Error('fail'), checkpoint);
      expect(step10Error.guidance.some((g) => g.includes('Import succeeded'))).toBe(true);
    });

    it('varies guidance per step', () => {
      const checkpoint = makeV2Checkpoint();
      const guidancePerStep = new Map<RemediationStep, string[]>();

      for (const step of [
        RemediationStep.RETAIN_AND_REMOVE_DELETED,
        RemediationStep.RESOLVE_REFERENCES,
        RemediationStep.REMOVE_MODIFIED,
        RemediationStep.IMPORT_RESOURCES,
        RemediationStep.RESTORE_TEMPLATE,
      ]) {
        const stepError = buildStepError(step, new Error('fail'), checkpoint);
        guidancePerStep.set(step, stepError.guidance);
      }

      // All steps should have different guidance content (beyond the resume command)
      const step6 = guidancePerStep.get(RemediationStep.RETAIN_AND_REMOVE_DELETED)!.join('\n');
      const step9 = guidancePerStep.get(RemediationStep.IMPORT_RESOURCES)!.join('\n');
      const step10 = guidancePerStep.get(RemediationStep.RESTORE_TEMPLATE)!.join('\n');

      expect(step6).not.toBe(step9);
      expect(step9).not.toBe(step10);
    });
  });

  describe('saveCheckpoint', () => {
    it('throws when checkpointPath is not set', () => {
      const checkpoint = makeV2Checkpoint({ checkpointPath: undefined });

      expect(() => saveCheckpoint(checkpoint)).toThrow('checkpointPath is not set');
    });
  });
});
