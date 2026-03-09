import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  DetectStackDriftCommand,
  DescribeStackDriftDetectionStatusCommand,
  DescribeStackResourceCommand,
  DescribeStackResourceDriftsCommand,
  DescribeStackEventsCommand,
  DescribeTypeCommand,
  ListStackResourcesCommand,
  UpdateStackCommand,
  CreateStackCommand,
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
  serviceRoleArn?: string;
}

export interface StackInfo {
  stackId: string;
  stackName: string;
  stackStatus: string;
  parameters: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
}

/**
 * Wrapper around CloudFormation client with drift remediation operations
 */
export class CfnClientWrapper {
  private client: CloudFormationClient;
  private credentials: ReturnType<typeof fromNodeProviderChain>;
  private cloudControlClient?: CloudControlClient;
  private s3Client?: S3Client;
  private stsClient?: STSClient;
  private s3BucketName?: string;
  private resolvedBucket?: string;
  private uploadedKeys: string[] = [];
  private resourceTypeCache = new Map<string, { provisioningType?: string; hasReadHandler: boolean } | undefined>();
  private serviceRoleArn?: string;
  public readonly region: string;

  constructor(options: CfnClientOptions = {}) {
    this.region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    this.s3BucketName = options.s3BucketName;
    this.serviceRoleArn = options.serviceRoleArn;

    const profile = options.profile || process.env.AWS_PROFILE;
    this.credentials = fromNodeProviderChain(profile ? { profile } : undefined);

    this.client = new CloudFormationClient({
      region: this.region,
      credentials: this.credentials,
    });
  }

  /**
   * Set the CloudFormation service role ARN used for stack operations.
   */
  setServiceRoleArn(arn: string): void {
    this.serviceRoleArn = arn;
  }

  private getCloudControlClient(): CloudControlClient {
    if (!this.cloudControlClient) {
      this.cloudControlClient = new CloudControlClient({ region: this.region, credentials: this.credentials });
    }
    return this.cloudControlClient;
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
      stackStatus: stack.StackStatus!,
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
          RoleARN: this.serviceRoleArn,
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
   * Create a new CloudFormation stack and wait for completion.
   * Does NOT use the service role — the bootstrap stack is created with the caller's own permissions.
   */
  async createStack(
    stackName: string,
    templateBody: string,
    capabilities: string[] = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
  ): Promise<void> {
    await this.client.send(
      new CreateStackCommand({
        StackName: stackName,
        TemplateBody: templateBody,
        Capabilities: capabilities as Capability[],
      }),
    );

    await this.waitForStackCreate(stackName);
  }

  /**
   * Wait for stack creation to complete.
   */
  async waitForStackCreate(stackName: string, maxWaitMinutes: number = 10): Promise<void> {
    const startTime = new Date();
    const maxAttempts = maxWaitMinutes * 6;
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

      if (status === 'CREATE_COMPLETE') {
        return;
      }

      if (status === 'ROLLBACK_COMPLETE' || status === 'CREATE_FAILED') {
        let message = `Stack creation failed: ${stack.StackStatusReason || 'Unknown reason'}`;
        try {
          const events = await this.getRecentStackEvents(stackName, startTime);
          message += this.formatFailedEvents(events);
        } catch {
          // Best-effort event tailing
        }
        throw new Error(message);
      }
    }

    throw new Error(`Timeout waiting for stack creation after ${maxWaitMinutes} minutes`);
  }

  /**
   * Get recent stack events, optionally filtered to events after a given timestamp.
   */
  async getRecentStackEvents(
    stackName: string,
    sinceTimestamp?: Date,
  ): Promise<Array<{
      timestamp: Date;
      resourceType: string;
      logicalResourceId: string;
      resourceStatus: string;
      resourceStatusReason?: string;
    }>> {
    const response = await this.client.send(
      new DescribeStackEventsCommand({ StackName: stackName }),
    );

    const events = (response.StackEvents || [])
      .filter((e) => !sinceTimestamp || (e.Timestamp && e.Timestamp >= sinceTimestamp))
      .map((e) => ({
        timestamp: e.Timestamp!,
        resourceType: e.ResourceType || '',
        logicalResourceId: e.LogicalResourceId || '',
        resourceStatus: e.ResourceStatus || '',
        resourceStatusReason: e.ResourceStatusReason,
      }));

    return events;
  }

