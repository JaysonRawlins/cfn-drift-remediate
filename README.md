# cfn-drift-remediate

CLI tool that remediates AWS CloudFormation stack drift. Detects drifted resources, safely removes them from the stack (with `DeletionPolicy: Retain`), then re-imports them with their actual current state. Supports interactive and plan-based workflows.

## Install

```bash
npm install -g @jjrawlins/cfn-drift-remediate
```

## Usage

```bash
# Interactive mode (default)
cfn-drift-remediate MyStack --region us-east-2

# Auto-accept defaults (all MODIFIED → autofix, all DELETED → remove)
cfn-drift-remediate MyStack --yes

# Dry run — show what would be done without making changes
cfn-drift-remediate MyStack --dry-run
```

### Plan workflow

Export decisions to a JSON file for review or auditing, then apply later:

```bash
# 1. Detect drift and make decisions, export to file (no changes made)
cfn-drift-remediate MyStack --export-plan plan.json

# 2. Review/edit plan.json — change actions, remove entries, etc.

# 3. Preview what the plan would do
cfn-drift-remediate MyStack --apply-plan plan.json --dry-run

# 4. Apply the plan
cfn-drift-remediate MyStack --apply-plan plan.json
```

The plan file is human-readable JSON with a `decisions` array you can edit:

```json
{
  "version": 1,
  "metadata": { "stackName": "MyStack", "region": "us-east-2", ... },
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

## How it works

1. Fetch stack info and current template
2. Detect drift via CloudFormation drift detection API
3. Filter to importable resource types (~100 supported)
4. Prompt for per-resource decisions (autofix, reimport, remove, skip)
5. Set `DeletionPolicy: Retain` on all resources (safety net)
6. Resolve cross-references to resources being removed
7. Remove drifted resources from the template (resources retained in AWS)
8. Re-import resources via CloudFormation IMPORT change set
9. Restore the original template

A recovery checkpoint is saved before any stack mutations for manual rollback if needed.

## Supported resource types

The tool supports ~100 CloudFormation resource types that are eligible for import, including:

- EC2 (instances, security groups, VPCs, subnets, etc.)
- RDS (DB instances, clusters, subnet groups)
- S3 buckets
- Lambda functions
- ELB/ALB (load balancers, target groups, listeners)
- IAM (roles, policies, instance profiles)
- DynamoDB tables
- SQS queues, SNS topics
- And many more

## Development

```bash
yarn build          # Full pipeline: projen synth, compile, test, package
yarn compile        # TypeScript compile only
yarn test           # Run Jest unit tests + ESLint
yarn watch          # Watch mode
```

This project uses [projen](https://projen.io/). Edit `.projenrc.ts` and run `npx projen` to regenerate config files.

## License

Apache-2.0
