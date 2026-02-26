#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="CfnDriftTestStack"
REGION="${AWS_REGION:-us-east-2}"
PROFILE="${AWS_PROFILE:-jjrawlins-Dev-AdministratorAccess}"
NEW_DB_IDENTIFIER="drift-test-replacement-db"

echo "=== Breaking Stack: $STACK_NAME ==="
echo "Region: $REGION"
echo "Profile: $PROFILE"
echo ""

# Get stack outputs
echo "Fetching stack outputs..."
DB_IDENTIFIER=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='DbInstanceIdentifier'].OutputValue" \
  --output text)

EC2_INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='Ec2InstanceId'].OutputValue" \
  --output text)

echo "Original DB Identifier: $DB_IDENTIFIER"
echo "EC2 Instance ID: $EC2_INSTANCE_ID"
echo ""

# Get RDS instance details for replacement creation
echo "Getting RDS instance details..."
DB_INFO=$(aws rds describe-db-instances \
  --db-instance-identifier "$DB_IDENTIFIER" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "DBInstances[0]")

DB_SUBNET_GROUP=$(echo "$DB_INFO" | jq -r '.DBSubnetGroup.DBSubnetGroupName')
DB_SG_ID=$(echo "$DB_INFO" | jq -r '.VpcSecurityGroups[0].VpcSecurityGroupId')
DB_INSTANCE_CLASS=$(echo "$DB_INFO" | jq -r '.DBInstanceClass')

echo "DB Subnet Group: $DB_SUBNET_GROUP"
echo "DB Security Group: $DB_SG_ID"
echo "DB Instance Class: $DB_INSTANCE_CLASS"
echo ""

# Step 1: Delete original RDS instance (creates DELETED drift)
echo "Step 1: Deleting RDS instance: $DB_IDENTIFIER"
echo "  (This creates DELETED drift on AWS::RDS::DBInstance)"
aws rds delete-db-instance \
  --db-instance-identifier "$DB_IDENTIFIER" \
  --skip-final-snapshot \
  --region "$REGION" \
  --profile "$PROFILE" > /dev/null

echo "Waiting for DB deletion (5-10 minutes)..."
aws rds wait db-instance-deleted \
  --db-instance-identifier "$DB_IDENTIFIER" \
  --region "$REGION" \
  --profile "$PROFILE" 2>/dev/null || true
echo "DB deleted."

# Step 2: Create replacement RDS instance with DIFFERENT identifier
echo ""
echo "Step 2: Creating replacement RDS instance: $NEW_DB_IDENTIFIER"
aws rds create-db-instance \
  --db-instance-identifier "$NEW_DB_IDENTIFIER" \
  --db-instance-class "$DB_INSTANCE_CLASS" \
  --engine postgres \
  --engine-version "16" \
  --master-username "postgres" \
  --master-user-password "TestPass123!" \
  --allocated-storage 20 \
  --db-subnet-group-name "$DB_SUBNET_GROUP" \
  --vpc-security-group-ids "$DB_SG_ID" \
  --no-multi-az \
  --backup-retention-period 0 \
  --no-deletion-protection \
  --db-name "testdb" \
  --region "$REGION" \
  --profile "$PROFILE" > /dev/null

echo "Waiting for replacement DB to become available (5-10 minutes)..."
aws rds wait db-instance-available \
  --db-instance-identifier "$NEW_DB_IDENTIFIER" \
  --region "$REGION" \
  --profile "$PROFILE"
echo "Replacement DB ready."

# Step 3: Modify EC2 instance tags (creates MODIFIED drift)
echo ""
echo "Step 3: Modifying EC2 tags to create MODIFIED drift"
echo "  Changing 'Environment' tag from 'test' to 'DRIFTED'"
echo "  Adding new tag 'DriftedBy' = 'break-script'"
aws ec2 create-tags \
  --resources "$EC2_INSTANCE_ID" \
  --tags Key=Environment,Value=DRIFTED Key=DriftedBy,Value=break-script \
  --region "$REGION" \
  --profile "$PROFILE"

# Get replacement DB ARN
NEW_DB_ARN=$(aws rds describe-db-instances \
  --db-instance-identifier "$NEW_DB_IDENTIFIER" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "DBInstances[0].DBInstanceArn" \
  --output text)

echo ""
echo "=== Stack successfully broken! ==="
echo ""
echo "Drift summary:"
echo "  1. DELETED: RDS DB Instance (was: $DB_IDENTIFIER)"
echo "  2. MODIFIED: EC2 Instance tags ($EC2_INSTANCE_ID)"
echo ""
echo "Replacement DB:"
echo "  Identifier: $NEW_DB_IDENTIFIER"
echo "  ARN: $NEW_DB_ARN"
echo ""
echo "When running remediation:"
echo "  - For MODIFIED EC2: choose 'Autofix'"
echo "  - For DELETED RDS: choose 'Re-import', enter: $NEW_DB_IDENTIFIER"
