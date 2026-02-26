import { parseArn, buildIdentifierFromPhysicalId } from '../src/lib/resource-identifier';

describe('parseArn', () => {
  it('should parse a standard ARN with region and account', () => {
    const result = parseArn('arn:aws:lambda:us-east-1:123456789012:function:my-function');
    expect(result).toEqual({
      partition: 'aws',
      service: 'lambda',
      region: 'us-east-1',
      accountId: '123456789012',
      resourcePart: 'function:my-function',
    });
  });

  it('should parse an S3 ARN (no region/account)', () => {
    const result = parseArn('arn:aws:s3:::my-bucket');
    expect(result).toEqual({
      partition: 'aws',
      service: 's3',
      region: '',
      accountId: '',
      resourcePart: 'my-bucket',
    });
  });

  it('should parse an IAM ARN with path in resource part', () => {
    const result = parseArn('arn:aws:iam::123456789012:role/service-role/my-role');
    expect(result).toEqual({
      partition: 'aws',
      service: 'iam',
      region: '',
      accountId: '123456789012',
      resourcePart: 'role/service-role/my-role',
    });
  });

  it('should parse an ARN with colons in resource part', () => {
    const result = parseArn('arn:aws:logs:us-east-1:123:log-group:/aws/lambda/fn:*');
    expect(result).toEqual({
      partition: 'aws',
      service: 'logs',
      region: 'us-east-1',
      accountId: '123',
      resourcePart: 'log-group:/aws/lambda/fn:*',
    });
  });

  it('should return null for non-ARN strings', () => {
    expect(parseArn('my-bucket')).toBeNull();
    expect(parseArn('sg-12345678')).toBeNull();
    expect(parseArn('i-0abc123def456')).toBeNull();
    expect(parseArn('')).toBeNull();
  });

  it('should return null for malformed ARNs', () => {
    expect(parseArn('arn:aws:s3')).toBeNull();
    expect(parseArn('arn:aws')).toBeNull();
  });
});

