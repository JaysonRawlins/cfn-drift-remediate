import { buildPlan, serializePlan, loadPlan, planToDecisions } from '../src/lib/plan';
import { DriftedResource, InteractiveDecisions, PlanMetadata } from '../src/lib/types';

const makeDriftedResource = (overrides: Partial<DriftedResource> = {}): DriftedResource => ({
  logicalResourceId: 'MyBucket',
  resourceType: 'AWS::S3::Bucket',
  physicalResourceId: 'my-bucket-123',
  stackResourceDriftStatus: 'MODIFIED',
  ...overrides,
});

const metadata: PlanMetadata = {
  stackName: 'TestStack',
  region: 'us-east-2',
  createdAt: '2026-02-25T19:00:00.000Z',
  toolVersion: '0.1.0',
  driftDetectionId: 'arn:aws:cloudformation:us-east-2:123:drift-detection/abc',
};

describe('buildPlan', () => {
  it('builds a plan from decisions with all action types', () => {
    const autofixResource = makeDriftedResource({ logicalResourceId: 'Bucket1' });
    const reimportResource = makeDriftedResource({
      logicalResourceId: 'DeletedDB',
      stackResourceDriftStatus: 'DELETED',
      resourceType: 'AWS::RDS::DBInstance',
    });
    const removeResource = makeDriftedResource({
      logicalResourceId: 'OldQueue',
      stackResourceDriftStatus: 'DELETED',
      resourceType: 'AWS::SQS::Queue',
    });
    const skipResource = makeDriftedResource({ logicalResourceId: 'SkippedThing' });

    const decisions: InteractiveDecisions = {
      autofix: [autofixResource],
      reimport: [{ resource: reimportResource, physicalId: 'new-db-instance' }],
      remove: [removeResource],
      skip: [skipResource],
    };

    const plan = buildPlan(metadata, decisions);

    expect(plan.version).toBe(1);
    expect(plan.metadata).toEqual(metadata);
    expect(plan.decisions).toHaveLength(4);

    expect(plan.decisions[0]).toEqual({
      logicalResourceId: 'Bucket1',
      resourceType: 'AWS::S3::Bucket',
      driftStatus: 'MODIFIED',
      physicalResourceId: 'my-bucket-123',
      action: 'autofix',
    });

    expect(plan.decisions[1]).toEqual({
      logicalResourceId: 'DeletedDB',
      resourceType: 'AWS::RDS::DBInstance',
      driftStatus: 'DELETED',
      physicalResourceId: 'my-bucket-123',
      action: 'reimport',
      reimportPhysicalId: 'new-db-instance',
    });

    expect(plan.decisions[2].action).toBe('remove');
    expect(plan.decisions[3].action).toBe('skip');

    expect(Object.keys(plan._resources)).toHaveLength(4);
    expect(plan._resources.Bucket1).toEqual(autofixResource);
  });

  it('handles empty decisions', () => {
    const decisions: InteractiveDecisions = {
      autofix: [],
      reimport: [],
      remove: [],
      skip: [],
    };
    const plan = buildPlan(metadata, decisions);
    expect(plan.decisions).toHaveLength(0);
    expect(Object.keys(plan._resources)).toHaveLength(0);
  });
});

describe('serializePlan', () => {
  it('produces valid formatted JSON', () => {
    const decisions: InteractiveDecisions = {
      autofix: [makeDriftedResource()],
      reimport: [],
      remove: [],
      skip: [],
    };
    const plan = buildPlan(metadata, decisions);
    const json = serializePlan(plan);

    expect(() => JSON.parse(json)).not.toThrow();
    // 2-space indentation
    expect(json).toContain('  "version": 1');
  });
});

