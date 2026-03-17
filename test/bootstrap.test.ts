// chalk v5 is ESM-only — mock it so Jest can load bootstrap.ts
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

// Mock inquirer confirm
jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn(),
  input: jest.fn(),
}));

import { confirm } from '@inquirer/prompts';
import { getOrCreateServiceRole, bootstrapStackName, DENY_DESTRUCTIVE_ACTIONS, cfTypeToIamNamespace } from '../src/lib/bootstrap';
import { CfnClientWrapper } from '../src/lib/cfn-client';
import { ELIGIBLE_IMPORT_RESOURCES } from '../src/lib/eligible-resources';

const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;

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

// Mock CloudControl client
jest.mock('@aws-sdk/client-cloudcontrol', () => {
  const original = jest.requireActual('@aws-sdk/client-cloudcontrol');
  return {
    ...original,
    CloudControlClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

// Mock S3 client
jest.mock('@aws-sdk/client-s3', () => {
  const original = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...original,
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

// Mock STS client
jest.mock('@aws-sdk/client-sts', () => {
  const original = jest.requireActual('@aws-sdk/client-sts');
  return {
    ...original,
    STSClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

jest.mock('../src/lib/utils', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
  deepClone: jest.requireActual('../src/lib/utils').deepClone,
  Logger: jest.requireActual('../src/lib/utils').Logger,
}));

describe('bootstrap', () => {
  let client: CfnClientWrapper;
  let mockSend: jest.Mock;
  const REGION = 'us-east-1';
  const STACK_NAME = `cfn-drift-remediate-role-${REGION}`;
  const ROLE_ARN = `arn:aws:iam::123456789012:role/cfn-drift-remediate-role-${REGION}`;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new CfnClientWrapper({ region: REGION });
    mockSend = (client as any).client.send;
  });

  describe('bootstrapStackName', () => {
    it('includes region in the stack name', () => {
      expect(bootstrapStackName('us-east-1')).toBe('cfn-drift-remediate-role-us-east-1');
      expect(bootstrapStackName('eu-west-2')).toBe('cfn-drift-remediate-role-eu-west-2');
    });
  });

  describe('existing stack', () => {
    it('returns role ARN from existing CREATE_COMPLETE stack', async () => {
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
          Outputs: [{ OutputKey: 'RoleArn', OutputValue: ROLE_ARN }],
        }],
      });

      const result = await getOrCreateServiceRole(client, true, false);

      expect(result).toBe(ROLE_ARN);
      expect(mockSend).toHaveBeenCalledTimes(1); // Only getStackInfo
    });

    it('returns role ARN from existing UPDATE_COMPLETE stack', async () => {
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'UPDATE_COMPLETE',
          Parameters: [],
          Outputs: [{ OutputKey: 'RoleArn', OutputValue: ROLE_ARN }],
        }],
      });

      const result = await getOrCreateServiceRole(client, true, false);

      expect(result).toBe(ROLE_ARN);
    });

    it('throws when stack exists but has no RoleArn output', async () => {
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
          Outputs: [],
        }],
      });

      await expect(getOrCreateServiceRole(client, true, false))
        .rejects.toThrow(/no RoleArn output/);
    });

    it('throws when stack is in progress', async () => {
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'CREATE_IN_PROGRESS',
          Parameters: [],
          Outputs: [],
        }],
      });

      await expect(getOrCreateServiceRole(client, true, false))
        .rejects.toThrow(/currently being modified/);
    });

    it('throws with guidance when stack is in failed state', async () => {
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'ROLLBACK_COMPLETE',
          Parameters: [],
          Outputs: [],
        }],
      });

      await expect(getOrCreateServiceRole(client, true, false))
        .rejects.toThrow(/failed state.*delete-stack/s);
    });
  });

  describe('stack creation', () => {
    it('creates stack when not found and autoApprove is true', async () => {
      // getStackInfo throws "does not exist"
      mockSend.mockRejectedValueOnce(new Error(`Stack with id ${STACK_NAME} does not exist`));

      // createStack: CreateStackCommand + waitForStackCreate
      mockSend
        .mockResolvedValueOnce({}) // CreateStackCommand
        .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }); // DescribeStacks (wait)

      // getStackInfo after creation
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
          Outputs: [{ OutputKey: 'RoleArn', OutputValue: ROLE_ARN }],
        }],
      });

      const result = await getOrCreateServiceRole(client, true, false);

      expect(result).toBe(ROLE_ARN);
      // Verify CreateStackCommand was called with region-specific stack name
      const createCall = mockSend.mock.calls[1][0];
      expect(createCall.input.StackName).toBe(STACK_NAME);
      expect(createCall.input.TemplateBody).toBeDefined();
      expect(createCall.input.Capabilities).toContain('CAPABILITY_IAM');

      // Verify the template contains the region-specific role name
      const template = JSON.parse(createCall.input.TemplateBody);
      expect(template.Resources.ServiceRole.Properties.RoleName).toBe(`cfn-drift-remediate-role-${REGION}`);
    });

    it('prompts user when autoApprove is false', async () => {
      mockConfirm.mockResolvedValueOnce(true as never);

      // getStackInfo throws "does not exist"
      mockSend.mockRejectedValueOnce(new Error(`Stack with id ${STACK_NAME} does not exist`));

      // createStack: CreateStackCommand + waitForStackCreate
      mockSend
        .mockResolvedValueOnce({}) // CreateStackCommand
        .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }); // DescribeStacks (wait)

      // getStackInfo after creation
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
          Outputs: [{ OutputKey: 'RoleArn', OutputValue: ROLE_ARN }],
        }],
      });

      const result = await getOrCreateServiceRole(client, false, false);

      expect(result).toBe(ROLE_ARN);
      expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Create the safety role now?',
      }));
    });

    it('throws when user declines creation', async () => {
      mockConfirm.mockResolvedValueOnce(false as never);

      // getStackInfo throws "does not exist"
      mockSend.mockRejectedValueOnce(new Error(`Stack with id ${STACK_NAME} does not exist`));

      await expect(getOrCreateServiceRole(client, false, false))
        .rejects.toThrow(/Cannot proceed without the safety role/);
    });

    it('throws when stack created but no RoleArn output', async () => {
      // getStackInfo throws "does not exist"
      mockSend.mockRejectedValueOnce(new Error(`Stack with id ${STACK_NAME} does not exist`));

      // createStack: CreateStackCommand + waitForStackCreate
      mockSend
        .mockResolvedValueOnce({}) // CreateStackCommand
        .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }); // DescribeStacks (wait)

      // getStackInfo after creation — no outputs
      mockSend.mockResolvedValueOnce({
        Stacks: [{
          StackId: `arn:aws:cloudformation:${REGION}:123:stack/${STACK_NAME}/abc`,
          StackName: STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
          Outputs: [],
        }],
      });

      await expect(getOrCreateServiceRole(client, true, false))
        .rejects.toThrow(/no RoleArn output.*bug/);
    });
  });
});