describe('buildIdentifierFromPhysicalId', () => {
  describe('S3 Bucket', () => {
    it('should extract bucket name from ARN', () => {
      const result = buildIdentifierFromPhysicalId('AWS::S3::Bucket', 'arn:aws:s3:::my-bucket');
      expect(result).toEqual({ BucketName: 'my-bucket' });
    });

    it('should use plain bucket name directly', () => {
      const result = buildIdentifierFromPhysicalId('AWS::S3::Bucket', 'my-bucket');
      expect(result).toEqual({ BucketName: 'my-bucket' });
    });
  });

  describe('SQS Queue', () => {
    it('should construct queue URL from ARN', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::SQS::Queue',
        'arn:aws:sqs:us-east-1:123456789012:my-queue',
      );
      expect(result).toEqual({
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
      });
    });

    it('should use queue URL directly when not an ARN', () => {
      const url = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';
      const result = buildIdentifierFromPhysicalId('AWS::SQS::Queue', url);
      expect(result).toEqual({ QueueUrl: url });
    });
  });

  describe('SNS Topic', () => {
    it('should use topic ARN as-is', () => {
      const arn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
      const result = buildIdentifierFromPhysicalId('AWS::SNS::Topic', arn);
      expect(result).toEqual({ TopicArn: arn });
    });
  });

  describe('Lambda Function', () => {
    it('should extract function name from ARN', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::Lambda::Function',
        'arn:aws:lambda:us-east-1:123:function:my-function',
      );
      expect(result).toEqual({ FunctionName: 'my-function' });
    });

    it('should use plain function name directly', () => {
      const result = buildIdentifierFromPhysicalId('AWS::Lambda::Function', 'my-function');
      expect(result).toEqual({ FunctionName: 'my-function' });
    });
  });

  describe('DynamoDB Table', () => {
    it('should extract table name from ARN', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::DynamoDB::Table',
        'arn:aws:dynamodb:us-east-1:123:table/my-table',
      );
      expect(result).toEqual({ TableName: 'my-table' });
    });

    it('should use plain table name directly', () => {
      const result = buildIdentifierFromPhysicalId('AWS::DynamoDB::Table', 'my-table');
      expect(result).toEqual({ TableName: 'my-table' });
    });
  });

  describe('IAM Role', () => {
    it('should extract role name from ARN with path', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::IAM::Role',
        'arn:aws:iam::123456:role/service-role/my-role',
      );
      expect(result).toEqual({ RoleName: 'my-role' });
    });

    it('should extract role name from simple ARN', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::IAM::Role',
        'arn:aws:iam::123456:role/my-role',
      );
      expect(result).toEqual({ RoleName: 'my-role' });
    });

    it('should use plain role name directly', () => {
      const result = buildIdentifierFromPhysicalId('AWS::IAM::Role', 'my-role');
      expect(result).toEqual({ RoleName: 'my-role' });
    });
  });

  describe('CloudWatch Logs LogGroup', () => {
    it('should extract log group name from ARN', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::Logs::LogGroup',
        'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-function:*',
      );
      expect(result).toEqual({ LogGroupName: '/aws/lambda/my-function' });
    });

    it('should use plain log group name directly', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::Logs::LogGroup',
        '/aws/lambda/my-function',
      );
      expect(result).toEqual({ LogGroupName: '/aws/lambda/my-function' });
    });
  });

  describe('EC2 SecurityGroup', () => {
    it('should extract group ID from ARN', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::EC2::SecurityGroup',
        'arn:aws:ec2:us-east-1:123:security-group/sg-0abc123def456',
      );
      expect(result).toEqual({ GroupId: 'sg-0abc123def456' });
    });

    it('should use plain group ID directly', () => {
      const result = buildIdentifierFromPhysicalId('AWS::EC2::SecurityGroup', 'sg-0abc123def456');
      expect(result).toEqual({ GroupId: 'sg-0abc123def456' });
    });
  });

  describe('ECS Service (multi-key)', () => {
    it('should extract both ServiceArn and Cluster from ARN', () => {
      const arn = 'arn:aws:ecs:us-east-1:123:service/my-cluster/my-service';
      const result = buildIdentifierFromPhysicalId('AWS::ECS::Service', arn);
      expect(result).toEqual({
        ServiceArn: arn,
        Cluster: 'my-cluster',
      });
    });

    it('should return null for plain service name (cannot determine cluster)', () => {
      const result = buildIdentifierFromPhysicalId('AWS::ECS::Service', 'my-service');
      expect(result).toBeNull();
    });
  });

  describe('RDS DBInstance', () => {
    it('should extract identifier from ARN', () => {
      const result = buildIdentifierFromPhysicalId(
        'AWS::RDS::DBInstance',
        'arn:aws:rds:us-east-1:123:db:my-instance',
      );
      expect(result).toEqual({ DBInstanceIdentifier: 'my-instance' });
    });

    it('should use plain identifier directly', () => {
      const result = buildIdentifierFromPhysicalId('AWS::RDS::DBInstance', 'my-instance');
      expect(result).toEqual({ DBInstanceIdentifier: 'my-instance' });
    });
  });

  describe('Generic fallback', () => {
    it('should use physicalId directly for single-property unknown types', () => {
      // AWS::CloudWatch::Alarm has single property AlarmName
      const result = buildIdentifierFromPhysicalId('AWS::CloudWatch::Alarm', 'my-alarm');
      expect(result).toEqual({ AlarmName: 'my-alarm' });
    });

    it('should use generic fallback for types not in extraction rules', () => {
      // AWS::KinesisFirehose::DeliveryStream has single property DeliveryStreamName
      const result = buildIdentifierFromPhysicalId('AWS::KinesisFirehose::DeliveryStream', 'my-stream');
      expect(result).toEqual({ DeliveryStreamName: 'my-stream' });
    });

    it('should return null for unknown types not in eligible resources', () => {
      const result = buildIdentifierFromPhysicalId('Custom::Something', 'some-id');
      expect(result).toBeNull();
    });
  });

  describe('ARN-as-identifier types', () => {
    it('should use full ARN for LoadBalancer', () => {
      const arn = 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc';
      const result = buildIdentifierFromPhysicalId(
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        arn,
      );
      expect(result).toEqual({ LoadBalancerArn: arn });
    });

    it('should use full ARN for TargetGroup', () => {
      const arn = 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/my-tg/abc123';
      const result = buildIdentifierFromPhysicalId(
        'AWS::ElasticLoadBalancingV2::TargetGroup',
        arn,
      );
      expect(result).toEqual({ TargetGroupArn: arn });
    });

    it('should use full ARN for StepFunctions StateMachine', () => {
      const arn = 'arn:aws:states:us-east-1:123:stateMachine:my-sm';
      const result = buildIdentifierFromPhysicalId('AWS::StepFunctions::StateMachine', arn);
      expect(result).toEqual({ StateMachineArn: arn });
    });

    it('should use full ARN for IAM ManagedPolicy', () => {
      const arn = 'arn:aws:iam::123:policy/my-policy';
      const result = buildIdentifierFromPhysicalId('AWS::IAM::ManagedPolicy', arn);
      expect(result).toEqual({ PolicyArn: arn });
    });
  });
});
