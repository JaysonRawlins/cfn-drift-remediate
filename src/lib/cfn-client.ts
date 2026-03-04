import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  DetectStackDriftCommand,
  DescribeStackDriftDetectionStatusCommand,
  DescribeStackResourceDriftsCommand,
  UpdateStackCommand,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  ExecuteChangeSetCommand,
  GetTemplateSummaryCommand,
  StackResourceDriftStatus,
  ChangeSetType,
  Capability,
} from '@aws-sdk/client-cloudformation';
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { DriftedResource, ResourceToImport } from './types';
import { sleep } from './utils';

const MAX_TEMPLATE_BODY_BYTES = 51_200;

export interface CfnClientOptions {
  region?: string;
  profile?: string;
  s3BucketName?: string;
}

export interface StackInfo {
  stackId: string;
  stackName: string;
  parameters: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
}

/**
 * Wrapper around CloudFormation client with drift remediation operations
 */
export class CfnClientWrapper {
  private client: CloudFormationClient;
  private credentials: ReturnType<typeof fromNodeProviderChain>;
  private s3Client?: S3Client;
  private stsClient?: STSClient;
  private s3BucketName?: string;
  private resolvedBucket?: string;
  private uploadedKeys: string[] = [];
  public readonly region: string;

  constructor(options: CfnClientOptions = {}) {
    this.region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    this.s3BucketName = options.s3BucketName;

    const profile = options.profile || process.env.AWS_PROFILE;
    this.credentials = fromNodeProviderChain(profile ? { profile } : undefined);

    this.client = new CloudFormationClient({
      region: this.region,
      credentials: this.credentials,
    });
  }

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({ region: this.region, credentials: this.credentials });
    }
    return this.s3Client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient({ region: this.region, credentials: this.credentials });
    }
    return this.stsClient;
  }

  /**
   * Resolve an S3 bucket for template uploads.
   * Priority: explicit s3BucketName > CDK bootstrap bucket auto-detect.
   */
  private async resolveBucket(): Promise<string> {
    if (this.resolvedBucket) return this.resolvedBucket;

    if (this.s3BucketName) {
      this.resolvedBucket = this.s3BucketName;
      return this.resolvedBucket;
    }

    // Try CDK bootstrap bucket: cdk-hnb659fds-assets-{accountId}-{region}
    try {
      const identity = await this.getStsClient().send(new GetCallerIdentityCommand({}));
      const accountId = identity.Account;
      if (accountId) {
        const cdkBucket = `cdk-hnb659fds-assets-${accountId}-${this.region}`;
        await this.getS3Client().send(new HeadBucketCommand({ Bucket: cdkBucket }));
        this.resolvedBucket = cdkBucket;
        return this.resolvedBucket;
      }
    } catch {
      // CDK bootstrap bucket not found — fall through to error
    }

    throw new Error(
      'Template exceeds 51,200-byte CloudFormation limit and no S3 bucket is available for upload. '
      + 'Provide a bucket via --s3-bucket, or bootstrap CDK in this account/region (npx cdk bootstrap).',
    );
  }

  /**
   * Resolve template for CloudFormation API calls.
   * Small templates use TemplateBody directly; large ones are uploaded to S3.
   */
  private async resolveTemplate(templateBody: string): Promise<{ TemplateBody?: string; TemplateURL?: string }> {
    if (Buffer.byteLength(templateBody, 'utf-8') <= MAX_TEMPLATE_BODY_BYTES) {
      return { TemplateBody: templateBody };
    }

    const bucket = await this.resolveBucket();
    const key = `cfn-drift-remediate/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;

    await this.getS3Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: templateBody,
      ContentType: 'application/json',
    }));

    this.uploadedKeys.push(key);

    const templateUrl = `https://s3.${this.region}.amazonaws.com/${bucket}/${key}`;
    return { TemplateURL: templateUrl };
  }

  /**
   * Clean up any templates uploaded to S3 during this session. Best-effort.
   */
  async cleanupTemplates(): Promise<void> {
    if (this.uploadedKeys.length === 0) return;

    const bucket = this.resolvedBucket;
    if (!bucket) return;

    for (const key of this.uploadedKeys) {
      try {
        await this.getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        // Best-effort cleanup — ignore failures
      }
    }
    this.uploadedKeys = [];
  }

  /**
   * Get stack information including ID, name, and parameters
   */
  async getStackInfo(stackName: string): Promise<StackInfo> {
    const response = await this.client.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );

    const stack = response.Stacks?.[0];
    if (!stack) {
      throw new Error(`Stack not found: ${stackName}`);
    }

    return {
      stackId: stack.StackId!,
      stackName: stack.StackName!,
      parameters: stack.Parameters?.map((p) => ({
        ParameterKey: p.ParameterKey,
        ParameterValue: p.ParameterValue,
      })) || [],
      outputs: stack.Outputs?.map((o) => ({
        OutputKey: o.OutputKey,
        OutputValue: o.OutputValue,
      })),
    };
  }

  /**
   * Get the original template for a stack
   */
  async getTemplate(stackName: string, processed: boolean = false): Promise<string> {
    const response = await this.client.send(
      new GetTemplateCommand({
        StackName: stackName,
        TemplateStage: processed ? 'Processed' : 'Original',
      }),
    );

    const templateBody = response.TemplateBody;
    if (!templateBody) {
      throw new Error(`Could not retrieve template for stack: ${stackName}`);
    }

    // Handle case where template is returned as an object (OrderedDict in Python equivalent)
    if (typeof templateBody === 'object') {
      return JSON.stringify(templateBody);
    }

    return templateBody;
  }

  /**
   * Start drift detection on a stack
   */
  async detectDrift(stackName: string): Promise<string> {
    const response = await this.client.send(
      new DetectStackDriftCommand({ StackName: stackName }),
    );

    if (!response.StackDriftDetectionId) {
      throw new Error('Failed to start drift detection');
    }

    return response.StackDriftDetectionId;
  }

  /**
   * Wait for drift detection to complete
   */
  async waitForDriftDetection(detectionId: string): Promise<{
    status: string;
    driftStatus?: string;
    statusReason?: string;
  }> {
    let status = 'DETECTION_IN_PROGRESS';

    while (status === 'DETECTION_IN_PROGRESS') {
      await sleep(5000);

      const response = await this.client.send(
        new DescribeStackDriftDetectionStatusCommand({
          StackDriftDetectionId: detectionId,
        }),
      );

      status = response.DetectionStatus || 'UNKNOWN';

      if (status === 'DETECTION_COMPLETE') {
        return {
          status,
          driftStatus: response.StackDriftStatus,
          statusReason: response.DetectionStatusReason,
        };
      }

      if (status === 'DETECTION_FAILED') {
        // Partial failure — some resources may have been successfully checked.
        // Return instead of throwing so the caller can proceed with partial results.
        return {
          status,
          driftStatus: response.StackDriftStatus,
          statusReason: response.DetectionStatusReason || 'Unknown reason',
        };
      }
    }

    return { status };
  }

  /**
   * Get all drifted resources (MODIFIED or DELETED)
   */
  async getDriftedResources(stackName: string): Promise<DriftedResource[]> {
    const results: DriftedResource[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.client.send(
        new DescribeStackResourceDriftsCommand({
          StackName: stackName,
          NextToken: nextToken,
          StackResourceDriftStatusFilters: [
            StackResourceDriftStatus.MODIFIED,
            StackResourceDriftStatus.DELETED,
          ],
          MaxResults: 100,
        }),
      );

      for (const drift of response.StackResourceDrifts || []) {
        results.push({
          logicalResourceId: drift.LogicalResourceId!,
          resourceType: drift.ResourceType!,
          physicalResourceId: drift.PhysicalResourceId || '',
          stackResourceDriftStatus: drift.StackResourceDriftStatus as 'MODIFIED' | 'DELETED',
          propertyDifferences: drift.PropertyDifferences?.map((pd) => ({
            propertyPath: pd.PropertyPath || '',
            expectedValue: pd.ExpectedValue || '',
            actualValue: pd.ActualValue || '',
            differenceType: pd.DifferenceType as 'ADD' | 'REMOVE' | 'NOT_EQUAL',
          })),
          actualProperties: drift.ActualProperties
            ? JSON.parse(drift.ActualProperties)
            : undefined,
          expectedProperties: drift.ExpectedProperties
            ? JSON.parse(drift.ExpectedProperties)
            : undefined,
          physicalResourceIdContext: drift.PhysicalResourceIdContext?.map((ctx) => ({
            key: ctx.Key!,
            value: ctx.Value!,
          })),
        });
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return results;
  }

  /**
   * Get resource identifier summaries for a stack.
   * Uses StackName to avoid the 51,200-byte TemplateBody size limit.
   */
  async getResourceIdentifiers(stackName: string): Promise<Map<string, string[]>> {
    const response = await this.client.send(
      new GetTemplateSummaryCommand({ StackName: stackName }),
    );

    const identifiers = new Map<string, string[]>();
    for (const summary of response.ResourceIdentifierSummaries || []) {
      if (summary.ResourceType && summary.ResourceIdentifiers) {
        identifiers.set(summary.ResourceType, summary.ResourceIdentifiers);
      }
    }

    return identifiers;
  }

  /**
   * Update a stack with a new template
   */
  async updateStack(
    stackName: string,
    templateBody: string,
    parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>,
    capabilities: string[] = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
  ): Promise<void> {
    try {
      const templateParam = await this.resolveTemplate(templateBody);

      await this.client.send(
        new UpdateStackCommand({
          StackName: stackName,
          ...templateParam,
          Parameters: parameters?.map((p) => ({
            ParameterKey: p.ParameterKey,
            ParameterValue: p.ParameterValue,
          })),
          Capabilities: capabilities as Capability[],
        }),
      );

      await this.waitForStackUpdate(stackName);
    } catch (error: unknown) {
      // "No updates are to be performed" is not an error - it means the template is already applied
      if (error instanceof Error && error.message.includes('No updates are to be performed')) {
        return;
      }
      throw error;
    }
  }

  /**
   * Wait for stack update to complete
   */
  async waitForStackUpdate(stackName: string, maxWaitMinutes: number = 60): Promise<void> {
    const maxAttempts = maxWaitMinutes * 6; // Check every 10 seconds
    let attempts = 0;

    while (attempts < maxAttempts) {
      await sleep(10000);
      attempts++;

      const response = await this.client.send(
        new DescribeStacksCommand({ StackName: stackName }),
      );

      const stack = response.Stacks?.[0];
      if (!stack) {
        throw new Error(`Stack not found: ${stackName}`);
      }

      const status = stack.StackStatus;

      if (status?.endsWith('_COMPLETE')) {
        if (status === 'UPDATE_COMPLETE' || status === 'IMPORT_COMPLETE') {
          return;
        }
        if (status === 'UPDATE_ROLLBACK_COMPLETE') {
          throw new Error(`Stack update rolled back: ${stack.StackStatusReason || 'Unknown reason'}`);
        }
      }

      if (status?.endsWith('_FAILED')) {
        throw new Error(`Stack operation failed: ${status} - ${stack.StackStatusReason || 'Unknown reason'}`);
      }
    }

    throw new Error(`Timeout waiting for stack update after ${maxWaitMinutes} minutes`);
  }

  /**
   * Create an import change set
   */
  async createImportChangeSet(
    stackName: string,
    templateBody: string,
    resourcesToImport: ResourceToImport[],
    capabilities: string[] = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
  ): Promise<string> {
    const changeSetName = `drift-remediate-${Date.now()}`;
    const templateParam = await this.resolveTemplate(templateBody);

    await this.client.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: ChangeSetType.IMPORT,
        ...templateParam,
        ResourcesToImport: resourcesToImport.map((r) => ({
          ResourceType: r.ResourceType,
          LogicalResourceId: r.LogicalResourceId,
          ResourceIdentifier: r.ResourceIdentifier,
        })),
        Capabilities: capabilities as Capability[],
      }),
    );

    await this.waitForChangeSetCreate(stackName, changeSetName);

    return changeSetName;
  }

  /**
   * Wait for change set creation to complete
   */
  async waitForChangeSetCreate(
    stackName: string,
    changeSetName: string,
    maxWaitMinutes: number = 5,
  ): Promise<void> {
    const maxAttempts = maxWaitMinutes * 6;
    let attempts = 0;

    while (attempts < maxAttempts) {
      await sleep(10000);
      attempts++;

      const response = await this.client.send(
        new DescribeChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
        }),
      );

      const status = response.Status;

      if (status === 'CREATE_COMPLETE') {
        return;
      }

      if (status === 'FAILED') {
        throw new Error(`Change set creation failed: ${response.StatusReason || 'Unknown reason'}`);
      }
    }

    throw new Error(`Timeout waiting for change set creation after ${maxWaitMinutes} minutes`);
  }

  /**
   * Execute a change set
   */
  async executeChangeSet(stackName: string, changeSetName: string): Promise<void> {
    await this.client.send(
      new ExecuteChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
      }),
    );

    await this.waitForStackUpdate(stackName);
  }
}
