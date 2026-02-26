#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="CfnDriftTestStack"
REGION="${AWS_REGION:-us-east-2}"
PROFILE="${AWS_PROFILE:-jjrawlins-Dev-AdministratorAccess}"
NEW_DB_IDENTIFIER="drift-test-replacement-db"

echo "=== Cleaning Up Integration Test Resources ==="
echo ""

# Step 1: Delete the replacement RDS instance (if it exists)
echo "Step 1: Deleting replacement RDS: $NEW_DB_IDENTIFIER ..."
aws rds delete-db-instance \
  --db-instance-identifier "$NEW_DB_IDENTIFIER" \
  --skip-final-snapshot \
  --region "$REGION" \
  --profile "$PROFILE" 2>/dev/null && \
  echo "  Waiting for deletion..." && \
  aws rds wait db-instance-deleted \
    --db-instance-identifier "$NEW_DB_IDENTIFIER" \
    --region "$REGION" \
    --profile "$PROFILE" 2>/dev/null || echo "  (not found or already deleted)"

# Step 2: Delete the original/reimported RDS instance (if stack still has one)
ORIGINAL_DB=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='DbInstanceIdentifier'].OutputValue" \
  --output text 2>/dev/null || echo "")

if [ -n "$ORIGINAL_DB" ] && [ "$ORIGINAL_DB" != "None" ]; then
  echo "Step 2: Deleting original/reimported RDS: $ORIGINAL_DB ..."
  # Disable deletion protection first (just in case)
  aws rds modify-db-instance \
    --db-instance-identifier "$ORIGINAL_DB" \
    --no-deletion-protection \
    --apply-immediately \
    --region "$REGION" \
    --profile "$PROFILE" 2>/dev/null || true
  sleep 5
  aws rds delete-db-instance \
    --db-instance-identifier "$ORIGINAL_DB" \
    --skip-final-snapshot \
    --region "$REGION" \
    --profile "$PROFILE" 2>/dev/null && \
    echo "  Waiting for deletion..." && \
    aws rds wait db-instance-deleted \
      --db-instance-identifier "$ORIGINAL_DB" \
      --region "$REGION" \
      --profile "$PROFILE" 2>/dev/null || echo "  (not found or already deleted)"
else
  echo "Step 2: No original DB found in stack outputs (skipped)"
fi

# Step 3: Destroy the CDK stack
echo ""
echo "Step 3: Destroying CDK stack: $STACK_NAME ..."
cd "$(dirname "$0")/.."
npx cdk destroy --force 2>/dev/null || true

# Step 4: If CDK destroy fails, force-delete via CloudFormation
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "Stacks[0].StackStatus" \
  --output text 2>/dev/null || echo "GONE")

if [ "$STACK_STATUS" != "GONE" ] && [ "$STACK_STATUS" != "DELETE_COMPLETE" ]; then
  echo "Stack still in state: $STACK_STATUS — force deleting..."
  # Get all logical resource IDs to retain (since we already cleaned up the physical resources)
  RETAIN_IDS=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query "StackResources[].LogicalResourceId" \
    --output text 2>/dev/null || echo "")

  if [ -n "$RETAIN_IDS" ]; then
    aws cloudformation delete-stack \
      --stack-name "$STACK_NAME" \
      --region "$REGION" \
      --profile "$PROFILE" \
      --retain-resources $RETAIN_IDS 2>/dev/null || true
  fi

  echo "Waiting for stack deletion..."
  aws cloudformation wait stack-delete-complete \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --profile "$PROFILE" 2>/dev/null || echo "  (timed out or already gone)"
fi

# Step 5: Clean up local backup files
echo ""
echo "Step 4: Cleaning up local files..."
rm -f "$(dirname "$0")/../../../.cfn-drift-remediate-backup-"*.json
rm -f "$(dirname "$0")/../../../../.cfn-drift-remediate-backup-"*.json

echo ""
echo "=== Cleanup Complete ==="
