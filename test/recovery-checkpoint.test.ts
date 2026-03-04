import { parseTemplate } from '../src/lib/template-transformer';
import { RecoveryCheckpoint } from '../src/lib/types';

/**
 * The recovery checkpoint file is JSON where originalTemplateBody is a
 * string (JSON-in-JSON). These tests verify the round-trip: write checkpoint
 * → parse outer JSON → parse inner template body → valid CFN template.
 */
describe('recovery checkpoint round-trip', () => {
  const sampleTemplate = {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: { BucketName: 'test-bucket' },
      },
      MyFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: 'test-fn',
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Code: { ZipFile: 'exports.handler = async () => ({})' },
        },
      },
    },
  };

  const makeCheckpoint = (templateBody: string): RecoveryCheckpoint => ({
    stackName: 'TestStack',
    stackId: 'arn:aws:cloudformation:us-east-2:123456789012:stack/TestStack/abc123',
    originalTemplateBody: templateBody,
    parameters: [
      { ParameterKey: 'Env', ParameterValue: 'test' },
    ],
    driftedResourceIds: ['MyBucket', 'MyFunction'],
    timestamp: '2026-03-04T12:00:00.000Z',
  });

  it('round-trips a JSON template body through checkpoint serialization', () => {
    const templateBody = JSON.stringify(sampleTemplate);
    const checkpoint = makeCheckpoint(templateBody);

    // Simulate writing and reading the backup file
    const serialized = JSON.stringify(checkpoint, null, 2);
    const parsed: RecoveryCheckpoint = JSON.parse(serialized);

    // The inner template body must still be a valid parseable string
    expect(typeof parsed.originalTemplateBody).toBe('string');
    const template = parseTemplate(parsed.originalTemplateBody);
    expect(template.Resources.MyBucket.Type).toBe('AWS::S3::Bucket');
    expect(template.Resources.MyFunction.Type).toBe('AWS::Lambda::Function');
  });

  it('round-trips a YAML template body through checkpoint serialization', () => {
    const yamlBody = [
      'AWSTemplateFormatVersion: "2010-09-09"',
      'Resources:',
      '  MyBucket:',
      '    Type: AWS::S3::Bucket',
      '    Properties:',
      '      BucketName: test-bucket',
    ].join('\n');
    const checkpoint = makeCheckpoint(yamlBody);

    const serialized = JSON.stringify(checkpoint, null, 2);
    const parsed: RecoveryCheckpoint = JSON.parse(serialized);

    const template = parseTemplate(parsed.originalTemplateBody);
    expect(template.Resources.MyBucket.Type).toBe('AWS::S3::Bucket');
    expect(template.Resources.MyBucket.Properties!.BucketName).toBe('test-bucket');
  });

  it('preserves all checkpoint metadata fields', () => {
    const checkpoint = makeCheckpoint(JSON.stringify(sampleTemplate));

    const serialized = JSON.stringify(checkpoint, null, 2);
    const parsed: RecoveryCheckpoint = JSON.parse(serialized);

    expect(parsed.stackName).toBe('TestStack');
    expect(parsed.stackId).toContain('arn:aws:cloudformation');
    expect(parsed.parameters).toHaveLength(1);
    expect(parsed.parameters[0].ParameterKey).toBe('Env');
    expect(parsed.driftedResourceIds).toEqual(['MyBucket', 'MyFunction']);
    expect(parsed.timestamp).toBe('2026-03-04T12:00:00.000Z');
  });

  it('handles templates with special characters and intrinsic functions', () => {
    const templateWithIntrinsics = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        SGIngress: {
          Type: 'AWS::EC2::SecurityGroupIngress',
          Properties: {
            GroupId: { 'Fn::GetAtt': ['DB', 'Endpoint.Port'] },
            SourceSecurityGroupId: { Ref: 'WebServerSG' },
            Description: 'Allow "quoted" & <special> chars',
          },
        },
      },
    };
    const checkpoint = makeCheckpoint(JSON.stringify(templateWithIntrinsics));

    const serialized = JSON.stringify(checkpoint, null, 2);
    const parsed: RecoveryCheckpoint = JSON.parse(serialized);
    const template = parseTemplate(parsed.originalTemplateBody);

    expect(template.Resources.SGIngress.Properties!.GroupId).toEqual({
      'Fn::GetAtt': ['DB', 'Endpoint.Port'],
    });
    expect(template.Resources.SGIngress.Properties!.Description).toContain('"quoted"');
  });
});
