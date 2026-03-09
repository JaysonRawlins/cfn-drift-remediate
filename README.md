# cfn-drift-remediate

CLI tool that remediates AWS CloudFormation stack drift. Detects drifted resources, safely removes them from the stack (with `DeletionPolicy: Retain`), then re-imports them with their actual current state.

Supports interactive, plan-based, and resumable workflows. Never deletes AWS resources — all mutations use `DeletionPolicy: Retain` combined with a restrictive IAM safety role that denies all destructive operations.

## Install

```bash
npm install -g @jjrawlins/cfn-drift-remediate
```

## Quick start

```bash
# Interactive mode — prompts for each drifted resource
cfn-drift-remediate MyStack --region us-east-2

# Auto-accept defaults (MODIFIED → autofix, DELETED → remove)
cfn-drift-remediate MyStack --yes

# Dry run — show what would be done without touching the stack
cfn-drift-remediate MyStack --dry-run
```

## Usage examples

### Basic remediation

```bash
# Remediate drift on a stack using a named profile
cfn-drift-remediate MyStack --profile prod-account --region us-east-1

# Verbose output to see every API call
cfn-drift-remediate MyStack --verbose
```

### Plan workflow

Export decisions to a JSON file for review or auditing, then apply later:

```bash
# 1. Detect drift and make decisions, export to file (no stack changes)
cfn-drift-remediate MyStack --export-plan plan.json

# 2. Review/edit plan.json — change actions, remove entries, etc.

# 3. Preview what the plan would do
cfn-drift-remediate MyStack --apply-plan plan.json --dry-run

# 4. Apply the plan
cfn-drift-remediate MyStack --apply-plan plan.json
```

The plan file is human-readable JSON:

```json
{
  "version": 1,
  "metadata": { "stackName": "MyStack", "region": "us-east-2" },
  "decisions": [
    {
      "logicalResourceId": "MyBucket",
      "resourceType": "AWS::S3::Bucket",
      "driftStatus": "MODIFIED",
      "action": "autofix"
    }
  ]
}
```

Valid actions: `autofix`, `reimport`, `remove`, `skip`.

### Resume after failure

If a remediation fails mid-step, the tool saves a checkpoint file automatically. Resume from where it left off:

```bash
# The checkpoint file path is shown in the error output
cfn-drift-remediate MyStack --resume .cfn-drift-remediate-backup-MyStack-2026-03-06T12-34-56-789Z.json
```

The checkpoint preserves all intermediate state: original template, user decisions, resolved references, and which steps completed. No re-prompting on resume.

### Large templates

Templates over 51,200 bytes are automatically uploaded to S3. The tool auto-detects the CDK bootstrap bucket, or you can specify one:

```bash
cfn-drift-remediate MyStack --s3-bucket my-cfn-templates-bucket
```

## Options

| Flag | Description |
|------|-------------|
| `-r, --region <region>` | AWS region (defaults to `AWS_REGION`) |
| `-p, --profile <profile>` | AWS profile (defaults to `AWS_PROFILE`) |
| `--dry-run` | Show planned actions without executing |
| `-y, --yes` | Skip interactive prompts, accept defaults |
| `-v, --verbose` | Enable verbose output |
| `--export-plan <file>` | Export remediation plan to file (no execution) |
| `--apply-plan <file>` | Apply a previously exported plan |
| `--resume <file>` | Resume from a checkpoint after a previous failure |
| `--s3-bucket <bucket>` | S3 bucket for large templates (auto-detects CDK bootstrap bucket) |

Mutually exclusive: `--resume` cannot be combined with `--export-plan`, `--apply-plan`, or `--dry-run`.

## How it works

### Planning phase (read-only)

1. **Fetch stack info and template** — retrieves stack metadata and current CloudFormation template
2. **Detect drift** — triggers the CloudFormation drift detection API and polls until complete
3. **Categorize resources** — separates drifted resources by status (MODIFIED/DELETED) and whether they support CloudFormation import (~120 supported types)
4. **Collect decisions** — prompts for each resource: autofix, reimport, remove, or skip. Non-importable DELETED resources are automatically removed.
5. **Prepare** — builds `ResourceToImport` descriptors, analyzes cascade dependencies, runs pre-flight checks, saves recovery checkpoint

### Mutation phase (modifies the stack)

