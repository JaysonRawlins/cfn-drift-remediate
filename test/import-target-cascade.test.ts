import {
  buildRestoreTemplate,
  detachFromRemovedResources,
  transformTemplateForRemoval,
} from '../src/lib/template-transformer';
import { CloudFormationTemplate, ImportTarget } from '../src/lib/types';

/**
 * Stack shape from issue #62: an RDS primary deleted out of band, and a read
 * replica that was promoted to standalone in AWS. The replica is simultaneously
 * a re-import target (MODIFIED -> autofix) and a dependent of the deleted
 * primary, because its template still points at the primary.
 */
function replicaStack(): CloudFormationTemplate {
  return {
    Resources: {
      MainDb: {
        Type: 'AWS::RDS::DBInstance',
        Properties: { DBInstanceClass: 'db.t3.micro' },
        DeletionPolicy: 'Snapshot',
      },
      MainReadReplica: {
        Type: 'AWS::RDS::DBInstance',
        Properties: {
          DBInstanceClass: 'db.t3.micro',
          SourceDBInstanceIdentifier: {
            'Fn::Join': ['', ['arn:aws:rds:us-east-2:123456789012:db:', { Ref: 'MainDb' }]],
          },
        },
      },
    },
  };
}

const REPLICA_ACTUAL_PROPERTIES = {
  DBInstanceClass: 'db.t3.micro',
  DBInstanceIdentifier: 'main-read-replica',
};

describe('detachFromRemovedResources', () => {
  it('prefers non-empty preferred properties over the template properties', () => {
    const resource = replicaStack().Resources.MainReadReplica;

    const detached = detachFromRemovedResources(
      resource,
      new Set(['MainDb']),
      new Map(),
      REPLICA_ACTUAL_PROPERTIES,
    );

    expect(detached.Properties).toEqual(REPLICA_ACTUAL_PROPERTIES);
    expect(detached.Properties).not.toHaveProperty('SourceDBInstanceIdentifier');
  });

  it('falls back to resolved literals when there are no preferred properties', () => {
    const resource = replicaStack().Resources.MainReadReplica;

    const detached = detachFromRemovedResources(
      resource,
      new Set(['MainDb']),
      new Map<string, unknown>([['Ref:MainDb', 'main-db-dev']]),
    );

    expect(detached.Properties!.SourceDBInstanceIdentifier).toEqual({
      'Fn::Join': ['', ['arn:aws:rds:us-east-2:123456789012:db:', 'main-db-dev']],
    });
  });

  it('leaves properties untouched when nothing references a removed resource', () => {
    const resource = {
      Type: 'AWS::SQS::Queue',
      Properties: { QueueName: 'my-queue', Tags: [{ Key: 'Env', Value: 'test' }] },
    };

    const detached = detachFromRemovedResources(resource, new Set(['MainDb']), new Map());

    expect(detached.Properties).toEqual(resource.Properties);
  });

  it('does not invent a Properties key on a resource that has none', () => {
    const resource = { Type: 'AWS::SNS::Topic' };

    const detached = detachFromRemovedResources(resource, new Set(['MainDb']), new Map());

    expect('Properties' in detached).toBe(false);
  });

  it('drops a string DependsOn naming a removed resource', () => {
    const resource = { Type: 'AWS::SQS::Queue', DependsOn: 'MainDb' };

    const detached = detachFromRemovedResources(resource, new Set(['MainDb']), new Map());

    expect(detached.DependsOn).toBeUndefined();
  });

  it('filters array DependsOn down to the surviving resources', () => {
    const resource = { Type: 'AWS::SQS::Queue', DependsOn: ['MainDb', 'OtherResource'] };

    const detached = detachFromRemovedResources(resource, new Set(['MainDb']), new Map());

    expect(detached.DependsOn).toEqual(['OtherResource']);
  });

  it('preserves the rest of the resource definition', () => {
    const resource = {
      Type: 'AWS::RDS::DBInstance',
      Properties: { Ref: 'unused' },
      Condition: 'IsProd',
      DeletionPolicy: 'Snapshot' as const,
      UpdateReplacePolicy: 'Snapshot' as const,
      Metadata: { 'aws:cdk:path': 'Stack/Replica' },
    };

    const detached = detachFromRemovedResources(resource, new Set(['MainDb']), new Map());

    expect(detached.Type).toBe('AWS::RDS::DBInstance');
    expect(detached.Condition).toBe('IsProd');
    expect(detached.DeletionPolicy).toBe('Snapshot');
    expect(detached.UpdateReplacePolicy).toBe('Snapshot');
    expect(detached.Metadata).toEqual({ 'aws:cdk:path': 'Stack/Replica' });
  });

  it('does not mutate the resource it was given', () => {
    const template = replicaStack();
    const resource = template.Resources.MainReadReplica;

    detachFromRemovedResources(resource, new Set(['MainDb']), new Map(), REPLICA_ACTUAL_PROPERTIES);

    expect(resource.Properties).toEqual(replicaStack().Resources.MainReadReplica.Properties);
  });
});

