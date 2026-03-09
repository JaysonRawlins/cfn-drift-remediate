import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { CfnClientWrapper } from './cfn-client';

/**
 * Returns the bootstrap stack name for a given region.
 * Each region gets its own stack because IAM role names are global
 * and the CloudFormation stack is regional.
 */
export function bootstrapStackName(region: string): string {
  return `cfn-drift-remediate-role-${region}`;
}

/**
 * Per-service destructive action patterns.
 *
 * IAM does not allow wildcards in the service namespace (e.g. `*:Delete*` is invalid).
 * Instead we enumerate every CloudFormation-managed service and wildcard the destructive
 * verbs within each namespace (e.g. `ec2:Delete*`).
 *
 * IMPORTANT: Every service in eligible-resources.ts MUST have deny coverage here.
 * DeletionPolicy:Retain can fail in cascade scenarios (broken Ref/GetAtt cause CF to
 * reject the Retain update), so this role is the true safety backstop, not belt-and-suspenders.
 *
 * Safety philosophy: false positives (too-broad deny → update fails → safe rollback)
 * are vastly better than false negatives (too-narrow deny → resource deleted → data loss).
 */
export const DENY_DESTRUCTIVE_ACTIONS: string[] = [
  // =====================================================================
  // Services from eligible-resources.ts (importable types — MUST cover)
  // =====================================================================

  // --- Compute & Containers ---
  'ec2:Delete*', 'ec2:Terminate*', 'ec2:Revoke*', 'ec2:Detach*',
  'ec2:Deregister*', 'ec2:Disassociate*', 'ec2:StopInstances',
  'ecs:Delete*', 'ecs:Deregister*', 'ecs:Remove*',
  'lambda:Delete*',
  'autoscaling:Delete*', 'autoscaling:Detach*', 'autoscaling:Remove*',
  'imagebuilder:Delete*',

  // --- Storage ---
  's3:Delete*',
  'efs:Delete*',

  // --- Databases ---
  'rds:Delete*', 'rds:StopDBInstance', 'rds:StopDBCluster',
  'dynamodb:Delete*',
  'cassandra:Delete*',
  'qldb:Delete*',

  // --- Networking & CDN ---
  'elasticloadbalancing:Delete*', 'elasticloadbalancing:Detach*', 'elasticloadbalancing:Remove*',
  'route53:Delete*',
  'globalaccelerator:Delete*',
  'networkmanager:Delete*', 'networkmanager:Deregister*', 'networkmanager:Disassociate*',

  // --- Messaging & Events ---
  'sns:Delete*', 'sns:Remove*', 'sns:Unsubscribe',
  'sqs:Delete*', 'sqs:Purge*',
  'events:Delete*', 'events:Remove*',
  'schemas:Delete*',
  'firehose:Delete*',

  // --- Security & IAM ---
  'iam:Delete*', 'iam:Remove*', 'iam:Detach*',
  'acm-pca:Delete*',
  'access-analyzer:Delete*',
  'wafv2:Delete*', 'wafv2:Disassociate*',
  'fms:Delete*', 'fms:Disassociate*',
  'detective:Delete*',
  'macie2:Delete*', 'macie2:Disable*',

  // --- Management & Monitoring ---
  'ssm:Delete*', 'ssm:Deregister*', 'ssm:Disassociate*',
  'logs:Delete*',
  'cloudwatch:Delete*',
  'cloudformation:Delete*',
  'config:Delete*',
  'cloudtrail:Delete*', 'cloudtrail:Stop*',
  'resource-groups:Delete*',
  'servicecatalog:Delete*', 'servicecatalog:Disassociate*', 'servicecatalog:Terminate*',
  'synthetics:Delete*',
  'ce:Delete*',
  'chatbot:Delete*',

  // --- App Integration & APIs ---
  'apigateway:Delete*', 'apigateway:DELETE',
  'appsync:Delete*',
  'ses:Delete*',

  // --- Developer Tools ---
  'codebuild:Delete*',
  'codeguruprofiler:Delete*',
  'codestar-connections:Delete*',
  'athena:Delete*',

  // --- IoT ---
  'iot:Delete*', 'iot:Detach*',

  // =====================================================================
  // Additional commonly CF-managed services (broader safety coverage)
  // =====================================================================

  // --- Compute & Containers (additional) ---
  'eks:Delete*',
  'sagemaker:Delete*', 'sagemaker:Stop*',
  'batch:Delete*',
  'emr:Terminate*', 'emr:Delete*',
  'emr-serverless:Delete*',
  'apprunner:Delete*',
  'appstream:Delete*', 'appstream:Disassociate*',

  // --- Storage (additional) ---
  'fsx:Delete*',
  'backup:Delete*',
  's3-object-lambda:Delete*',
  's3-outposts:Delete*',

  // --- Databases (additional) ---
  'elasticache:Delete*',
  'neptune:Delete*',
  'docdb:Delete*',
  'redshift:Delete*', 'redshift:PauseCluster',
  'es:Delete*',
  'opensearch:Delete*',
  'memorydb:Delete*',
  'dax:Delete*',
  'timestream:Delete*',

  // --- Networking (additional) ---
  'cloudfront:Delete*',
  'route53resolver:Delete*', 'route53resolver:Disassociate*',
  'servicediscovery:Delete*', 'servicediscovery:Deregister*',
  'location:Delete*',

  // --- Messaging & Events (additional) ---
  'kinesis:Delete*',
  'kafka:Delete*',
  'mq:Delete*',

  // --- Security & Compliance (additional) ---
  'kms:Delete*', 'kms:ScheduleKeyDeletion', 'kms:DisableKey',
  'secretsmanager:Delete*',
  'acm:Delete*',
  'cognito-idp:Delete*',
  'cognito-identity:Delete*',
  'guardduty:Delete*',
  'inspector:Delete*', 'inspector2:Delete*',
  'securityhub:Delete*', 'securityhub:Disable*',
  'auditmanager:Delete*', 'auditmanager:Deregister*',

  // --- Management & Governance (additional) ---
  'states:Delete*',
  'dlm:Delete*',
  'organizations:Delete*', 'organizations:Remove*', 'organizations:Deregister*',
  'ram:Delete*', 'ram:Disassociate*',
  'resiliencehub:Delete*',
  'proton:Delete*',
  'license-manager:Delete*',
  'billingconductor:Delete*', 'billingconductor:Disassociate*',
  'opsworks:Delete*', 'opsworks:Deregister*',

  // --- Directory & Identity ---
  'ds:Delete*', 'ds:Disable*',

  // --- App & Web ---
  'amplify:Delete*',
  'appconfig:Delete*',
  'appflow:Delete*',

  // --- Analytics & BI ---
  'quicksight:Delete*',
  'databrew:Delete*',
  'datapipeline:Delete*',
  'kinesisanalytics:Delete*',
  'lakeformation:Delete*', 'lakeformation:Deregister*',
  'glue:Delete*',

  // --- AI/ML ---
  'forecast:Delete*',
  'frauddetector:Delete*',
  'kendra:Delete*',
  'lex:Delete*',
  'lookoutmetrics:Delete*',
  'personalize:Delete*',
  'rekognition:Delete*',
  'wisdom:Delete*',
  'evidently:Delete*',

  // --- Media ---
  'ivs:Delete*',
  'mediaconnect:Delete*', 'mediaconnect:Remove*',
  'medialive:Delete*',
  'mediapackage:Delete*',
  'mediastore:Delete*',

  // --- Desktop & Workspace ---
  'cloud9:Delete*',
  'workspaces:Delete*', 'workspaces:Terminate*',
  'nimble:Delete*',

  // --- Monitoring (additional) ---
  'grafana:Delete*',
  'rum:Delete*',
  'xray:Delete*',
  'signer:Delete*', 'signer:Revoke*',

  // --- Mobile & Engagement ---
  'pinpoint:Delete*',
  'devicefarm:Delete*',

  // --- Developer Tools (additional) ---
  'codepipeline:Delete*',
  'codeartifact:Delete*',

  // --- Data Integration ---
  'connect:Delete*', 'connect:Disassociate*',
  'profile:Delete*',

  // --- Healthcare ---
  'healthlake:Delete*',

  // --- Robotics ---
  'robomaker:Delete*',

  // --- Data Transfer & Migration ---
  'transfer:Delete*',
  'dms:Delete*',
  'datasync:Delete*',

  // --- IoT & Edge (additional) ---
  'iotsitewise:Delete*',
  'greengrass:Delete*',
  'groundstation:Delete*',

  // --- Gaming ---
  'gamelift:Delete*',

  // --- Managed Workflows ---
  'airflow:Delete*',

  // --- Voice ---
  'voiceid:Delete*',
];

