# Integration Test: CDK Stack with ALB → EC2 → RDS

Live integration test for `cfn-drift-remediate`. Deploys a realistic multi-resource stack, introduces drift (deleted DB + modified EC2 tags), then runs the tool interactively.

## Architecture

```
Internet → ALB (public) → EC2/nginx (private) → RDS PostgreSQL (private)
                                    ↕
                        Security groups wired via
                     database.connections.allowDefaultPortFrom()
```

## Cost

~$0.10/hour (t3.micro EC2 + t3.micro RDS + NAT Gateway + ALB). **Remember to run cleanup when done.**

## Prerequisites

- AWS CLI v2 with `jq` installed
- Node.js 20+
- AWS credentials configured

## Steps

### 1. Build the CLI tool

```bash
cd /path/to/cfn-drift-remediate
NODE_ENV=development npx projen compile
```

### 2. Install CDK dependencies

```bash
cd test/integration/cdk-test-app
npm install
```

### 3. Deploy the test stack (~15 minutes)

```bash
export AWS_PROFILE=JJRawlins-Dev-590183750202-AdministratorAccess
export AWS_REGION=us-east-2
npx cdk deploy --require-approval never
```

### 4. Break the stack (~15 minutes)

Deletes the RDS DB, creates a replacement with different name, modifies EC2 tags.

```bash
bash scripts/break-stack.sh
```

Note the replacement DB identifier printed at the end (`drift-test-replacement-db`).

### 5a. Run drift remediation (interactive)

```bash
bash scripts/run-remediation.sh
```

When prompted:
- **MODIFIED EC2 instance** → choose **Autofix**
- **DELETED RDS DB instance** → choose **Re-import**, enter: `drift-test-replacement-db`

### 5b. Alternative: Plan workflow

Export decisions to a file, review, then apply:

```bash
# Export plan (runs drift detection + prompts, but doesn't execute)
npx ts-node ../../src/index.ts CfnDriftTestStack \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --export-plan plan.json

# Review/edit plan.json, then apply
npx ts-node ../../src/index.ts CfnDriftTestStack \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --apply-plan plan.json
```

### 6. Verify

```bash
aws cloudformation detect-stack-drift --stack-name CfnDriftTestStack \
  --region us-east-2 --profile "$AWS_PROFILE"

# Wait ~30 seconds, then:
aws cloudformation describe-stack-resource-drifts \
  --stack-name CfnDriftTestStack \
  --stack-resource-drift-status-filters MODIFIED DELETED \
  --region us-east-2 --profile "$AWS_PROFILE"
# Should return empty results (no drift)
```

### 7. Cleanup

```bash
bash scripts/cleanup.sh
```

## What This Tests

1. **DELETED drift + reimport**: RDS deletion detected, user provides replacement DB identifier
2. **MODIFIED drift + autofix**: EC2 tag changes detected, reimported with actual state
3. **Cross-reference resolution**: RDS outputs/references resolved before resource removal
4. **DeletionPolicy:Retain safety net**: No resources accidentally deleted during remediation
5. **CDK connections pattern**: SecurityGroupIngress/Egress rules survive DB deletion (SG intact)
6. **Interactive UX**: Per-resource prompts, colored diffs, confirmation flow
7. **Template restore**: Original template restored after import
8. **Plan workflow**: Export/apply plan files for auditable, repeatable remediation
