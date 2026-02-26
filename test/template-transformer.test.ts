import {
  resolvePropertyValue,
  setRetentionOnAllResources,
  transformTemplateForRemoval,
  prepareTemplateForImport,
  parseTemplate,
  stringifyTemplate,
  analyzeCascadeRemovals,
} from '../src/lib/template-transformer';
import { CloudFormationTemplate } from '../src/lib/types';

describe('resolvePropertyValue', () => {
  it('should return primitives unchanged', () => {
    const drifted = new Set<string>();
    const resolved = new Map<string, unknown>();

    expect(resolvePropertyValue('string', drifted, resolved)).toBe('string');
    expect(resolvePropertyValue(123, drifted, resolved)).toBe(123);
    expect(resolvePropertyValue(true, drifted, resolved)).toBe(true);
    expect(resolvePropertyValue(null, drifted, resolved)).toBe(null);
  });

  it('should resolve Ref to drifted resource', () => {
    const value = { Ref: 'MyBucket' };
    const drifted = new Set(['MyBucket']);
    const resolved = new Map([['Ref:MyBucket', 'actual-bucket-name']]);

    expect(resolvePropertyValue(value, drifted, resolved)).toBe('actual-bucket-name');
  });

  it('should not resolve Ref to non-drifted resource', () => {
    const value = { Ref: 'MyBucket' };
    const drifted = new Set<string>();
    const resolved = new Map([['Ref:MyBucket', 'actual-bucket-name']]);

    expect(resolvePropertyValue(value, drifted, resolved)).toEqual({ Ref: 'MyBucket' });
  });

  it('should resolve Fn::GetAtt array form to drifted resource', () => {
    const value = { 'Fn::GetAtt': ['MyBucket', 'Arn'] };
    const drifted = new Set(['MyBucket']);
    const resolved = new Map([['GetAtt:MyBucket:Arn', 'arn:aws:s3:::my-bucket']]);

    expect(resolvePropertyValue(value, drifted, resolved)).toBe('arn:aws:s3:::my-bucket');
  });

  it('should resolve Fn::GetAtt string form to drifted resource', () => {
    const value = { 'Fn::GetAtt': 'MyBucket.Arn' };
    const drifted = new Set(['MyBucket']);
    const resolved = new Map([['GetAtt:MyBucket:Arn', 'arn:aws:s3:::my-bucket']]);

    expect(resolvePropertyValue(value, drifted, resolved)).toBe('arn:aws:s3:::my-bucket');
  });

  it('should recursively resolve nested objects', () => {
    const value = {
      BucketArn: { 'Fn::GetAtt': ['MyBucket', 'Arn'] },
      QueueUrl: { Ref: 'MyQueue' },
      StaticValue: 'unchanged',
    };
    const drifted = new Set(['MyBucket', 'MyQueue']);
    const resolved = new Map([
      ['GetAtt:MyBucket:Arn', 'arn:aws:s3:::my-bucket'],
      ['Ref:MyQueue', 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue'],
    ]);

    const result = resolvePropertyValue(value, drifted, resolved);
    expect(result).toEqual({
      BucketArn: 'arn:aws:s3:::my-bucket',
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
      StaticValue: 'unchanged',
    });
  });

  it('should recursively resolve arrays', () => {
    const value = [{ Ref: 'MyBucket' }, 'static', { Ref: 'OtherResource' }];
    const drifted = new Set(['MyBucket']);
    const resolved = new Map([['Ref:MyBucket', 'my-bucket-name']]);

    const result = resolvePropertyValue(value, drifted, resolved);
    expect(result).toEqual(['my-bucket-name', 'static', { Ref: 'OtherResource' }]);
  });

  it('should collect references in collect mode', () => {
    const value = {
      BucketRef: { Ref: 'MyBucket' },
      BucketArn: { 'Fn::GetAtt': ['MyBucket', 'Arn'] },
    };
    const drifted = new Set(['MyBucket']);
    const collected = new Map<string, unknown>();

    resolvePropertyValue(value, drifted, collected, true);

    expect(collected.has('Ref:MyBucket')).toBe(true);
    expect(collected.has('GetAtt:MyBucket:Arn')).toBe(true);
  });
});

describe('setRetentionOnAllResources', () => {
  it('should set DeletionPolicy: Retain on all resources', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket1: { Type: 'AWS::S3::Bucket', Properties: {} },
        Bucket2: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
    };

    const result = setRetentionOnAllResources(template);

    expect(result.Resources.Bucket1.DeletionPolicy).toBe('Retain');
    expect(result.Resources.Bucket2.DeletionPolicy).toBe('Retain');
    expect(result.Resources.Queue.DeletionPolicy).toBe('Retain');
  });

  it('should not modify the original template', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };

    setRetentionOnAllResources(template);

    expect(template.Resources.Bucket.DeletionPolicy).toBeUndefined();
  });
});