6. **Retain and remove DELETED resources** — sets `DeletionPolicy: Retain` on all resources (safety net so nothing gets deleted from AWS), then removes DELETED resources from the template. If DELETED resources have cascade dependencies, resolves their broken references via CloudControl API first.
7. **Resolve cross-references** — identifies resources with `Ref`/`GetAtt` pointing to MODIFIED resources being removed. Adds temporary Outputs to resolve those values for later use.
8. **Remove MODIFIED resources** — removes MODIFIED resources from the template. Replaces broken references with the resolved literal values from step 7. Resources are retained in AWS.
9. **Import resources** — builds an import template and creates a CloudFormation IMPORT change set to bring the resources back under stack management with their actual current state.
10. **Restore template** — restores the original template (minus any permanently removed resources), cleaning up temporary Retain policies and resolution Outputs.

### Cascade dependencies

When a resource is removed from the stack, other resources that reference it via `Ref` or `GetAtt` become invalid. CloudFormation re-evaluates *all* intrinsic functions during any update — not just the changed parts — so broken references cause update failures.

The tool handles this automatically:

- **Detection**: identifies all resources with `Ref`/`GetAtt` to resources being removed
- **Resolution**: reads actual property values from AWS via CloudControl `GetResource`, replaces broken intrinsic functions with resolved literal values, and sets `DeletionPolicy: Retain` on cascade-dependent resources before removal
- **User notification**: displays a warning listing all cascade removals before execution

Common cascade patterns:
- `AWS::SecretsManager::SecretTargetAttachment` referencing a database via `!Ref`
- CDK-generated `SecurityGroupIngress`/`Egress` referencing `!GetAtt Database.Endpoint.Port`
- SNS Subscriptions referencing `!Ref Topic` and `!GetAtt Queue.Arn`

### Pre-flight checks

Before executing mutations on stacks with DELETED resources and cascade dependencies, the tool checks whether each cascade-dependent resource type supports CloudControl read operations. Types that don't support CloudControl (non-provisionable types or types without a read handler) use placeholder values as a fallback. This is safe because the auto-bootstrapped safety role prevents any accidental resource deletion.

## Safety role (auto-bootstrap)

On first use in each region, the tool automatically creates a CloudFormation stack (`cfn-drift-remediate-role-<region>`) containing a restrictive IAM service role. This role is used for all stack operations during remediation.

**What it does:**
- **Allows** all read and update operations (`Allow: *`)
- **Denies** all destructive operations across ~35 AWS service namespaces using per-service IAM wildcard patterns (e.g., `ec2:Delete*`, `rds:Delete*`, `s3:Delete*`, `iam:Delete*`, `ec2:Terminate*`, `ec2:Revoke*`, etc.), plus specific actions like `kms:ScheduleKeyDeletion`, `rds:StopDBInstance`, etc.

This provides belt-and-suspenders protection: even if `DeletionPolicy: Retain` were somehow bypassed, the IAM role prevents CloudFormation from executing any destructive API calls.

**First run:**
```
cfn-drift-remediate needs to create a safety role (one-time setup per region).
This role allows CloudFormation to read and update resources during drift remediation
but denies all destructive operations (delete, terminate, etc.).

? Create the safety role now? (Y/n)
```

Use `--yes` to auto-approve the creation.

**IAM permissions for bootstrap:** The caller needs `iam:CreateRole`, `iam:PutRolePolicy`, and `cloudformation:CreateStack` permissions for the one-time bootstrap. These are standard permissions for anyone managing CloudFormation stacks.

**Cleanup:** To remove the safety role from a region:
```bash
aws cloudformation delete-stack --stack-name cfn-drift-remediate-role-us-east-2
```

## Error recovery

### Automatic checkpoints

A recovery checkpoint is saved to disk before any stack mutations begin. The checkpoint file (`.cfn-drift-remediate-backup-<stackName>-<timestamp>.json`) contains:

- The original template (for manual rollback)
- Stack parameters, capabilities, and resource identifiers
- User decisions and resolved reference values
- Progress tracking (last completed step)

### Structured error output

When a step fails, the tool reports:

```
Drift remediation failed

  Failed at: Step 9: Import resources via change set
  Error: Change set creation failed: Resource already exists

  Stack state:
    Drifted resources removed from stack but still exist in AWS (Retain).
    Import may be partially complete.

  Recovery options:
    To retry from where it left off:
      cfn-drift-remediate MyStack --resume .cfn-drift-remediate-backup-MyStack-...json

    Check stack status:
      aws cloudformation describe-stacks --stack-name MyStack --query 'Stacks[0].StackStatus'
```

