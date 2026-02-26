// chalk v5 is ESM-only — mock it so Jest can load interactive.ts
const passthrough = (s: string) => s;
jest.mock('chalk', () => ({
  __esModule: true,
  default: Object.assign(passthrough, {
    red: passthrough,
    green: passthrough,
    yellow: passthrough,
    cyan: passthrough,
    dim: passthrough,
    bold: Object.assign(passthrough, {
      yellow: passthrough,
      red: passthrough,
    }),
  }),
}));

jest.mock('@inquirer/prompts', () => ({
  select: jest.fn(),
  input: jest.fn(),
  confirm: jest.fn(),
}));

import { select, input, confirm } from '@inquirer/prompts';
import { displayCascadeWarning, formatDriftDiff, promptForDecisions } from '../src/lib/interactive';
import { DriftedResource, PropertyDifference } from '../src/lib/types';

const mockSelect = select as jest.MockedFunction<typeof select>;
const mockInput = input as jest.MockedFunction<typeof input>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;

const MODIFIED_RESOURCE: DriftedResource = {
  logicalResourceId: 'MyBucket',
  resourceType: 'AWS::S3::Bucket',
  physicalResourceId: 'my-bucket',
  stackResourceDriftStatus: 'MODIFIED',
  propertyDifferences: [
    {
      propertyPath: '/Tags/0/Value',
      expectedValue: '"old-value"',
      actualValue: '"new-value"',
      differenceType: 'NOT_EQUAL',
    },
  ],
};

const DELETED_RESOURCE: DriftedResource = {
  logicalResourceId: 'OldQueue',
  resourceType: 'AWS::SQS::Queue',
  physicalResourceId: 'https://sqs.us-east-1.amazonaws.com/123/old-queue',
  stackResourceDriftStatus: 'DELETED',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation();
  // Simulate a TTY so the non-TTY guard doesn't throw
  Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
});

afterEach(() => {
  (console.log as jest.Mock).mockRestore();
});

describe('formatDriftDiff', () => {
  it('should format NOT_EQUAL differences', () => {
    const diffs: PropertyDifference[] = [
      {
        propertyPath: '/Tags/0/Value',
        expectedValue: '"old"',
        actualValue: '"new"',
        differenceType: 'NOT_EQUAL',
      },
    ];
    const output = formatDriftDiff(diffs);
    expect(output).toContain('/Tags/0/Value');
    expect(output).toContain('"old"');
    expect(output).toContain('"new"');
  });

  it('should format ADD differences', () => {
    const diffs: PropertyDifference[] = [
      {
        propertyPath: '/NewProp',
        expectedValue: '',
        actualValue: '"added"',
        differenceType: 'ADD',
      },
    ];
    const output = formatDriftDiff(diffs);
    expect(output).toContain('+');
    expect(output).toContain('"added"');
  });

  it('should format REMOVE differences', () => {
    const diffs: PropertyDifference[] = [
      {
        propertyPath: '/OldProp',
        expectedValue: '"removed"',
        actualValue: '',
        differenceType: 'REMOVE',
      },
    ];
    const output = formatDriftDiff(diffs);
    expect(output).toContain('-');
    expect(output).toContain('"removed"');
  });

  it('should format multiple differences', () => {
    const diffs: PropertyDifference[] = [
      { propertyPath: '/A', expectedValue: '"1"', actualValue: '"2"', differenceType: 'NOT_EQUAL' },
      { propertyPath: '/B', expectedValue: '', actualValue: '"3"', differenceType: 'ADD' },
    ];
    const output = formatDriftDiff(diffs);
    expect(output).toContain('/A');
    expect(output).toContain('/B');
  });
});