/**
 * Returns the set of IAM service namespaces covered by the deny list.
 */
export function getCoveredServiceNamespaces(): Set<string> {
  const namespaces = new Set<string>();
  for (const action of DENY_DESTRUCTIVE_ACTIONS) {
    const colonIdx = action.indexOf(':');
    if (colonIdx > 0) {
      namespaces.add(action.substring(0, colonIdx));
    }
  }
  return namespaces;
}

/**
 * Known mappings from CloudFormation service namespace (the middle segment of
 * AWS::<Service>::<Resource>) to IAM service namespace.
 */
const CF_TO_IAM_NAMESPACE: Record<string, string> = {
  ACMPCA: 'acm-pca',
  AccessAnalyzer: 'access-analyzer',
  AmazonMQ: 'mq',
  Amplify: 'amplify',
  ApiGateway: 'apigateway',
  AppConfig: 'appconfig',
  AppFlow: 'appflow',
  AppRunner: 'apprunner',
  AppStream: 'appstream',
  AppSync: 'appsync',
  Athena: 'athena',
  AuditManager: 'auditmanager',
  AutoScaling: 'autoscaling',
  Backup: 'backup',
  Batch: 'batch',
  BillingConductor: 'billingconductor',
  CE: 'ce',
  Cassandra: 'cassandra',
  CertificateManager: 'acm',
  Chatbot: 'chatbot',
  Cloud9: 'cloud9',
  CloudFormation: 'cloudformation',
  CloudFront: 'cloudfront',
  CloudTrail: 'cloudtrail',
  CloudWatch: 'cloudwatch',
  CodeArtifact: 'codeartifact',
  CodeBuild: 'codebuild',
  CodeGuruProfiler: 'codeguruprofiler',
  CodePipeline: 'codepipeline',
  CodeStarConnections: 'codestar-connections',
  Cognito: 'cognito-idp',
  Config: 'config',
  Connect: 'connect',
  CustomerProfiles: 'profile',
  DAX: 'dax',
  DLM: 'dlm',
  DMS: 'dms',
  DataBrew: 'databrew',
  DataPipeline: 'datapipeline',
  DataSync: 'datasync',
  Detective: 'detective',
  DeviceFarm: 'devicefarm',
  DirectoryService: 'ds',
  DocDB: 'docdb',
  DynamoDB: 'dynamodb',
  EC2: 'ec2',
  ECR: 'ecr',
  ECS: 'ecs',
  EFS: 'efs',
  EKS: 'eks',
  EMR: 'emr',
  EMRServerless: 'emr-serverless',
  ElastiCache: 'elasticache',
  ElasticLoadBalancing: 'elasticloadbalancing',
  ElasticLoadBalancingV2: 'elasticloadbalancing',
  Elasticsearch: 'es',
  EventSchemas: 'schemas',
  Events: 'events',
  Evidently: 'evidently',
  FMS: 'fms',
  FSx: 'fsx',
  Forecast: 'forecast',
  FraudDetector: 'frauddetector',
  GameLift: 'gamelift',
  GlobalAccelerator: 'globalaccelerator',
  Grafana: 'grafana',
  Greengrass: 'greengrass',
  GroundStation: 'groundstation',
  GuardDuty: 'guardduty',
  HealthLake: 'healthlake',
  IAM: 'iam',
  IVS: 'ivs',
  ImageBuilder: 'imagebuilder',
  Inspector: 'inspector',
  Inspector2: 'inspector2',
  IoT: 'iot',
  IoTSiteWise: 'iotsitewise',
  KMS: 'kms',
  Kendra: 'kendra',
  Kinesis: 'kinesis',
  KinesisAnalyticsV2: 'kinesisanalytics',
  KinesisFirehose: 'firehose',
  LakeFormation: 'lakeformation',
  Lambda: 'lambda',
  Lex: 'lex',
  LicenseManager: 'license-manager',
  Location: 'location',
  Logs: 'logs',
  LookoutMetrics: 'lookoutmetrics',
  MWAA: 'airflow',
  MSK: 'kafka',
  Macie: 'macie2',
  MediaConnect: 'mediaconnect',
  MediaLive: 'medialive',
  MediaPackage: 'mediapackage',
  MediaStore: 'mediastore',
  MemoryDB: 'memorydb',
  Neptune: 'neptune',
  NetworkManager: 'networkmanager',
  NimbleStudio: 'nimble',
  OpenSearchService: 'opensearch',
  OpsWorks: 'opsworks',
  Organizations: 'organizations',
  Personalize: 'personalize',
  Pinpoint: 'pinpoint',
  Proton: 'proton',
  QLDB: 'qldb',
  QuickSight: 'quicksight',
  RAM: 'ram',
  RDS: 'rds',
  RUM: 'rum',
  Redshift: 'redshift',
  Rekognition: 'rekognition',
  ResilienceHub: 'resiliencehub',
  ResourceGroups: 'resource-groups',
  RoboMaker: 'robomaker',
  Route53: 'route53',
  Route53Resolver: 'route53resolver',
  S3: 's3',
  S3ObjectLambda: 's3-object-lambda',
  S3Outposts: 's3-outposts',
  SES: 'ses',
  SNS: 'sns',
  SQS: 'sqs',
  SSM: 'ssm',
  SageMaker: 'sagemaker',
  SecretsManager: 'secretsmanager',
  SecurityHub: 'securityhub',
  ServiceCatalog: 'servicecatalog',
  ServiceDiscovery: 'servicediscovery',
  Signer: 'signer',
  StepFunctions: 'states',
  Synthetics: 'synthetics',
  Timestream: 'timestream',
  Transfer: 'transfer',
  VoiceID: 'voiceid',
  WAFv2: 'wafv2',
  Wisdom: 'wisdom',
  WorkSpaces: 'workspaces',
  XRay: 'xray',
};

