import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class DriftTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC - 2 AZs (required for RDS subnet group), 1 NAT gateway to minimize cost
    const vpc = new ec2.Vpc(this, 'TestVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // EC2 Instance with nginx
    const instance = new ec2.Instance(this, 'WebServer', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    instance.addUserData(
      'dnf install -y nginx',
      'systemctl start nginx',
      'systemctl enable nginx',
    );

    // Tags on EC2 for drift testing (break script will modify these)
    cdk.Tags.of(instance).add('Environment', 'test');
    cdk.Tags.of(instance).add('ManagedBy', 'CloudFormation');

    // Allow HTTP from ALB (will be updated by addTargets below)
    instance.connections.allowFromAnyIpv4(ec2.Port.tcp(80), 'Allow HTTP');

    // RDS PostgreSQL - minimal config for testing
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      multiAz: false,
      allocatedStorage: 20,
      backupRetention: cdk.Duration.days(0),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      databaseName: 'testdb',
    });

    // CDK connections pattern - auto-wires security group rules
    // This creates SecurityGroupIngress on the DB SG (allow 5432 from instance SG)
    // and SecurityGroupEgress on the instance SG (allow to DB SG on 5432)
    database.connections.allowDefaultPortFrom(instance, 'EC2 to RDS');

    // ALB - internet-facing
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
    });

    // Wire ALB -> EC2 via target group
    listener.addTargets('WebTargets', {
      port: 80,
      targets: [new elbv2_targets.InstanceTarget(instance)],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });

    // S3 Bucket - private by default (break script will make it public)
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Lambda Function - inline code, no deployment package needed
    const fn = new lambda.Function(this, 'DriftTestFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async (event) => { return { statusCode: 200, body: "OK" }; };',
      ),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
    });

    // EventBridge Rule wired to Lambda (auto-creates AWS::Lambda::Permission)
    const rule = new events.Rule(this, 'DriftTestRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Drift test scheduled rule',
      enabled: true,
    });
    rule.addTarget(new targets.LambdaFunction(fn));

    // Stack outputs for use by break/cleanup scripts
    new cdk.CfnOutput(this, 'DbInstanceIdentifier', {
      value: database.instanceIdentifier,
      description: 'RDS DB Instance Identifier',
    });
    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: database.dbInstanceEndpointAddress,
      description: 'RDS Endpoint Address',
    });
    new cdk.CfnOutput(this, 'Ec2InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
    });
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS Name',
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 Bucket Name',
    });
    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: fn.functionName,
      description: 'Lambda Function Name',
    });
    new cdk.CfnOutput(this, 'EventRuleName', {
      value: rule.ruleName,
      description: 'EventBridge Rule Name',
    });
  }
}