describe('promptForDecisions', () => {
  it('should auto-accept defaults when autoAccept is true', async () => {
    const decisions = await promptForDecisions([MODIFIED_RESOURCE], [DELETED_RESOURCE], true);

    expect(decisions.autofix).toHaveLength(1);
    expect(decisions.autofix[0].logicalResourceId).toBe('MyBucket');
    expect(decisions.remove).toHaveLength(1);
    expect(decisions.remove[0].logicalResourceId).toBe('OldQueue');
    expect(decisions.reimport).toHaveLength(0);
    expect(decisions.skip).toHaveLength(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('should prompt for MODIFIED and use autofix choice', async () => {
    mockSelect.mockResolvedValueOnce('autofix');
    mockConfirm.mockResolvedValueOnce(true);

    const decisions = await promptForDecisions([MODIFIED_RESOURCE], [], false);

    expect(decisions.autofix).toHaveLength(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('should prompt for DELETED and handle remove choice', async () => {
    mockSelect.mockResolvedValueOnce('remove');
    mockConfirm.mockResolvedValueOnce(true);

    const decisions = await promptForDecisions([], [DELETED_RESOURCE], false);

    expect(decisions.remove).toHaveLength(1);
    expect(decisions.remove[0].logicalResourceId).toBe('OldQueue');
  });

  it('should handle reimport with ARN input', async () => {
    mockSelect.mockResolvedValueOnce('reimport');
    mockInput.mockResolvedValueOnce('arn:aws:sqs:us-east-1:123:new-queue');
    mockConfirm.mockResolvedValueOnce(true);

    const decisions = await promptForDecisions([], [DELETED_RESOURCE], false);

    expect(decisions.reimport).toHaveLength(1);
    expect(decisions.reimport[0].physicalId).toBe('arn:aws:sqs:us-east-1:123:new-queue');
    expect(decisions.reimport[0].resource.logicalResourceId).toBe('OldQueue');
  });

  it('should handle mixed actions across multiple resources', async () => {
    const modified2: DriftedResource = {
      logicalResourceId: 'MyFunc',
      resourceType: 'AWS::Lambda::Function',
      physicalResourceId: 'my-func',
      stackResourceDriftStatus: 'MODIFIED',
    };

    // First MODIFIED: autofix, Second MODIFIED: skip, DELETED: remove
    mockSelect
      .mockResolvedValueOnce('autofix')
      .mockResolvedValueOnce('skip')
      .mockResolvedValueOnce('remove');
    mockConfirm.mockResolvedValueOnce(true);

    const decisions = await promptForDecisions(
      [MODIFIED_RESOURCE, modified2],
      [DELETED_RESOURCE],
      false,
    );

    expect(decisions.autofix).toHaveLength(1);
    expect(decisions.skip).toHaveLength(1);
    expect(decisions.remove).toHaveLength(1);
  });

  it('should move all to skip when user declines confirmation', async () => {
    mockSelect.mockResolvedValueOnce('autofix');
    mockConfirm.mockResolvedValueOnce(false);

    const decisions = await promptForDecisions([MODIFIED_RESOURCE], [], false);

    expect(decisions.autofix).toHaveLength(0);
    expect(decisions.skip).toHaveLength(1);
    expect(decisions.skip[0].logicalResourceId).toBe('MyBucket');
  });

  it('should return empty decisions for empty input', async () => {
    const decisions = await promptForDecisions([], [], true);

    expect(decisions.autofix).toHaveLength(0);
    expect(decisions.reimport).toHaveLength(0);
    expect(decisions.remove).toHaveLength(0);
    expect(decisions.skip).toHaveLength(0);
  });
});

describe('displayCascadeWarning', () => {
  it('should not print anything when both lists are empty', () => {
    displayCascadeWarning([], []);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('should display permanent cascade removal details', () => {
    displayCascadeWarning([
      {
        logicalResourceId: 'SGIngress',
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        dependsOn: 'DB',
      },
    ], []);
    expect(console.log).toHaveBeenCalled();
    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toContain('SGIngress');
    expect(output).toContain('DB');
    expect(output).toContain('permanently removed');
  });

  it('should display temporary cascade removal details', () => {
    displayCascadeWarning([], [
      {
        logicalResourceId: 'TargetGroup',
        resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        dependsOn: 'WebServer',
      },
    ]);
    expect(console.log).toHaveBeenCalled();
    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toContain('TargetGroup');
    expect(output).toContain('temporarily removed from the stack');
  });

  it('should display both permanent and temporary removals', () => {
    displayCascadeWarning(
      [{
        logicalResourceId: 'SGIngress',
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        dependsOn: 'DB',
      }],
      [{
        logicalResourceId: 'LambdaPerm',
        resourceType: 'AWS::Lambda::Permission',
        dependsOn: 'Function',
      }],
    );
    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toContain('permanently removed');
    expect(output).toContain('temporarily removed from the stack');
    expect(output).toContain('SGIngress');
    expect(output).toContain('LambdaPerm');
  });
});