describe('transformTemplateForRemoval', () => {
  it('should remove drifted resources', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket1: { Type: 'AWS::S3::Bucket', Properties: {} },
        Bucket2: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };

    const result = transformTemplateForRemoval(
      template,
      new Set(['Bucket1']),
      new Map(),
    );

    expect(result.template.Resources.Bucket1).toBeUndefined();
    expect(result.template.Resources.Bucket2).toBeDefined();
    expect(result.removedResources).toContain('Bucket1');
  });

  it('should use placeholder when all resources removed', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };

    const result = transformTemplateForRemoval(
      template,
      new Set(['Bucket']),
      new Map(),
    );

    expect(result.template.Resources.PlaceholderResource).toBeDefined();
    expect(result.template.Conditions?.FalseCondition).toBeDefined();
  });
});

describe('transformTemplateForRemoval - DependsOn cleanup', () => {
  it('should remove string DependsOn referencing removed resource', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {}, DependsOn: 'Bucket' },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Resources.Queue.DependsOn).toBeUndefined();
  });

  it('should filter array DependsOn removing only removed resources', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Topic: { Type: 'AWS::SNS::Topic', Properties: {} },
        Queue: {
          Type: 'AWS::SQS::Queue',
          Properties: {},
          DependsOn: ['Bucket', 'Topic'],
        },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Resources.Queue.DependsOn).toEqual(['Topic']);
  });

  it('should delete DependsOn when array becomes empty after filtering', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: {
          Type: 'AWS::SQS::Queue',
          Properties: {},
          DependsOn: ['Bucket'],
        },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Resources.Queue.DependsOn).toBeUndefined();
  });

  it('should not modify DependsOn when no removed resources referenced', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Topic: { Type: 'AWS::SNS::Topic', Properties: {} },
        Queue: {
          Type: 'AWS::SQS::Queue',
          Properties: {},
          DependsOn: ['Topic'],
        },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Resources.Queue.DependsOn).toEqual(['Topic']);
  });
});

describe('transformTemplateForRemoval - Outputs cleanup', () => {
  it('should remove Outputs that reference removed resources via Ref', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
      Outputs: {
        BucketName: { Value: { Ref: 'Bucket' } },
        QueueUrl: { Value: { Ref: 'Queue' } },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Outputs?.BucketName).toBeUndefined();
    expect(result.template.Outputs?.QueueUrl).toBeDefined();
  });

  it('should remove Outputs that reference removed resources via GetAtt', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
      Outputs: {
        BucketArn: { Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
        QueueArn: { Value: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Outputs?.BucketArn).toBeUndefined();
    expect(result.template.Outputs?.QueueArn).toBeDefined();
  });

  it('should keep Outputs where Ref was already resolved', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
      Outputs: {
        BucketName: { Value: { Ref: 'Bucket' } },
      },
    };
    const resolved = new Map<string, unknown>([['Ref:Bucket', 'actual-bucket-name']]);

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), resolved);

    expect(result.template.Outputs?.BucketName).toBeDefined();
    expect((result.template.Outputs?.BucketName as any).Value).toBe('actual-bucket-name');
  });

  it('should remove entire Outputs section when all outputs removed', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
      Outputs: {
        BucketName: { Value: { Ref: 'Bucket' } },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Outputs).toBeUndefined();
  });

  it('should remove Outputs with Fn::Sub referencing removed resources', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
      Outputs: {
        BucketUrl: { Value: { 'Fn::Sub': 'https://${Bucket}.s3.amazonaws.com' } },
        QueueUrl: { Value: { Ref: 'Queue' } },
      },
    };

    const result = transformTemplateForRemoval(template, new Set(['Bucket']), new Map());

    expect(result.template.Outputs?.BucketUrl).toBeUndefined();
    expect(result.template.Outputs?.QueueUrl).toBeDefined();
  });
});

