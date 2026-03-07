import { CfnClientWrapper } from '../src/lib/cfn-client';

// Mock S3 client
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const original = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...original,
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockS3Send,
    })),
  };
});

// Mock STS client
const mockStsSend = jest.fn();
jest.mock('@aws-sdk/client-sts', () => {
  const original = jest.requireActual('@aws-sdk/client-sts');
  return {
    ...original,
    STSClient: jest.fn().mockImplementation(() => ({
      send: mockStsSend,
    })),
  };
});

// Mock the CloudFormation SDK client
jest.mock('@aws-sdk/client-cloudformation', () => {
  const original = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...original,
    CloudFormationClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

// Speed up polling for tests
jest.mock('../src/lib/utils', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
  deepClone: jest.requireActual('../src/lib/utils').deepClone,
  Logger: jest.requireActual('../src/lib/utils').Logger,
}));

describe('CfnClientWrapper', () => {
  let client: CfnClientWrapper;
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new CfnClientWrapper({ region: 'us-east-1' });
    // Access the mock send method on the underlying CloudFormation client
    mockSend = (client as any).client.send;
  });

  describe('getStackInfo', () => {
    it('returns stackStatus from DescribeStacks', async () => {
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/my-stack/abc',
          StackName: 'my-stack',
          StackStatus: 'UPDATE_IN_PROGRESS',
          Parameters: [],
          Outputs: [],
        }],
      });

      const info = await client.getStackInfo('my-stack');

      expect(info.stackStatus).toBe('UPDATE_IN_PROGRESS');
      expect(info.stackName).toBe('my-stack');
    });

    it('returns stackStatus for stable states', async () => {
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/my-stack/abc',
          StackName: 'my-stack',
          StackStatus: 'UPDATE_COMPLETE',
          Parameters: [{ ParameterKey: 'Env', ParameterValue: 'prod' }],
          Outputs: [{ OutputKey: 'Url', OutputValue: 'https://example.com' }],
        }],
      });

      const info = await client.getStackInfo('my-stack');

      expect(info.stackStatus).toBe('UPDATE_COMPLETE');
      expect(info.parameters).toEqual([{ ParameterKey: 'Env', ParameterValue: 'prod' }]);
      expect(info.outputs).toEqual([{ OutputKey: 'Url', OutputValue: 'https://example.com' }]);
    });
  });

  describe('waitForDriftDetection', () => {
    it('returns status and driftStatus on DETECTION_COMPLETE', async () => {
      mockSend.mockResolvedValueOnce({
        DetectionStatus: 'DETECTION_COMPLETE',
        StackDriftStatus: 'DRIFTED',
        DetectionStatusReason: undefined,
      });

      const result = await client.waitForDriftDetection('detection-123');

      expect(result.status).toBe('DETECTION_COMPLETE');
      expect(result.driftStatus).toBe('DRIFTED');
    });

    it('returns IN_SYNC driftStatus when stack has no drift', async () => {
      mockSend.mockResolvedValueOnce({
        DetectionStatus: 'DETECTION_COMPLETE',
        StackDriftStatus: 'IN_SYNC',
      });

      const result = await client.waitForDriftDetection('detection-123');

      expect(result.status).toBe('DETECTION_COMPLETE');
      expect(result.driftStatus).toBe('IN_SYNC');
    });

    it('returns status and statusReason on DETECTION_FAILED without throwing', async () => {
      mockSend.mockResolvedValueOnce({
        DetectionStatus: 'DETECTION_FAILED',
        StackDriftStatus: 'DRIFTED',
        DetectionStatusReason: 'Failed to detect drift on resources [BadResource]',
      });

      const result = await client.waitForDriftDetection('detection-123');

      expect(result.status).toBe('DETECTION_FAILED');
      expect(result.driftStatus).toBe('DRIFTED');
      expect(result.statusReason).toBe('Failed to detect drift on resources [BadResource]');
    });

    it('defaults statusReason to "Unknown reason" when not provided on failure', async () => {
      mockSend.mockResolvedValueOnce({
        DetectionStatus: 'DETECTION_FAILED',
        StackDriftStatus: 'UNKNOWN',
      });

      const result = await client.waitForDriftDetection('detection-123');

      expect(result.status).toBe('DETECTION_FAILED');
      expect(result.statusReason).toBe('Unknown reason');
    });

    it('polls until detection completes', async () => {
      mockSend
        .mockResolvedValueOnce({ DetectionStatus: 'DETECTION_IN_PROGRESS' })
        .mockResolvedValueOnce({ DetectionStatus: 'DETECTION_IN_PROGRESS' })
        .mockResolvedValueOnce({
          DetectionStatus: 'DETECTION_COMPLETE',
          StackDriftStatus: 'DRIFTED',
        });

      const result = await client.waitForDriftDetection('detection-123');

      expect(result.status).toBe('DETECTION_COMPLETE');
      expect(mockSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('getResourceIdentifiers', () => {
    it('uses StackName instead of TemplateBody to avoid size limits', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceIdentifierSummaries: [
          {
            ResourceType: 'AWS::S3::Bucket',
            ResourceIdentifiers: ['BucketName'],
          },
          {
            ResourceType: 'AWS::Lambda::Function',
            ResourceIdentifiers: ['FunctionName'],
          },
        ],
      });

      const result = await client.getResourceIdentifiers('my-stack');

      expect(result.get('AWS::S3::Bucket')).toEqual(['BucketName']);
      expect(result.get('AWS::Lambda::Function')).toEqual(['FunctionName']);

      // Verify StackName was used (not TemplateBody)
      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input).toEqual({ StackName: 'my-stack' });
    });
  });

  describe('getRecentStackEvents', () => {
    it('returns events filtered by sinceTimestamp', async () => {
      const now = new Date();
      const before = new Date(now.getTime() - 60000);
      const after = new Date(now.getTime() + 60000);

      mockSend.mockResolvedValueOnce({
        StackEvents: [
          {
            Timestamp: after,
            ResourceType: 'AWS::S3::Bucket',
            LogicalResourceId: 'MyBucket',
            ResourceStatus: 'UPDATE_FAILED',
            ResourceStatusReason: 'Access Denied',
          },
          {
            Timestamp: before,
            ResourceType: 'AWS::SQS::Queue',
            LogicalResourceId: 'MyQueue',
            ResourceStatus: 'UPDATE_COMPLETE',
          },
        ],
      });

      const events = await client.getRecentStackEvents('my-stack', now);

      expect(events).toHaveLength(1);
      expect(events[0].logicalResourceId).toBe('MyBucket');
      expect(events[0].resourceStatus).toBe('UPDATE_FAILED');
      expect(events[0].resourceStatusReason).toBe('Access Denied');
    });

    it('returns all events when no sinceTimestamp provided', async () => {
      mockSend.mockResolvedValueOnce({
        StackEvents: [
          {
            Timestamp: new Date(),
            ResourceType: 'AWS::S3::Bucket',
            LogicalResourceId: 'MyBucket',
            ResourceStatus: 'UPDATE_COMPLETE',
          },
          {
            Timestamp: new Date(),
            ResourceType: 'AWS::SQS::Queue',
            LogicalResourceId: 'MyQueue',
            ResourceStatus: 'UPDATE_COMPLETE',
          },
        ],
      });

      const events = await client.getRecentStackEvents('my-stack');
      expect(events).toHaveLength(2);
    });
  });

  describe('waitForStackUpdate', () => {
    it('includes failed resource events on rollback', async () => {
      const startTime = new Date();

      // First poll: UPDATE_ROLLBACK_COMPLETE
      mockSend
        .mockResolvedValueOnce({
          Stacks: [{
            StackStatus: 'UPDATE_ROLLBACK_COMPLETE',
            StackStatusReason: 'Resource update cancelled',
          }],
        })
        // DescribeStackEventsCommand for event tailing
        .mockResolvedValueOnce({
          StackEvents: [
            {
              Timestamp: new Date(startTime.getTime() + 1000),
              ResourceType: 'AWS::RDS::DBInstance',
              LogicalResourceId: 'Database',
              ResourceStatus: 'UPDATE_FAILED',
              ResourceStatusReason: 'Cannot modify a DBInstance while another is in state: modifying',
            },
            {
              Timestamp: new Date(startTime.getTime() + 2000),
              ResourceType: 'AWS::CloudFormation::Stack',
              LogicalResourceId: 'my-stack',
              ResourceStatus: 'UPDATE_ROLLBACK_COMPLETE',
            },
          ],
        });

      await expect(client.waitForStackUpdate('my-stack')).rejects.toThrow(
        /Stack update rolled back.*Database.*UPDATE_FAILED.*Cannot modify/s,
      );
    });

    it('includes failed resource events on *_FAILED status', async () => {
      const startTime = new Date();

      mockSend
        .mockResolvedValueOnce({
          Stacks: [{
            StackStatus: 'UPDATE_FAILED',
            StackStatusReason: 'Nested stack failed',
          }],
        })
        .mockResolvedValueOnce({
          StackEvents: [
            {
              Timestamp: new Date(startTime.getTime() + 1000),
              ResourceType: 'AWS::Lambda::Function',
              LogicalResourceId: 'MyFunction',
              ResourceStatus: 'CREATE_FAILED',
              ResourceStatusReason: 'Handler not found',
            },
          ],
        });

      await expect(client.waitForStackUpdate('my-stack')).rejects.toThrow(
        /Stack operation failed.*MyFunction.*CREATE_FAILED.*Handler not found/s,
      );
    });
  });

  describe('resolveTemplate (via updateStack)', () => {
    it('uses TemplateBody directly for small templates', async () => {
      const smallTemplate = '{"Resources":{}}';

      // Mock updateStack: CFN send succeeds, then stack check returns UPDATE_COMPLETE
      mockSend
        .mockResolvedValueOnce({}) // UpdateStackCommand
        .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] }); // DescribeStacksCommand

      await client.updateStack('my-stack', smallTemplate);

      // First call should be UpdateStackCommand with TemplateBody
      const updateCommand = mockSend.mock.calls[0][0];
      expect(updateCommand.input.TemplateBody).toBe(smallTemplate);
      expect(updateCommand.input.TemplateURL).toBeUndefined();
    });

    it('uploads to S3 and uses TemplateURL for large templates', async () => {
      const clientWithBucket = new CfnClientWrapper({
        region: 'us-east-1',
        s3BucketName: 'my-template-bucket',
      });
      const cfnMock = (clientWithBucket as any).client.send;

      const largeTemplate = 'x'.repeat(52_000);

      // Mock S3 PutObject
      mockS3Send.mockResolvedValueOnce({});

      // Mock CFN UpdateStack + DescribeStacks
      cfnMock
        .mockResolvedValueOnce({}) // UpdateStackCommand
        .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] }); // DescribeStacksCommand

      await clientWithBucket.updateStack('my-stack', largeTemplate);

      // S3 PutObject should have been called
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const s3Command = mockS3Send.mock.calls[0][0];
      expect(s3Command.input.Bucket).toBe('my-template-bucket');
      expect(s3Command.input.Key).toMatch(/^cfn-drift-remediate\//);
      expect(s3Command.input.Body).toBe(largeTemplate);

      // CFN UpdateStack should have TemplateURL, not TemplateBody
      const updateCommand = cfnMock.mock.calls[0][0];
      expect(updateCommand.input.TemplateURL).toMatch(/https:\/\/s3\.us-east-1\.amazonaws\.com\/my-template-bucket\//);
      expect(updateCommand.input.TemplateBody).toBeUndefined();
    });

    it('throws when template is large and no bucket available', async () => {
      const largeTemplate = 'x'.repeat(52_000);

      // Mock STS getCallerIdentity
      mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });
      // Mock S3 headBucket — bucket not found
      mockS3Send.mockRejectedValueOnce(new Error('NotFound'));

      await expect(client.updateStack('my-stack', largeTemplate))
        .rejects.toThrow('Template exceeds 51,200-byte CloudFormation limit');
    });

    it('auto-detects CDK bootstrap bucket', async () => {
      const clientNoBucket = new CfnClientWrapper({ region: 'us-west-2' });
      const cfnMock = (clientNoBucket as any).client.send;

      const largeTemplate = 'x'.repeat(52_000);

      // Mock STS getCallerIdentity
      mockStsSend.mockResolvedValueOnce({ Account: '111222333444' });
      // Mock S3 headBucket — bucket exists
      mockS3Send
        .mockResolvedValueOnce({}) // HeadBucketCommand
        .mockResolvedValueOnce({}); // PutObjectCommand

      // Mock CFN UpdateStack + DescribeStacks
      cfnMock
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] });

      await clientNoBucket.updateStack('my-stack', largeTemplate);

      // Verify CDK bootstrap bucket was used
      const putCommand = mockS3Send.mock.calls[1][0];
      expect(putCommand.input.Bucket).toBe('cdk-hnb659fds-assets-111222333444-us-west-2');
    });
  });

  describe('describeResourceType', () => {
    it('returns provisioningType and hasReadHandler for FULLY_MUTABLE type with read handler', async () => {
      mockSend.mockResolvedValueOnce({
        ProvisioningType: 'FULLY_MUTABLE',
        Schema: JSON.stringify({
          handlers: {
            create: {},
            read: {},
            update: {},
            delete: {},
          },
        }),
      });

      const result = await client.describeResourceType('AWS::S3::Bucket');

      expect(result).toEqual({
        provisioningType: 'FULLY_MUTABLE',
        hasReadHandler: true,
      });
    });

    it('returns hasReadHandler false for NON_PROVISIONABLE type', async () => {
      mockSend.mockResolvedValueOnce({
        ProvisioningType: 'NON_PROVISIONABLE',
        Schema: JSON.stringify({
          handlers: {},
        }),
      });

      const result = await client.describeResourceType('AWS::CloudFormation::WaitConditionHandle');

      expect(result).toEqual({
        provisioningType: 'NON_PROVISIONABLE',
        hasReadHandler: false,
      });
    });

    it('returns hasReadHandler false when schema is missing', async () => {
      mockSend.mockResolvedValueOnce({
        ProvisioningType: 'FULLY_MUTABLE',
        Schema: undefined,
      });

      const result = await client.describeResourceType('AWS::Custom::Resource');

      expect(result).toEqual({
        provisioningType: 'FULLY_MUTABLE',
        hasReadHandler: false,
      });
    });

    it('returns undefined on API error', async () => {
      mockSend.mockRejectedValueOnce(new Error('TypeNotFoundException'));

      const result = await client.describeResourceType('AWS::NonExistent::Type');

      expect(result).toBeUndefined();
    });

    it('caches results to avoid repeated API calls', async () => {
      mockSend.mockResolvedValueOnce({
        ProvisioningType: 'FULLY_MUTABLE',
        Schema: JSON.stringify({ handlers: { read: {} } }),
      });

      const result1 = await client.describeResourceType('AWS::S3::Bucket');
      const result2 = await client.describeResourceType('AWS::S3::Bucket');

      expect(result1).toEqual(result2);
      // Only one API call should have been made
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('caches undefined results too', async () => {
      mockSend.mockRejectedValueOnce(new Error('TypeNotFoundException'));

      await client.describeResourceType('AWS::Bad::Type');
      await client.describeResourceType('AWS::Bad::Type');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStackResourceIds', () => {
    it('returns set of logical resource IDs from the stack', async () => {
      mockSend.mockResolvedValueOnce({
        StackResourceSummaries: [
          { LogicalResourceId: 'MyBucket' },
          { LogicalResourceId: 'MyQueue' },
          { LogicalResourceId: 'MyFunction' },
        ],
        NextToken: undefined,
      });

      const ids = await client.getStackResourceIds('my-stack');

      expect(ids).toEqual(new Set(['MyBucket', 'MyQueue', 'MyFunction']));
    });

    it('paginates through multiple pages', async () => {
      mockSend
        .mockResolvedValueOnce({
          StackResourceSummaries: [
            { LogicalResourceId: 'Resource1' },
            { LogicalResourceId: 'Resource2' },
          ],
          NextToken: 'page2',
        })
        .mockResolvedValueOnce({
          StackResourceSummaries: [
            { LogicalResourceId: 'Resource3' },
          ],
          NextToken: undefined,
        });

      const ids = await client.getStackResourceIds('my-stack');

      expect(ids).toEqual(new Set(['Resource1', 'Resource2', 'Resource3']));
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('returns empty set for stack with no resources', async () => {
      mockSend.mockResolvedValueOnce({
        StackResourceSummaries: [],
        NextToken: undefined,
      });

      const ids = await client.getStackResourceIds('my-stack');

      expect(ids).toEqual(new Set());
    });
  });

  describe('cleanupTemplates', () => {
    it('deletes uploaded S3 objects', async () => {
      const clientWithBucket = new CfnClientWrapper({
        region: 'us-east-1',
        s3BucketName: 'my-bucket',
      });
      const cfnMock = (clientWithBucket as any).client.send;

      const largeTemplate = 'x'.repeat(52_000);

      // Upload a template
      mockS3Send.mockResolvedValueOnce({}); // PutObject
      cfnMock
        .mockResolvedValueOnce({}) // UpdateStack
        .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] });

      await clientWithBucket.updateStack('my-stack', largeTemplate);

      // Cleanup
      mockS3Send.mockResolvedValueOnce({}); // DeleteObject
      await clientWithBucket.cleanupTemplates();

      // PutObject + DeleteObject = 2 S3 calls
      expect(mockS3Send).toHaveBeenCalledTimes(2);
      const deleteCommand = mockS3Send.mock.calls[1][0];
      expect(deleteCommand.input.Bucket).toBe('my-bucket');
      expect(deleteCommand.input.Key).toMatch(/^cfn-drift-remediate\//);
    });
  });
});
