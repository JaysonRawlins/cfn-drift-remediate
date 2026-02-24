import { buildResourcesToImport, validateResourceIdentifier } from '../src/lib/resource-importer';
import { DriftedResource } from '../src/lib/types';

describe('buildResourcesToImport', () => {
  it('should build import descriptor for a simple S3 bucket', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyBucket',
        resourceType: 'AWS::S3::Bucket',
        physicalResourceId: 'my-actual-bucket',
        stackResourceDriftStatus: 'MODIFIED',
      },
    ];

    const { importable, skipped } = buildResourcesToImport(resources);

    expect(importable).toHaveLength(1);
    expect(importable[0].ResourceType).toBe('AWS::S3::Bucket');
    expect(importable[0].LogicalResourceId).toBe('MyBucket');
    expect(importable[0].ResourceIdentifier).toEqual({ BucketName: 'my-actual-bucket' });
    expect(skipped).toHaveLength(0);
  });

  it('should skip non-importable resource types', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyCustom',
        resourceType: 'Custom::Something',
        physicalResourceId: 'custom-id',
        stackResourceDriftStatus: 'MODIFIED',
      },
    ];

    const { importable, skipped } = buildResourcesToImport(resources);

    expect(importable).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('should use PhysicalResourceIdContext for multi-key identifiers', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyService',
        resourceType: 'AWS::ECS::Service',
        physicalResourceId: 'arn:aws:ecs:us-east-1:123:service/cluster/svc',
        stackResourceDriftStatus: 'MODIFIED',
        physicalResourceIdContext: [
          { key: 'ServiceArn', value: 'arn:aws:ecs:us-east-1:123:service/cluster/svc' },
          { key: 'Cluster', value: 'my-cluster' },
        ],
      },
    ];

    const { importable } = buildResourcesToImport(resources);

    expect(importable).toHaveLength(1);
    expect(importable[0].ResourceIdentifier.ServiceArn).toBe(
      'arn:aws:ecs:us-east-1:123:service/cluster/svc',
    );
    expect(importable[0].ResourceIdentifier.Cluster).toBe('my-cluster');
  });

  it('should use actualProperties for identifier resolution', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyQueue',
        resourceType: 'AWS::SQS::Queue',
        physicalResourceId: 'https://sqs.us-east-1.amazonaws.com/123/my-queue',
        stackResourceDriftStatus: 'MODIFIED',
        actualProperties: {
          QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/my-queue',
        },
      },
    ];

    const { importable } = buildResourcesToImport(resources);

    expect(importable).toHaveLength(1);
    expect(importable[0].ResourceIdentifier.QueueUrl).toBe(
      'https://sqs.us-east-1.amazonaws.com/123/my-queue',
    );
  });

  it('should prefer dynamic identifiers from API over static list', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyBucket',
        resourceType: 'AWS::S3::Bucket',
        physicalResourceId: 'my-bucket',
        stackResourceDriftStatus: 'MODIFIED',
      },
    ];

    const dynamicIdentifiers = new Map([
      ['AWS::S3::Bucket', ['BucketName']],
    ]);

    const { importable } = buildResourcesToImport(resources, dynamicIdentifiers);

    expect(importable).toHaveLength(1);
    expect(importable[0].ResourceIdentifier.BucketName).toBe('my-bucket');
  });

  it('should handle SQS queue special case via physical resource ID', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyQueue',
        resourceType: 'AWS::SQS::Queue',
        physicalResourceId: 'https://sqs.us-east-1.amazonaws.com/123/my-queue',
        stackResourceDriftStatus: 'MODIFIED',
      },
    ];

    const { importable } = buildResourcesToImport(resources);

    expect(importable).toHaveLength(1);
    expect(importable[0].ResourceIdentifier.QueueUrl).toBe(
      'https://sqs.us-east-1.amazonaws.com/123/my-queue',
    );
  });

  it('should handle SNS topic special case', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyTopic',
        resourceType: 'AWS::SNS::Topic',
        physicalResourceId: 'arn:aws:sns:us-east-1:123:my-topic',
        stackResourceDriftStatus: 'MODIFIED',
      },
    ];

    const { importable } = buildResourcesToImport(resources);

    expect(importable).toHaveLength(1);
    expect(importable[0].ResourceIdentifier.TopicArn).toBe(
      'arn:aws:sns:us-east-1:123:my-topic',
    );
  });

  it('should handle Lambda function special case', () => {
    const resources: DriftedResource[] = [
      {
        logicalResourceId: 'MyFunc',
        resourceType: 'AWS::Lambda::Function',
        physicalResourceId: 'my-function-name',
        stackResourceDriftStatus: 'MODIFIED',
      },
    ];

    const { importable } = buildResourcesToImport(resources);

    expect(importable).toHaveLength(1);
    expect(importable[0].ResourceIdentifier.FunctionName).toBe('my-function-name');
  });
});

describe('validateResourceIdentifier', () => {
  it('should return true when all required properties are present', () => {
    expect(
      validateResourceIdentifier('AWS::S3::Bucket', { BucketName: 'my-bucket' }),
    ).toBe(true);
  });

  it('should return false when required properties are missing', () => {
    expect(
      validateResourceIdentifier('AWS::ECS::Service', { ServiceArn: 'arn:...' }),
    ).toBe(false);
  });

  it('should return true for multi-key identifiers when all present', () => {
    expect(
      validateResourceIdentifier('AWS::ECS::Service', {
        ServiceArn: 'arn:...',
        Cluster: 'my-cluster',
      }),
    ).toBe(true);
  });
});