describe('buildRestoreTemplate', () => {
  it('keeps a re-import target that references a permanently removed resource (issue #62)', () => {
    const importTargets: ImportTarget[] = [
      { logicalResourceId: 'MainReadReplica', actualProperties: REPLICA_ACTUAL_PROPERTIES },
    ];

    const { template, removedResources } = buildRestoreTemplate(
      replicaStack(),
      new Set(['MainDb']),
      importTargets,
      new Map(),
    );

    expect(Object.keys(template.Resources)).toEqual(['MainReadReplica']);
    expect(removedResources).not.toContain('MainReadReplica');
    expect(template.Resources.MainReadReplica.Properties).toEqual(REPLICA_ACTUAL_PROPERTIES);
  });

  it('documents the cascade that orphaned the re-import target before the fix', () => {
    // Step 10 used to rebuild the template straight from the original and run the
    // removal cascade over it, which swept the replica back out of the stack.
    const base = replicaStack();
    delete base.Resources.MainDb;

    const { template } = transformTemplateForRemoval(base, new Set(['MainDb']), new Map());

    expect(template.Resources.MainReadReplica).toBeUndefined();
  });

  it('still cascade-removes a plain dependent that is not a re-import target', () => {
    const { template, removedResources } = buildRestoreTemplate(
      replicaStack(),
      new Set(['MainDb']),
      [],
      new Map(),
    );

    expect(template.Resources.MainReadReplica).toBeUndefined();
    expect(removedResources).toContain('MainReadReplica');
  });

  it('reports the re-import target as removed when its references cannot be resolved', () => {
    // No actual properties and no resolved value for Ref:MainDb — the stale
    // reference survives, so the cascade still takes it. The caller needs to
    // know, rather than report a silent success.
    const { template, removedResources } = buildRestoreTemplate(
      replicaStack(),
      new Set(['MainDb']),
      [{ logicalResourceId: 'MainReadReplica' }],
      new Map(),
    );

    expect(template.Resources.MainReadReplica).toBeUndefined();
    expect(removedResources).toContain('MainReadReplica');
  });

  it('applies the import-target resolved values only to import targets', () => {
    // A plain cascade dependent is meant to be removed for good — it is warned
    // about and reported that way up front — so the values resolved for the
    // DELETED resource must not rescue it along with the re-import target.
    const template = replicaStack();
    template.Resources.PlainDependent = {
      Type: 'AWS::SQS::Queue',
      Properties: { Tags: [{ Key: 'PrimaryDb', Value: { Ref: 'MainDb' } }] },
    };

    const { template: restored, removedResources } = buildRestoreTemplate(
      template,
      new Set(['MainDb']),
      [{ logicalResourceId: 'MainReadReplica' }],
      new Map(),
      new Map<string, unknown>([['Ref:MainDb', 'main-db-dev']]),
    );

    expect(restored.Resources.MainReadReplica).toBeDefined();
    expect(restored.Resources.PlainDependent).toBeUndefined();
    expect(removedResources).toContain('PlainDependent');
  });

  it('restores the original DeletionPolicy and strips the temporary Retain', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        KeptBucket: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain' },
        PlainQueue: { Type: 'AWS::SQS::Queue' },
      },
    };

    const { template: restored } = buildRestoreTemplate(template, new Set(), [], new Map());

    expect(restored.Resources.KeptBucket.DeletionPolicy).toBe('Retain');
    expect(restored.Resources.PlainQueue.DeletionPolicy).toBeUndefined();
  });

  it('leaves a re-import target that references nothing removed on its template properties', () => {
    // Drift is remediated by restoring the template and letting CloudFormation
    // converge the resource, so actual properties must NOT win here.
    const template: CloudFormationTemplate = {
      Resources: {
        TestBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { Tags: [{ Key: 'Environment', Value: 'test' }] },
        },
      },
    };

    const { template: restored } = buildRestoreTemplate(
      template,
      new Set(),
      [{
        logicalResourceId: 'TestBucket',
        actualProperties: { Tags: [{ Key: 'Environment', Value: 'DRIFTED' }] },
      }],
      new Map(),
    );

    expect(restored.Resources.TestBucket.Properties).toEqual({
      Tags: [{ Key: 'Environment', Value: 'test' }],
    });
  });

  it('drops Outputs that reference a removed resource but keeps the rest', () => {
    const template = replicaStack();
    template.Outputs = {
      PrimaryRef: { Value: { Ref: 'MainDb' } },
      ReplicaRef: { Value: { Ref: 'MainReadReplica' } },
    };

    const { template: restored } = buildRestoreTemplate(
      template,
      new Set(['MainDb']),
      [{ logicalResourceId: 'MainReadReplica', actualProperties: REPLICA_ACTUAL_PROPERTIES }],
      new Map(),
    );

    expect(restored.Outputs).toEqual({ ReplicaRef: { Value: { Ref: 'MainReadReplica' } } });
  });

  it('does not mutate the original template', () => {
    const original = replicaStack();

    buildRestoreTemplate(
      original,
      new Set(['MainDb']),
      [{ logicalResourceId: 'MainReadReplica', actualProperties: REPLICA_ACTUAL_PROPERTIES }],
      new Map(),
    );

    expect(original).toEqual(replicaStack());
  });
});