describe('cfTypeToIamNamespace', () => {
  it('maps standard AWS resource types', () => {
    expect(cfTypeToIamNamespace('AWS::EC2::Instance')).toBe('ec2');
    expect(cfTypeToIamNamespace('AWS::RDS::DBInstance')).toBe('rds');
    expect(cfTypeToIamNamespace('AWS::Lambda::Function')).toBe('lambda');
    expect(cfTypeToIamNamespace('AWS::S3::Bucket')).toBe('s3');
  });

  it('returns undefined for Custom::AWS (CDK AwsCustomResource)', () => {
    expect(cfTypeToIamNamespace('Custom::AWS')).toBeUndefined();
  });

  it('returns undefined for all Custom:: prefixed types', () => {
    expect(cfTypeToIamNamespace('Custom::MyCustomResource')).toBeUndefined();
    expect(cfTypeToIamNamespace('Custom::S3BucketNotification')).toBeUndefined();
    expect(cfTypeToIamNamespace('Custom::CloudFrontInvalidation')).toBeUndefined();
  });

  it('returns undefined for AWS::CDK::Metadata', () => {
    expect(cfTypeToIamNamespace('AWS::CDK::Metadata')).toBeUndefined();
  });

  it('returns undefined for malformed types', () => {
    expect(cfTypeToIamNamespace('NoColons')).toBeUndefined();
  });
});