/**
 * Given a CloudFormation resource type (e.g. AWS::EC2::Instance),
 * return the IAM service namespace (e.g. 'ec2'), or undefined if unknown.
 */
export function cfTypeToIamNamespace(resourceType: string): string | undefined {
  const parts = resourceType.split('::');
  if (parts.length < 2) return undefined;
  const cfNs = parts[1];
  return CF_TO_IAM_NAMESPACE[cfNs] ?? cfNs.toLowerCase();
}

/**
 * Build the CloudFormation template for the restrictive service role.
 * Uses per-service IAM wildcard patterns to deny destructive operations
 * across all commonly CloudFormation-managed services.
 */
function buildBootstrapTemplate(region: string): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'cfn-drift-remediate safety role — allows reads and updates, denies all destructive operations.',
    Resources: {
      ServiceRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `cfn-drift-remediate-role-${region}`,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'cloudformation.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            ],
          },
          Policies: [
            {
              PolicyName: 'AllowAll',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: '*',
                    Resource: '*',
                  },
                ],
              },
            },
            {
              PolicyName: 'DenyDestructive',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Sid: 'DenyDestructive',
                    Effect: 'Deny',
                    Action: DENY_DESTRUCTIVE_ACTIONS,
                    Resource: '*',
                  },
                ],
              },
            },
          ],
        },
      },
    },
    Outputs: {
      RoleArn: {
        Value: { 'Fn::GetAtt': ['ServiceRole', 'Arn'] },
        Description: 'ARN of the cfn-drift-remediate safety role',
      },
    },
  }, null, 2);
}