describe('loadPlan', () => {
  const validPlan = () => {
    const decisions: InteractiveDecisions = {
      autofix: [makeDriftedResource()],
      reimport: [],
      remove: [],
      skip: [],
    };
    return buildPlan(metadata, decisions);
  };

  it('loads a valid plan', () => {
    const plan = validPlan();
    const loaded = loadPlan(serializePlan(plan), 'TestStack');
    expect(loaded.version).toBe(1);
    expect(loaded.decisions).toHaveLength(1);
    expect(loaded.metadata.stackName).toBe('TestStack');
  });

  it('throws on invalid JSON', () => {
    expect(() => loadPlan('not json', 'TestStack')).toThrow('not valid JSON');
  });

  it('throws on wrong version', () => {
    const plan = validPlan();
    const json = serializePlan(plan).replace('"version": 1', '"version": 99');
    expect(() => loadPlan(json, 'TestStack')).toThrow('Unsupported plan version: 99');
  });

  it('throws on stack name mismatch', () => {
    const plan = validPlan();
    expect(() => loadPlan(serializePlan(plan), 'OtherStack')).toThrow(
      'does not match target stack "OtherStack"',
    );
  });

  it('throws on missing metadata', () => {
    const json = JSON.stringify({ version: 1, decisions: [], _resources: {} });
    expect(() => loadPlan(json, 'TestStack')).toThrow('missing metadata');
  });

  it('throws on missing decisions array', () => {
    const plan = validPlan();
    const raw = JSON.parse(serializePlan(plan));
    delete raw.decisions;
    expect(() => loadPlan(JSON.stringify(raw), 'TestStack')).toThrow('decisions must be an array');
  });

  it('throws on invalid action', () => {
    const plan = validPlan();
    const raw = JSON.parse(serializePlan(plan));
    raw.decisions[0].action = 'destroy';
    expect(() => loadPlan(JSON.stringify(raw), 'TestStack')).toThrow('Invalid action "destroy"');
  });

  it('throws on reimport without reimportPhysicalId', () => {
    const plan = validPlan();
    const raw = JSON.parse(serializePlan(plan));
    raw.decisions[0].action = 'reimport';
    delete raw.decisions[0].reimportPhysicalId;
    expect(() => loadPlan(JSON.stringify(raw), 'TestStack')).toThrow(
      'no reimportPhysicalId',
    );
  });

  it('throws on missing _resources', () => {
    const plan = validPlan();
    const raw = JSON.parse(serializePlan(plan));
    delete raw._resources;
    expect(() => loadPlan(JSON.stringify(raw), 'TestStack')).toThrow('missing _resources');
  });
});

describe('planToDecisions', () => {
  it('round-trips correctly through buildPlan → planToDecisions', () => {
    const autofix = makeDriftedResource({ logicalResourceId: 'A' });
    const reimport = makeDriftedResource({
      logicalResourceId: 'B',
      stackResourceDriftStatus: 'DELETED',
    });
    const remove = makeDriftedResource({ logicalResourceId: 'C' });
    const skip = makeDriftedResource({ logicalResourceId: 'D' });

    const originalDecisions: InteractiveDecisions = {
      autofix: [autofix],
      reimport: [{ resource: reimport, physicalId: 'new-b' }],
      remove: [remove],
      skip: [skip],
    };

    const plan = buildPlan(metadata, originalDecisions);
    const { decisions, allDriftedResources } = planToDecisions(plan);

    expect(decisions.autofix).toHaveLength(1);
    expect(decisions.autofix[0].logicalResourceId).toBe('A');
    expect(decisions.reimport).toHaveLength(1);
    expect(decisions.reimport[0].physicalId).toBe('new-b');
    expect(decisions.remove).toHaveLength(1);
    expect(decisions.remove[0].logicalResourceId).toBe('C');
    expect(decisions.skip).toHaveLength(1);
    expect(decisions.skip[0].logicalResourceId).toBe('D');
    expect(allDriftedResources).toHaveLength(4);
  });

  it('treats resources in _resources but not in decisions as skip', () => {
    const plan = buildPlan(metadata, {
      autofix: [makeDriftedResource({ logicalResourceId: 'A' })],
      reimport: [],
      remove: [],
      skip: [makeDriftedResource({ logicalResourceId: 'B' })],
    });

    // Remove B from decisions array (simulating user deleting the entry)
    plan.decisions = plan.decisions.filter((d) => d.logicalResourceId !== 'B');

    const { decisions } = planToDecisions(plan);
    expect(decisions.autofix).toHaveLength(1);
    expect(decisions.skip).toHaveLength(1);
    expect(decisions.skip[0].logicalResourceId).toBe('B');
  });

  it('throws when decision references unknown resource', () => {
    const plan = buildPlan(metadata, {
      autofix: [makeDriftedResource({ logicalResourceId: 'A' })],
      reimport: [],
      remove: [],
      skip: [],
    });

    // Add a decision for a resource not in _resources
    plan.decisions.push({
      logicalResourceId: 'Ghost',
      resourceType: 'AWS::S3::Bucket',
      driftStatus: 'MODIFIED',
      physicalResourceId: 'ghost-bucket',
      action: 'autofix',
    });

    expect(() => planToDecisions(plan)).toThrow('not found in plan _resources');
  });

  it('allows user to change action from autofix to skip', () => {
    const plan = buildPlan(metadata, {
      autofix: [makeDriftedResource({ logicalResourceId: 'A' })],
      reimport: [],
      remove: [],
      skip: [],
    });

    // User edits the plan file, changing autofix → skip
    plan.decisions[0].action = 'skip';

    const { decisions } = planToDecisions(plan);
    expect(decisions.autofix).toHaveLength(0);
    expect(decisions.skip).toHaveLength(1);
    expect(decisions.skip[0].logicalResourceId).toBe('A');
  });
});