### Manual recovery

If `--resume` isn't sufficient, the checkpoint file contains the original template body. You can manually restore the stack:

```bash
# Extract original template from checkpoint
jq -r '.originalTemplateBody' .cfn-drift-remediate-backup-MyStack-*.json > original.json

# Restore the stack
aws cloudformation update-stack \
  --stack-name MyStack \
  --template-body file://original.json \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
```

## Supported resource types

The tool supports ~120 CloudFormation resource types that are eligible for import, including:

- **Compute**: EC2 instances, Auto Scaling groups, Lambda functions, ECS clusters/services/tasks
- **Storage**: S3 buckets, EFS file systems, DynamoDB tables
- **Database**: RDS instances and clusters, DynamoDB tables
- **Networking**: VPCs, subnets, security groups, ELBv2 load balancers, Route53 hosted zones, CloudFront distributions
- **IAM**: Roles, policies, instance profiles, users, groups
- **Messaging**: SQS queues, SNS topics
- **Monitoring**: CloudWatch alarms, log groups
- **And more**: API Gateway, WAFv2, Secrets Manager, SSM, CodeBuild, StepFunctions, etc.

Non-importable resource types are reported but require manual remediation.

## Caveats and limitations

### Resource type coverage

- Only ~120 resource types support CloudFormation import (out of 800+ total). Non-importable MODIFIED resources are reported but can't be auto-fixed — update your IaC source to match the actual state instead.
- The importable type list is based on the [Former2](https://github.com/iann0036/former2) registry and may lag behind newly added CloudFormation support.

### CloudControl dependency

- Cascade dependency resolution (for DELETED resources) uses the CloudControl `GetResource` API when available. Resource types that are `NON_PROVISIONABLE` or lack a read handler automatically fall back to placeholder values. This is safe because the safety role prevents any destructive operations.

### Stack state

- The stack must be in a `*_COMPLETE` state to begin remediation.
- If a previous remediation failed and the stack is in `UPDATE_ROLLBACK_COMPLETE` or `IMPORT_ROLLBACK_COMPLETE`, use `--resume` to retry from the last successful step.
- If the stack enters `*_FAILED` state, manual intervention via the AWS Console or CLI is required before the tool can continue.

### CloudFormation intrinsic function re-evaluation

- CloudFormation re-evaluates **all** intrinsic functions (`Ref`, `GetAtt`, `Sub`, etc.) across the **entire** template during any update — not just the changed parts. This is why cascade dependency resolution is necessary even for metadata-only changes like setting `DeletionPolicy`.

### Template size

- Templates up to 51,200 bytes are passed inline. Larger templates require an S3 bucket — the tool auto-detects the CDK bootstrap bucket (`cdk-hnb659fds-assets-{accountId}-{region}`) or you can specify one with `--s3-bucket`.

### Checkpoints and resume

- Only v2 checkpoints (created with this version or later) support `--resume`. Older checkpoint files still contain the original template for manual recovery.
- `--resume` replays the original decisions — there's no re-prompting. If you need different decisions, start a fresh run.
- The checkpoint file must match the stack name passed on the command line.

## IAM permissions required

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:DetectStackDrift",
        "cloudformation:DescribeStackDriftDetectionStatus",
        "cloudformation:DescribeStackResourceDrifts",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackResource",
        "cloudformation:ListStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:UpdateStack",
        "cloudformation:CreateStack",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DescribeType"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudcontrol:GetResource"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:GetRole",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::*:role/cfn-drift-remediate-role-*",
      "Condition": { "_comment": "Only needed for one-time safety role bootstrap" }
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:HeadBucket"
      ],
      "Resource": "arn:aws:s3:::cdk-*",
      "Condition": { "_comment": "Only needed for large templates" }
    },
    {
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
```

## Development

```bash
npx projen build    # Full pipeline: projen synth → compile → test → package
npx projen compile  # TypeScript compile only
npx projen test     # Run Jest unit tests + ESLint
npx projen watch    # Watch mode
```

This project uses [projen](https://projen.io/). Edit `.projenrc.ts` and run `npx projen` to regenerate config files.

## License

Apache-2.0