/**
 * Ensure the bootstrap safety role exists and return its ARN.
 * Creates the role stack on first use (with confirmation unless autoApprove).
 */
export async function getOrCreateServiceRole(
  client: CfnClientWrapper,
  autoApprove: boolean,
  verbose: boolean,
): Promise<string> {
  const log = verbose ? (msg: string) => console.log(chalk.dim(`  [bootstrap] ${msg}`)) : () => {};
  const stackName = bootstrapStackName(client.region);

  // Check if bootstrap stack already exists
  try {
    const stackInfo = await client.getStackInfo(stackName);
    const status = stackInfo.stackStatus;

    log(`Found bootstrap stack: ${status}`);

    // Stable — extract role ARN
    if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') {
      const roleArn = stackInfo.outputs?.find((o) => o.OutputKey === 'RoleArn')?.OutputValue;
      if (!roleArn) {
        throw new Error(
          `Bootstrap stack ${stackName} exists but has no RoleArn output. `
          + 'Delete the stack and re-run to recreate it.',
        );
      }
      log(`Using role: ${roleArn}`);
      return roleArn;
    }

    // In progress — wait
    if (status.endsWith('_IN_PROGRESS')) {
      throw new Error(
        `Bootstrap stack ${stackName} is currently being modified (${status}). `
        + 'Please wait for it to complete and re-run.',
      );
    }

    // Failed state — guidance
    throw new Error(
      `Bootstrap stack ${stackName} is in a failed state (${status}). `
      + `Delete it with: aws cloudformation delete-stack --stack-name ${stackName}\n`
      + 'Then re-run this tool to recreate it.',
    );
  } catch (error: unknown) {
    // Stack not found — proceed to create
    if (error instanceof Error && error.message.includes('does not exist')) {
      // fall through to creation below
    } else {
      throw error;
    }
  }

  // Stack doesn't exist — create it
  if (!autoApprove) {
    console.log(chalk.bold.yellow(
      '\ncfn-drift-remediate needs to create a safety role (one-time setup per region).',
    ));
    console.log(chalk.dim(
      'This role allows CloudFormation to read and update resources during drift remediation\n'
      + 'but denies all destructive operations (delete, terminate, etc.).',
    ));
    console.log(chalk.dim(`Stack name: ${stackName}\n`));

    const proceed = await confirm({
      message: 'Create the safety role now?',
      default: true,
    });

    if (!proceed) {
      throw new Error(
        'Cannot proceed without the safety role. '
        + 'Re-run with --yes to auto-create.',
      );
    }
  }

  log('Creating bootstrap stack...');
  console.log(chalk.dim(`  Creating ${stackName} stack (one-time setup)...`));

  await client.createStack(stackName, buildBootstrapTemplate(client.region));

  // Fetch the newly created stack's outputs
  const stackInfo = await client.getStackInfo(stackName);
  const roleArn = stackInfo.outputs?.find((o) => o.OutputKey === 'RoleArn')?.OutputValue;

  if (!roleArn) {
    throw new Error(
      `Bootstrap stack ${stackName} was created but has no RoleArn output. This is a bug.`,
    );
  }

  console.log(chalk.green(`  Safety role created: ${roleArn}`));
  return roleArn;
}
