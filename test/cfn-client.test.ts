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