describe('prepareTemplateForImport - actualProperties fallback', () => {
  it('should use actualProperties when non-empty', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'original-name' },
        },
      },
    };

    const result = prepareTemplateForImport(template, [
      {
        logicalResourceId: 'Bucket',
        actualProperties: { BucketName: 'actual-name', Tags: [] },
      },
    ]);

    expect(result.Resources.Bucket.Properties).toEqual({
      BucketName: 'actual-name',
      Tags: [],
    });
  });

  it('should keep original properties when actualProperties is empty object', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'original-name' },
        },
      },
    };

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const result = prepareTemplateForImport(template, [
      {
        logicalResourceId: 'Bucket',
        actualProperties: {},
      },
    ]);

    expect(result.Resources.Bucket.Properties).toEqual({ BucketName: 'original-name' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty'));

    warnSpy.mockRestore();
  });

  it('should keep original properties when actualProperties is undefined', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'original-name' },
        },
      },
    };

    const result = prepareTemplateForImport(template, [
      { logicalResourceId: 'Bucket' },
    ]);

    expect(result.Resources.Bucket.Properties).toEqual({ BucketName: 'original-name' });
  });
});

describe('parseTemplate and stringifyTemplate', () => {
  it('should parse JSON template', () => {
    const json = '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}';
    const template = parseTemplate(json);

    expect(template.Resources.Bucket.Type).toBe('AWS::S3::Bucket');
  });

  it('should parse YAML template', () => {
    const yamlTemplate = `
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;
    const template = parseTemplate(yamlTemplate);

    expect(template.Resources.Bucket.Type).toBe('AWS::S3::Bucket');
  });

  it('should stringify template to JSON', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket' },
      },
    };

    const json = stringifyTemplate(template);
    const parsed = JSON.parse(json);

    expect(parsed.Resources.Bucket.Type).toBe('AWS::S3::Bucket');
  });
});

describe('analyzeCascadeRemovals', () => {
  it('should return empty array when no cascades', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'my-queue' } },
      },
    };
    const result = analyzeCascadeRemovals(template, new Set(['Bucket']));
    expect(result).toEqual([]);
  });

  it('should detect cascade from Ref dependency', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        DB: { Type: 'AWS::RDS::DBInstance', Properties: {} },
        Secret: {
          Type: 'AWS::SecretsManager::SecretTargetAttachment',
          Properties: { TargetId: { Ref: 'DB' } },
        },
      },
    };
    const result = analyzeCascadeRemovals(template, new Set(['DB']));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      logicalResourceId: 'Secret',
      resourceType: 'AWS::SecretsManager::SecretTargetAttachment',
      dependsOn: 'DB',
    });
  });

  it('should detect cascade from GetAtt dependency', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        DB: { Type: 'AWS::RDS::DBInstance', Properties: {} },
        SGIngress: {
          Type: 'AWS::EC2::SecurityGroupIngress',
          Properties: { FromPort: { 'Fn::GetAtt': ['DB', 'Endpoint.Port'] } },
        },
      },
    };
    const result = analyzeCascadeRemovals(template, new Set(['DB']));
    expect(result).toHaveLength(1);
    expect(result[0].logicalResourceId).toBe('SGIngress');
    expect(result[0].dependsOn).toBe('DB');
  });

  it('should detect multi-level cascades', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket', Properties: {} },
        B: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { Ref: 'A' } } },
        C: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'B' } } },
      },
    };
    const result = analyzeCascadeRemovals(template, new Set(['A']));
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.logicalResourceId);
    expect(ids).toContain('B');
    expect(ids).toContain('C');
  });

  it('should not cascade for DependsOn-only references', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Queue: { Type: 'AWS::SQS::Queue', Properties: {}, DependsOn: 'Bucket' },
      },
    };
    const result = analyzeCascadeRemovals(template, new Set(['Bucket']));
    expect(result).toEqual([]);
  });

  it('should not include resources already in the removal set', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket', Properties: {} },
        B: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { Ref: 'A' } } },
      },
    };
    const result = analyzeCascadeRemovals(template, new Set(['A', 'B']));
    expect(result).toEqual([]);
  });
});