describe('DENY_DESTRUCTIVE_ACTIONS coverage', () => {
  // Map CF service namespaces to IAM service namespaces
  const CF_TO_IAM: Record<string, string> = {
    ACMPCA: 'acm-pca',
    AccessAnalyzer: 'access-analyzer',
    ApiGateway: 'apigateway',
    AppSync: 'appsync',
    Athena: 'athena',
    AutoScaling: 'autoscaling',
    CE: 'ce',
    Cassandra: 'cassandra',
    Chatbot: 'chatbot',
    CloudFormation: 'cloudformation',
    CloudTrail: 'cloudtrail',
    CloudWatch: 'cloudwatch',
    CodeGuruProfiler: 'codeguruprofiler',
    CodeStarConnections: 'codestar-connections',
    Config: 'config',
    Detective: 'detective',
    DynamoDB: 'dynamodb',
    EC2: 'ec2',
    ECS: 'ecs',
    EFS: 'efs',
    ElasticLoadBalancing: 'elasticloadbalancing',
    ElasticLoadBalancingV2: 'elasticloadbalancing',
    EventSchemas: 'schemas',
    Events: 'events',
    FMS: 'fms',
    GlobalAccelerator: 'globalaccelerator',
    IAM: 'iam',
    ImageBuilder: 'imagebuilder',
    IoT: 'iot',
    KinesisFirehose: 'firehose',
    Lambda: 'lambda',
    Logs: 'logs',
    Macie: 'macie2',
    NetworkManager: 'networkmanager',
    QLDB: 'qldb',
    RDS: 'rds',
    ResourceGroups: 'resource-groups',
    Route53: 'route53',
    S3: 's3',
    SES: 'ses',
    SNS: 'sns',
    SQS: 'sqs',
    SSM: 'ssm',
    ServiceCatalog: 'servicecatalog',
    Synthetics: 'synthetics',
    WAFv2: 'wafv2',
  };

  it('covers every service namespace in eligible-resources.ts', () => {
    // Extract unique CF service namespaces from eligible resource types
    const cfNamespaces = new Set<string>();
    for (const resourceType of Object.keys(ELIGIBLE_IMPORT_RESOURCES)) {
      // AWS::EC2::Instance → EC2
      const parts = resourceType.split('::');
      if (parts.length >= 2) {
        cfNamespaces.add(parts[1]);
      }
    }

    // Extract IAM service namespaces from deny list
    const denyNamespaces = new Set<string>();
    for (const action of DENY_DESTRUCTIVE_ACTIONS) {
      // 'ec2:Delete*' → 'ec2'
      const colonIdx = action.indexOf(':');
      if (colonIdx > 0) {
        denyNamespaces.add(action.substring(0, colonIdx));
      }
    }

    // Check every eligible-resources service has deny coverage
    const missing: string[] = [];
    for (const cfNs of cfNamespaces) {
      const iamNs = CF_TO_IAM[cfNs];
      if (!iamNs) {
        missing.push(`${cfNs} (no CF→IAM mapping in test — add to CF_TO_IAM)`);
        continue;
      }
      if (!denyNamespaces.has(iamNs)) {
        missing.push(`${cfNs} → ${iamNs} (missing from DENY_DESTRUCTIVE_ACTIONS)`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('contains no duplicate actions', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const action of DENY_DESTRUCTIVE_ACTIONS) {
      if (seen.has(action)) {
        duplicates.push(action);
      }
      seen.add(action);
    }
    expect(duplicates).toEqual([]);
  });

  it('every action has valid service:action format', () => {
    const invalid: string[] = [];
    for (const action of DENY_DESTRUCTIVE_ACTIONS) {
      if (!action.match(/^[a-z][a-z0-9-]*:.+$/)) {
        invalid.push(action);
      }
    }
    expect(invalid).toEqual([]);
  });
});