  private formatFailedEvents(
    events: Array<{
      resourceType: string;
      logicalResourceId: string;
      resourceStatus: string;
      resourceStatusReason?: string;
    }>,
  ): string {
    const failedEvents = events.filter((e) => e.resourceStatus.includes('FAILED'));
    if (failedEvents.length === 0) return '';

    const lines = failedEvents.map(
      (e) => `  - ${e.logicalResourceId} (${e.resourceType}): ${e.resourceStatus} — ${e.resourceStatusReason || 'No reason given'}`,
    );
    return '\nFailed resource events:\n' + lines.join('\n');
  }

  /**
   * Wait for stack update to complete
   */
  async waitForStackUpdate(stackName: string, maxWaitMinutes: number = 60): Promise<void> {
    const startTime = new Date();
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
          let message = `Stack update rolled back: ${stack.StackStatusReason || 'Unknown reason'}`;
          try {
            const events = await this.getRecentStackEvents(stackName, startTime);
            message += this.formatFailedEvents(events);
          } catch {
            // Best-effort event tailing
          }
          throw new Error(message);
        }
      }

      if (status?.endsWith('_FAILED')) {
        let message = `Stack operation failed: ${status} - ${stack.StackStatusReason || 'Unknown reason'}`;
        try {
          const events = await this.getRecentStackEvents(stackName, startTime);
          message += this.formatFailedEvents(events);
        } catch {
          // Best-effort event tailing
        }
        throw new Error(message);
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
        RoleARN: this.serviceRoleArn,
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
   * Get the physical resource ID for a stack resource.
   */
  async getPhysicalResourceId(stackName: string, logicalResourceId: string): Promise<string | undefined> {
    try {
      const response = await this.client.send(
        new DescribeStackResourceCommand({
          StackName: stackName,
          LogicalResourceId: logicalResourceId,
        }),
      );
      return response.StackResourceDetail?.PhysicalResourceId;
    } catch {
      return undefined;
    }
  }

  /**
   * Get all logical resource IDs currently in the stack.
   * Paginates ListStackResources to collect the full set.
   */
  async getStackResourceIds(stackName: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let nextToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListStackResourcesCommand({
          StackName: stackName,
          NextToken: nextToken,
        }),
      );

      for (const summary of response.StackResourceSummaries || []) {
        if (summary.LogicalResourceId) {
          ids.add(summary.LogicalResourceId);
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return ids;
  }

  /**
   * Read actual properties of a resource via CloudControl API.
   * Returns parsed properties or undefined if the resource type is unsupported.
   */
  async getResourceProperties(
    typeName: string,
    identifier: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.getCloudControlClient().send(
        new GetResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
        }),
      );
      const props = response.ResourceDescription?.Properties;
      return props ? JSON.parse(props) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Describe a CloudFormation resource type to check its provisioning type and handler support.
   * Results are cached per run. Returns undefined if the type cannot be described (API error, not found).
   */
  async describeResourceType(typeName: string): Promise<{
    provisioningType?: string;
    hasReadHandler: boolean;
  } | undefined> {
    if (this.resourceTypeCache.has(typeName)) {
      return this.resourceTypeCache.get(typeName);
    }

    try {
      const response = await this.client.send(
        new DescribeTypeCommand({
          Type: 'RESOURCE',
          TypeName: typeName,
        }),
      );

      let hasReadHandler = false;
      if (response.Schema) {
        try {
          const schema = JSON.parse(response.Schema);
          hasReadHandler = !!(schema.handlers && schema.handlers.read);
        } catch {
          hasReadHandler = false;
        }
      }

      const result = {
        provisioningType: response.ProvisioningType,
        hasReadHandler,
      };
      this.resourceTypeCache.set(typeName, result);
      return result;
    } catch {
      this.resourceTypeCache.set(typeName, undefined);
      return undefined;
    }
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
