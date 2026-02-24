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
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { DriftedResource, ResourceToImport } from './types';
import { sleep } from './utils';

export interface CfnClientOptions {
  region?: string;
  profile?: string;
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
  public readonly region: string;

  constructor(options: CfnClientOptions = {}) {
    this.region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

    const profile = options.profile || process.env.AWS_PROFILE;
    const credentials = fromNodeProviderChain(profile ? { profile } : undefined);

    this.client = new CloudFormationClient({
      region: this.region,
      credentials,
    });
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
        };
      }

      if (status === 'DETECTION_FAILED') {
        throw new Error(
          `Drift detection failed: ${response.DetectionStatusReason || 'Unknown reason'}`,
        );
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
   * Get resource identifier summaries from template
   */
  async getResourceIdentifiers(templateBody: string): Promise<Map<string, string[]>> {
    const response = await this.client.send(
      new GetTemplateSummaryCommand({ TemplateBody: templateBody }),
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
      await this.client.send(
        new UpdateStackCommand({
          StackName: stackName,
          TemplateBody: templateBody,
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

    await this.client.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: ChangeSetType.IMPORT,
        TemplateBody: templateBody,
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
