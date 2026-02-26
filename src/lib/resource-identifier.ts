import { getImportProperties } from './eligible-resources';

/**
 * Parsed components of an AWS ARN
 */
export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  accountId: string;
  /** Everything after account-id (resource-type/resource-id or resource-type:resource-id) */
  resourcePart: string;
}

/**
 * Parse an ARN string into its components.
 * Returns null if the string is not a valid ARN.
 *
 * ARN format: arn:partition:service:region:account-id:resource
 */
export function parseArn(arn: string): ParsedArn | null {
  if (!arn.startsWith('arn:')) return null;

  const parts = arn.split(':');
  if (parts.length < 6) return null;

  return {
    partition: parts[1],
    service: parts[2],
    region: parts[3],
    accountId: parts[4],
    // Everything after the 5th colon is the resource part (may contain colons)
    resourcePart: parts.slice(5).join(':'),
  };
}

/**
 * Type-specific extraction rules that map a user-provided physical ID (ARN or plain name)
 * to the ResourceIdentifier map needed by CloudFormation import.
 */
type ExtractionRule = (physicalId: string, parsed: ParsedArn | null) => Record<string, string> | null;

const EXTRACTION_RULES: Record<string, ExtractionRule> = {
  'AWS::S3::Bucket': (physicalId, parsed) => {
    // S3 ARN: arn:aws:s3:::bucket-name (no region/account)
    const name = parsed ? parsed.resourcePart : physicalId;
    return { BucketName: name };
  },

  'AWS::SQS::Queue': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:sqs:region:account:queue-name
      const queueName = parsed.resourcePart;
      return { QueueUrl: `https://sqs.${parsed.region}.amazonaws.com/${parsed.accountId}/${queueName}` };
    }
    // Assume it's already a URL or queue name
    return { QueueUrl: physicalId };
  },

  'AWS::SNS::Topic': (physicalId, _parsed) => {
    // TopicArn expects the full ARN
    return { TopicArn: physicalId };
  },

  'AWS::SNS::Subscription': (physicalId, _parsed) => {
    return { SubscriptionArn: physicalId };
  },

  'AWS::Lambda::Function': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:lambda:region:account:function:function-name[:qualifier]
      const parts = parsed.resourcePart.split(':');
      // resourcePart = "function:my-function" or "function:my-function:qualifier"
      return { FunctionName: parts.length >= 2 ? parts[1] : parts[0] };
    }
    return { FunctionName: physicalId };
  },

  'AWS::DynamoDB::Table': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:dynamodb:region:account:table/table-name
      const match = parsed.resourcePart.match(/^table\/(.+)$/);
      return { TableName: match ? match[1] : parsed.resourcePart };
    }
    return { TableName: physicalId };
  },

  'AWS::IAM::Role': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:iam::account:role/[path/]role-name
      const parts = parsed.resourcePart.split('/');
      return { RoleName: parts[parts.length - 1] };
    }
    return { RoleName: physicalId };
  },

  'AWS::IAM::ManagedPolicy': (physicalId, _parsed) => {
    // PolicyArn expects full ARN
    return { PolicyArn: physicalId };
  },

  'AWS::IAM::User': (physicalId, parsed) => {
    if (parsed) {
      const parts = parsed.resourcePart.split('/');
      return { UserName: parts[parts.length - 1] };
    }
    return { UserName: physicalId };
  },

  'AWS::IAM::Group': (physicalId, parsed) => {
    if (parsed) {
      const parts = parsed.resourcePart.split('/');
      return { GroupName: parts[parts.length - 1] };
    }
    return { GroupName: physicalId };
  },

  'AWS::Logs::LogGroup': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:logs:region:account:log-group:log-group-name:*
      const match = parsed.resourcePart.match(/^log-group:(.+?)(?::\*)?$/);
      return { LogGroupName: match ? match[1] : parsed.resourcePart };
    }
    return { LogGroupName: physicalId };
  },

  'AWS::EC2::SecurityGroup': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:ec2:region:account:security-group/sg-xxx
      const match = parsed.resourcePart.match(/security-group\/(sg-[a-f0-9]+)/);
      return { GroupId: match ? match[1] : parsed.resourcePart };
    }
    return { GroupId: physicalId };
  },

  'AWS::EC2::Instance': (physicalId, parsed) => {
    if (parsed) {
      const match = parsed.resourcePart.match(/instance\/(i-[a-f0-9]+)/);
      return { InstanceId: match ? match[1] : parsed.resourcePart };
    }
    return { InstanceId: physicalId };
  },

  'AWS::EC2::VPC': (physicalId, parsed) => {
    if (parsed) {
      const match = parsed.resourcePart.match(/vpc\/(vpc-[a-f0-9]+)/);
      return { VpcId: match ? match[1] : parsed.resourcePart };
    }
    return { VpcId: physicalId };
  },

  'AWS::EC2::Subnet': (physicalId, parsed) => {
    if (parsed) {
      const match = parsed.resourcePart.match(/subnet\/(subnet-[a-f0-9]+)/);
      return { SubnetId: match ? match[1] : parsed.resourcePart };
    }
    return { SubnetId: physicalId };
  },

  'AWS::RDS::DBInstance': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:rds:region:account:db:instance-identifier
      const match = parsed.resourcePart.match(/^db:(.+)$/);
      return { DBInstanceIdentifier: match ? match[1] : parsed.resourcePart };
    }
    return { DBInstanceIdentifier: physicalId };
  },

  'AWS::RDS::DBCluster': (physicalId, parsed) => {
    if (parsed) {
      const match = parsed.resourcePart.match(/^cluster:(.+)$/);
      return { DBClusterIdentifier: match ? match[1] : parsed.resourcePart };
    }
    return { DBClusterIdentifier: physicalId };
  },

  'AWS::ECS::Cluster': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:ecs:region:account:cluster/cluster-name
      const match = parsed.resourcePart.match(/^cluster\/(.+)$/);
      return { ClusterName: match ? match[1] : parsed.resourcePart };
    }
    return { ClusterName: physicalId };
  },

  'AWS::ECS::Service': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:ecs:region:account:service/cluster-name/service-name
      const match = parsed.resourcePart.match(/^service\/([^/]+)\/(.+)$/);
      if (match) {
        return { ServiceArn: physicalId, Cluster: match[1] };
      }
    }
    // Cannot determine both identifiers without ARN
    return null;
  },

  'AWS::CloudWatch::Alarm': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:cloudwatch:region:account:alarm:alarm-name
      const match = parsed.resourcePart.match(/^alarm:(.+)$/);
      return { AlarmName: match ? match[1] : parsed.resourcePart };
    }
    return { AlarmName: physicalId };
  },

  'AWS::Route53::HostedZone': (physicalId, parsed) => {
    if (parsed) {
      const match = parsed.resourcePart.match(/hostedzone\/(.+)$/);
      return { HostedZoneId: match ? match[1] : parsed.resourcePart };
    }
    return { HostedZoneId: physicalId };
  },

  'AWS::ElasticLoadBalancingV2::LoadBalancer': (physicalId, _parsed) => {
    // LoadBalancerArn expects full ARN
    return { LoadBalancerArn: physicalId };
  },

  'AWS::ElasticLoadBalancingV2::TargetGroup': (physicalId, _parsed) => {
    return { TargetGroupArn: physicalId };
  },

  'AWS::ElasticLoadBalancingV2::Listener': (physicalId, _parsed) => {
    return { ListenerArn: physicalId };
  },

  'AWS::StepFunctions::StateMachine': (physicalId, _parsed) => {
    return { StateMachineArn: physicalId };
  },

  'AWS::Events::Rule': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:events:region:account:rule/[event-bus-name/]rule-name
      const match = parsed.resourcePart.match(/^rule\/(?:[^/]+\/)?(.+)$/);
      return { Name: match ? match[1] : parsed.resourcePart };
    }
    return { Name: physicalId };
  },

  'AWS::KMS::Key': (physicalId, parsed) => {
    if (parsed) {
      // ARN: arn:aws:kms:region:account:key/key-id
      const match = parsed.resourcePart.match(/^key\/(.+)$/);
      return { KeyId: match ? match[1] : parsed.resourcePart };
    }
    return { KeyId: physicalId };
  },
};

/**
 * Given a resource type and a user-provided physical ID (ARN or plain name/ID),
 * build the ResourceIdentifier map needed for CloudFormation import.
 *
 * Strategy:
 * 1. Try type-specific extraction rules (handles ARN parsing + format conversion)
 * 2. For types without explicit rules: if single identifier property, use physicalId directly
 * 3. For multi-property identifiers without rules, return null (cannot guess)
 */
export function buildIdentifierFromPhysicalId(
  resourceType: string,
  physicalId: string,
): Record<string, string> | null {
  const parsed = parseArn(physicalId);
  const rule = EXTRACTION_RULES[resourceType];

  if (rule) {
    return rule(physicalId, parsed);
  }

  // Generic fallback: if single identifier property, use physicalId directly
  const props = getImportProperties(resourceType);
  if (props.length === 1) {
    return { [props[0]]: physicalId };
  }

  // Multi-key identifier with no extraction rule — cannot determine
  return null;
}
