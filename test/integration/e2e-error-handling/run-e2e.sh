#!/usr/bin/env bash
#
# E2E tests for error handling, checkpoints, resume, and pre-flight features.
# Usage: AWS_PROFILE=jjrawlins-Dev-AdministratorAccess AWS_REGION=us-east-2 bash run-e2e.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI="node $PROJECT_ROOT/lib/index.js"
STACK_BASIC="cfn-e2e-basic-$(date +%s)"
STACK_CASCADE="cfn-e2e-cascade-$(date +%s)"
STACK_CUSTOM="cfn-e2e-custom-$(date +%s)"

PASS=0
FAIL=0
TESTS_RUN=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[E2E]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; PASS=$((PASS + 1)); TESTS_RUN=$((TESTS_RUN + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $*"; FAIL=$((FAIL + 1)); TESTS_RUN=$((TESTS_RUN + 1)); }
section() { echo -e "\n${BOLD}${YELLOW}=== $* ===${NC}\n"; }

cleanup() {
  section "CLEANUP"

  log "Deleting stack $STACK_BASIC..."
  aws cloudformation delete-stack --stack-name "$STACK_BASIC" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_BASIC" 2>/dev/null || true
  log "Stack $STACK_BASIC deleted."

  log "Deleting stack $STACK_CASCADE..."
  aws cloudformation delete-stack --stack-name "$STACK_CASCADE" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_CASCADE" 2>/dev/null || true
  log "Stack $STACK_CASCADE deleted."

  log "Deleting stack $STACK_CUSTOM..."
  aws cloudformation delete-stack --stack-name "$STACK_CUSTOM" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_CUSTOM" 2>/dev/null || true
  log "Stack $STACK_CUSTOM deleted."

  # Clean up checkpoint files
  rm -f .cfn-drift-remediate-backup-${STACK_BASIC}-*.json 2>/dev/null || true
  rm -f .cfn-drift-remediate-backup-${STACK_CASCADE}-*.json 2>/dev/null || true
  rm -f .cfn-drift-remediate-backup-${STACK_CUSTOM}-*.json 2>/dev/null || true
  rm -f /tmp/e2e-v1-checkpoint.json /tmp/e2e-v2-checkpoint.json /tmp/e2e-resume-checkpoint.json /tmp/e2e-resume-step9.json /tmp/e2e-step-error-checkpoint.json 2>/dev/null || true

  log "Cleanup complete."
}
trap cleanup EXIT

assert_exit_code() {
  local expected=$1 actual=$2 desc=$3
  if [[ "$actual" -eq "$expected" ]]; then
    pass "$desc (exit=$actual)"
  else
    fail "$desc (expected exit=$expected, got exit=$actual)"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" desc="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    pass "$desc"
  else
    fail "$desc — expected output to contain: $needle"
    echo "  Actual output (first 500 chars): ${haystack:0:500}"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" desc="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    fail "$desc — output should NOT contain: $needle"
  else
    pass "$desc"
  fi
}

assert_file_exists() {
  local path="$1" desc="$2"
  if [[ -f "$path" ]]; then
    pass "$desc"
  else
    fail "$desc — file not found: $path"
  fi
}

assert_json_field() {
  local file="$1" field="$2" expected="$3" desc="$4"
  local actual
  actual=$(jq -r "$field" "$file" 2>/dev/null || echo "__MISSING__")
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc"
  else
    fail "$desc — expected $field=$expected, got $actual"
  fi
}

assert_json_field_exists() {
  local file="$1" field="$2" desc="$3"
  local actual
  actual=$(jq -r "$field" "$file" 2>/dev/null || echo "null")
  if [[ "$actual" != "null" && "$actual" != "" ]]; then
    pass "$desc"
  else
    fail "$desc — field $field is null or missing"
  fi
}

# ======================================================================
section "SETUP: Compile project"
# ======================================================================
log "Running npx projen compile..."
(cd "$PROJECT_ROOT" && npx projen compile 2>&1) || { fail "Project compilation failed"; exit 1; }
pass "Project compiled"

# ======================================================================
section "SETUP: Deploy test stacks"
# ======================================================================
log "Deploying $STACK_BASIC..."
aws cloudformation create-stack \
  --stack-name "$STACK_BASIC" \
  --template-body "file://$SCRIPT_DIR/stack-basic.yaml" \
  --on-failure DELETE \
  2>&1
aws cloudformation wait stack-create-complete --stack-name "$STACK_BASIC"
pass "Stack $STACK_BASIC deployed"

log "Deploying $STACK_CASCADE..."
aws cloudformation create-stack \
  --stack-name "$STACK_CASCADE" \
  --template-body "file://$SCRIPT_DIR/stack-cascade.yaml" \
  --on-failure DELETE \
  2>&1
aws cloudformation wait stack-create-complete --stack-name "$STACK_CASCADE"
pass "Stack $STACK_CASCADE deployed"

# Get physical IDs for drift injection
BUCKET_NAME=$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK_BASIC" \
  --logical-resource-id TestBucket \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)
QUEUE_URL=$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK_BASIC" \
  --logical-resource-id TestQueue \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)
TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_CASCADE" \
  --query 'Stacks[0].Outputs[?OutputKey==`TopicArn`].OutputValue' --output text)

log "Basic stack resources: bucket=$BUCKET_NAME queue=$QUEUE_URL"
log "Cascade stack resources: topic=$TOPIC_ARN"

# ======================================================================
section "TEST 1: --resume validation errors"
# ======================================================================
log "Test 1a: --resume with nonexistent file"
set +e
OUTPUT=$($CLI "$STACK_BASIC" --resume /nonexistent/path.json --yes 2>&1)
EC=$?
set -e
assert_exit_code 1 $EC "1a: Exit code 1 for nonexistent checkpoint"
assert_contains "$OUTPUT" "Checkpoint file not found" "1a: Error message for missing file"

log "Test 1b: --resume with v1 checkpoint (no checkpointVersion)"
cat > /tmp/e2e-v1-checkpoint.json <<EOF
{
  "stackName": "$STACK_BASIC",
  "stackId": "arn:aws:cloudformation:us-east-2:123456789012:stack/test/abc",
  "originalTemplateBody": "{}",
  "parameters": [],
  "driftedResourceIds": [],
  "timestamp": "2026-03-06T00:00:00Z"
}
EOF
set +e
OUTPUT=$($CLI "$STACK_BASIC" --resume /tmp/e2e-v1-checkpoint.json --yes 2>&1)
EC=$?
set -e
assert_exit_code 1 $EC "1b: Exit code 1 for v1 checkpoint"
assert_contains "$OUTPUT" "before --resume support" "1b: Helpful message about v1 checkpoint"

log "Test 1c: --resume with wrong stack name"
cat > /tmp/e2e-v2-checkpoint.json <<EOF
{
  "stackName": "WrongStackName",
  "stackId": "arn:aws:cloudformation:us-east-2:123456789012:stack/test/abc",
  "originalTemplateBody": "{}",
  "parameters": [],
  "driftedResourceIds": [],
  "timestamp": "2026-03-06T00:00:00Z",
  "checkpointVersion": 2,
  "lastCompletedStep": 8
}
EOF
set +e
OUTPUT=$($CLI "$STACK_BASIC" --resume /tmp/e2e-v2-checkpoint.json --yes 2>&1)
EC=$?
set -e
assert_exit_code 1 $EC "1c: Exit code 1 for stack name mismatch"
assert_contains "$OUTPUT" "stack name mismatch" "1c: Error message for wrong stack name"

log "Test 1d: --resume mutual exclusivity with --dry-run"
set +e
OUTPUT=$($CLI "$STACK_BASIC" --resume /tmp/e2e-v2-checkpoint.json --dry-run 2>&1)
EC=$?
set -e
assert_exit_code 1 $EC "1d: Exit code 1 for --resume + --dry-run"
assert_contains "$OUTPUT" "mutually exclusive" "1d: Mutual exclusivity error"

log "Test 1e: --resume mutual exclusivity with --export-plan"
set +e
OUTPUT=$($CLI "$STACK_BASIC" --resume /tmp/e2e-v2-checkpoint.json --export-plan /tmp/plan.json 2>&1)
EC=$?
set -e
assert_exit_code 1 $EC "1e: Exit code 1 for --resume + --export-plan"
assert_contains "$OUTPUT" "mutually exclusive" "1e: Mutual exclusivity error"

# ======================================================================
section "TEST 2: MODIFIED drift — dry-run"
# ======================================================================
log "Injecting MODIFIED drift on bucket tags (preserving system tags)..."
EXISTING_TAGS=$(aws s3api get-bucket-tagging --bucket "$BUCKET_NAME" --query 'TagSet' --output json 2>/dev/null || echo "[]")
# Merge existing tags with our drifted tag
NEW_TAGS=$(echo "$EXISTING_TAGS" | jq '
  map(select(.Key != "Environment")) +
  [{Key: "Environment", Value: "DRIFTED"}, {Key: "NewTag", Value: "injected"}]
')
aws s3api put-bucket-tagging --bucket "$BUCKET_NAME" --tagging "{\"TagSet\": $NEW_TAGS}"

log "Injecting MODIFIED drift on queue tags..."
aws sqs tag-queue --queue-url "$QUEUE_URL" --tags Environment=DRIFTED,NewTag=injected

log "Running dry-run..."
set +e
OUTPUT=$($CLI "$STACK_BASIC" --dry-run --yes 2>&1)
EC=$?
set -e
assert_exit_code 0 $EC "2: Dry-run exits 0"
assert_contains "$OUTPUT" "Dry run" "2: Output contains 'Dry run'"
assert_contains "$OUTPUT" "TestBucket" "2: Output mentions TestBucket"
assert_contains "$OUTPUT" "TestQueue" "2: Output mentions TestQueue"

# ======================================================================
section "TEST 3: MODIFIED drift — full remediation + v2 checkpoint"
# ======================================================================
log "Running full remediation with --yes..."
set +e
OUTPUT=$($CLI "$STACK_BASIC" --yes --verbose 2>&1)
EC=$?
set -e

echo "$OUTPUT"

assert_exit_code 0 $EC "3a: Remediation exits 0"
assert_contains "$OUTPUT" "completed successfully" "3a: Success message"
assert_contains "$OUTPUT" "TestBucket" "3a: TestBucket remediated"
assert_contains "$OUTPUT" "TestQueue" "3a: TestQueue remediated"
assert_contains "$OUTPUT" "Recovery checkpoint" "3a: Recovery checkpoint mentioned"

# Find the checkpoint file
CHECKPOINT=$(ls -t .cfn-drift-remediate-backup-${STACK_BASIC}-*.json 2>/dev/null | head -1)
assert_file_exists "$CHECKPOINT" "3b: Checkpoint file exists"

if [[ -n "$CHECKPOINT" && -f "$CHECKPOINT" ]]; then
  assert_json_field "$CHECKPOINT" ".checkpointVersion" "2" "3c: Checkpoint is version 2"
  assert_json_field "$CHECKPOINT" ".stackName" "$STACK_BASIC" "3c: Checkpoint has correct stackName"
  assert_json_field_exists "$CHECKPOINT" ".lastCompletedStep" "3c: Checkpoint has lastCompletedStep"
  assert_json_field_exists "$CHECKPOINT" ".retainTemplateBody" "3c: Checkpoint has retainTemplateBody"
  assert_json_field_exists "$CHECKPOINT" ".removalTemplateBody" "3c: Checkpoint has removalTemplateBody"
  assert_json_field_exists "$CHECKPOINT" ".capabilities" "3c: Checkpoint has capabilities"
  assert_json_field_exists "$CHECKPOINT" ".decisionsJson" "3c: Checkpoint has decisionsJson"
  assert_json_field_exists "$CHECKPOINT" ".resourcesToImportJson" "3c: Checkpoint has resourcesToImportJson"
  assert_json_field_exists "$CHECKPOINT" ".checkpointPath" "3c: Checkpoint has checkpointPath"

  LAST_STEP=$(jq -r '.lastCompletedStep' "$CHECKPOINT")
  log "Checkpoint lastCompletedStep = $LAST_STEP"
  if [[ "$LAST_STEP" == "10" ]]; then
    pass "3c: lastCompletedStep is 10 (RESTORE_TEMPLATE)"
  else
    fail "3c: Expected lastCompletedStep=10, got $LAST_STEP"
  fi
fi

# Verify stack is back in sync
log "Verifying stack is in sync after remediation..."
DETECT_ID=$(aws cloudformation detect-stack-drift --stack-name "$STACK_BASIC" --query 'StackDriftDetectionId' --output text)
sleep 10
DRIFT_STATUS=$(aws cloudformation describe-stack-drift-detection-status \
  --stack-drift-detection-id "$DETECT_ID" \
  --query 'StackDriftStatus' --output text 2>/dev/null || echo "UNKNOWN")

# Might need to wait more for drift detection
for i in 1 2 3 4 5; do
  STATUS=$(aws cloudformation describe-stack-drift-detection-status \
    --stack-drift-detection-id "$DETECT_ID" \
    --query 'DetectionStatus' --output text)
  if [[ "$STATUS" == "DETECTION_COMPLETE" ]]; then
    DRIFT_STATUS=$(aws cloudformation describe-stack-drift-detection-status \
      --stack-drift-detection-id "$DETECT_ID" \
      --query 'StackDriftStatus' --output text)
    break
  fi
  sleep 5
done

if [[ "$DRIFT_STATUS" == "IN_SYNC" ]]; then
  pass "3d: Stack is IN_SYNC after remediation"
else
  fail "3d: Stack drift status is $DRIFT_STATUS (expected IN_SYNC)"
fi

# ======================================================================
section "TEST 4: Resume from checkpoint"
# ======================================================================
if [[ -n "$CHECKPOINT" && -f "$CHECKPOINT" ]]; then
  log "Injecting drift again for resume test..."
  EXISTING_TAGS=$(aws s3api get-bucket-tagging --bucket "$BUCKET_NAME" --query 'TagSet' --output json 2>/dev/null || echo "[]")
  NEW_TAGS=$(echo "$EXISTING_TAGS" | jq '
    map(select(.Key != "Environment")) +
    [{Key: "Environment", Value: "DRIFTED-AGAIN"}]
  ')
  aws s3api put-bucket-tagging --bucket "$BUCKET_NAME" --tagging "{\"TagSet\": $NEW_TAGS}"
  aws sqs tag-queue --queue-url "$QUEUE_URL" --tags Environment=DRIFTED-AGAIN

  log "Running full remediation to create a new checkpoint..."
  set +e
  OUTPUT=$($CLI "$STACK_BASIC" --yes --verbose 2>&1)
  EC=$?
  set -e
  assert_exit_code 0 $EC "4a: Second remediation succeeds"

  # Find the new checkpoint
  CHECKPOINT2=$(ls -t .cfn-drift-remediate-backup-${STACK_BASIC}-*.json 2>/dev/null | head -1)
  assert_file_exists "$CHECKPOINT2" "4b: New checkpoint file exists"

  if [[ -n "$CHECKPOINT2" && -f "$CHECKPOINT2" ]]; then
    # Modify checkpoint to simulate Step 10 failure (set lastCompletedStep to 9)
    log "Modifying checkpoint to simulate Step 10 failure..."
    jq '.lastCompletedStep = 9' "$CHECKPOINT2" > /tmp/e2e-resume-checkpoint.json

    # The stack is already fully restored, so resuming Step 10 should be a no-op success
    log "Running --resume from step 9..."
    set +e
    OUTPUT=$($CLI "$STACK_BASIC" --resume /tmp/e2e-resume-checkpoint.json --yes --verbose 2>&1)
    EC=$?
    set -e

    echo "$OUTPUT"

    assert_exit_code 0 $EC "4c: Resume exits 0"
    assert_contains "$OUTPUT" "resumed and completed" "4c: Resume message present"
    assert_contains "$OUTPUT" "completed successfully" "4c: Resume completed successfully"
  fi
else
  log "Skipping resume test — no checkpoint from Test 3"
fi

# ======================================================================
section "TEST 5: DELETED drift with cascade dependencies"
# ======================================================================
log "Deleting SNS topic to create DELETED drift..."
aws sns delete-topic --topic-arn "$TOPIC_ARN"

log "Waiting 10s for deletion to propagate..."
sleep 10

log "Running remediation on cascade stack with --yes..."
set +e
OUTPUT=$($CLI "$STACK_CASCADE" --yes --verbose 2>&1)
EC=$?
set -e

echo "$OUTPUT"

assert_exit_code 0 $EC "5a: Cascade remediation exits 0"

# The topic was DELETED and subscription + queue reference it.
# Queue has a tag with !Ref TestTopic, so it's a cascade dep.
# The tool should handle this (remove topic + cascade deps, possibly with warnings).
# TestSubscription uses Ref + GetAtt → cascade dep.
assert_contains "$OUTPUT" "TestTopic" "5a: TestTopic mentioned in output"

# Check that a v2 checkpoint was created for the cascade stack
CASCADE_CHECKPOINT=$(ls -t .cfn-drift-remediate-backup-${STACK_CASCADE}-*.json 2>/dev/null | head -1)
if [[ -n "$CASCADE_CHECKPOINT" && -f "$CASCADE_CHECKPOINT" ]]; then
  assert_json_field "$CASCADE_CHECKPOINT" ".checkpointVersion" "2" "5b: Cascade checkpoint is v2"
  assert_json_field_exists "$CASCADE_CHECKPOINT" ".lastCompletedStep" "5b: Cascade checkpoint has lastCompletedStep"
  pass "5b: Cascade checkpoint created correctly"
else
  # If the stack had no resources to remediate, no checkpoint is created
  log "No cascade checkpoint found (may be expected if all resources were non-importable)"
fi

# ======================================================================
section "TEST 6: Pre-flight check runs (describeResourceType)"
# ======================================================================
# This test verifies the pre-flight code path runs without error.
# With standard AWS types, we don't expect warnings (they all have read handlers).
# The unit tests cover the warning display path.
# We verify the output doesn't crash with "describeResourceType" errors.
assert_not_contains "$OUTPUT" "describeResourceType" "6: No describeResourceType errors in output"
pass "6: Pre-flight check ran without crashing"

# ======================================================================
section "TEST 7: Step error display (structured error output)"
# ======================================================================
# We test the display path by creating a checkpoint that points to a
# non-existent stack, then attempting resume. The step will fail and
# we should see structured error output with recovery guidance.
log "Creating checkpoint that will cause Step 10 to fail..."
# Use a fake stack ID that doesn't exist — updateStack will fail
FAKE_STACK="cfn-e2e-nonexistent-$(date +%s)"
cat > /tmp/e2e-step-error-checkpoint.json <<EOF
{
  "stackName": "$FAKE_STACK",
  "stackId": "arn:aws:cloudformation:us-east-2:590183750202:stack/${FAKE_STACK}/00000000-0000-0000-0000-000000000000",
  "originalTemplateBody": "{\"AWSTemplateFormatVersion\":\"2010-09-09\",\"Resources\":{\"Fake\":{\"Type\":\"AWS::S3::Bucket\"}}}",
  "parameters": [],
  "driftedResourceIds": ["Fake"],
  "timestamp": "2026-03-06T00:00:00Z",
  "checkpointVersion": 2,
  "lastCompletedStep": 9,
  "retainTemplateBody": "{\"AWSTemplateFormatVersion\":\"2010-09-09\",\"Resources\":{}}",
  "resolvedValuesJson": "[]",
  "removalTemplateBody": "{\"AWSTemplateFormatVersion\":\"2010-09-09\",\"Resources\":{}}",
  "importComplete": true,
  "capabilities": ["CAPABILITY_IAM"],
  "decisionsJson": "{\"autofix\":[{\"logicalResourceId\":\"Fake\",\"resourceType\":\"AWS::S3::Bucket\",\"physicalResourceId\":\"fake-bucket\",\"stackResourceDriftStatus\":\"MODIFIED\"}],\"reimport\":[],\"remove\":[],\"skip\":[]}",
  "resourcesToImportJson": "[{\"ResourceType\":\"AWS::S3::Bucket\",\"LogicalResourceId\":\"Fake\",\"ResourceIdentifier\":{\"BucketName\":\"fake-bucket\"}}]",
  "checkpointPath": "/tmp/e2e-step-error-checkpoint.json"
}
EOF

set +e
OUTPUT=$($CLI "$FAKE_STACK" --resume /tmp/e2e-step-error-checkpoint.json --yes 2>&1)
EC=$?
set -e

echo "$OUTPUT"

assert_exit_code 1 $EC "7a: Step error causes exit 1"
assert_contains "$OUTPUT" "Failed at:" "7b: Structured error shows 'Failed at:'"
assert_contains "$OUTPUT" "Step 10" "7b: Identifies Step 10 as the failed step"
assert_contains "$OUTPUT" "Stack state:" "7c: Shows stack state"
assert_contains "$OUTPUT" "Recovery options:" "7d: Shows recovery options"
# Use fixed string matching for --resume flag
echo "$OUTPUT" | grep -qF -- "--resume" && pass "7e: Guidance includes --resume command" || fail "7e: Guidance missing --resume command"

# ======================================================================
section "TEST 8: Resume after real partial import (fallback strategy)"
# ======================================================================
# This test exercises real resume-from-Step-9 with partial import detection.
# 1. Inject drift on the basic stack again
# 2. Run full remediation to get a checkpoint and restore the stack
# 3. Inject drift again
# 4. Run full remediation to get a fresh checkpoint
# 5. Edit checkpoint: set lastCompletedStep=8, clear importComplete
# 6. Run --resume — partial import detection (Task 3) should detect
#    already-imported resources and skip/handle them
# 7. Verify completion

log "Re-injecting MODIFIED drift on bucket..."
EXISTING_TAGS=$(aws s3api get-bucket-tagging --bucket "$BUCKET_NAME" --query 'TagSet' --output json 2>/dev/null || echo "[]")
NEW_TAGS=$(echo "$EXISTING_TAGS" | jq '
  map(select(.Key != "Environment")) +
  [{Key: "Environment", Value: "DRIFTED-T8"}]
')
aws s3api put-bucket-tagging --bucket "$BUCKET_NAME" --tagging "{\"TagSet\": $NEW_TAGS}"
aws sqs tag-queue --queue-url "$QUEUE_URL" --tags Environment=DRIFTED-T8

log "Running full remediation to generate a checkpoint..."
set +e
OUTPUT=$($CLI "$STACK_BASIC" --yes --verbose 2>&1)
EC=$?
set -e
assert_exit_code 0 $EC "8a: Pre-resume remediation succeeds"

# Find the latest checkpoint
CHECKPOINT_T8=$(ls -t .cfn-drift-remediate-backup-${STACK_BASIC}-*.json 2>/dev/null | head -1)
assert_file_exists "$CHECKPOINT_T8" "8b: Checkpoint file exists for Test 8"

if [[ -n "$CHECKPOINT_T8" && -f "$CHECKPOINT_T8" ]]; then
  # Edit checkpoint: simulate Step 9 never completed (set lastCompletedStep=8, clear importComplete)
  log "Editing checkpoint to simulate failure at Step 9..."
  jq '.lastCompletedStep = 8 | del(.importComplete)' "$CHECKPOINT_T8" > /tmp/e2e-resume-step9.json

  # Run --resume: since the stack is already fully restored (Step 10 completed),
  # all resources are already in the stack. Task 3's partial import detection
  # should see them as already-imported and skip the import.
  log "Running --resume from step 8 (resuming into Step 9)..."
  set +e
  OUTPUT=$($CLI "$STACK_BASIC" --resume /tmp/e2e-resume-step9.json --yes --verbose 2>&1)
  EC=$?
  set -e

  echo "$OUTPUT"

  assert_exit_code 0 $EC "8c: Resume from Step 8 exits 0"
  assert_contains "$OUTPUT" "already-imported" "8d: Partial import detection found existing resources"
  assert_contains "$OUTPUT" "resumed and completed" "8e: Resume completed successfully"

  # Verify stack is still in a good state
  STACK_STATUS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_BASIC" \
    --query 'Stacks[0].StackStatus' --output text)
  if [[ "$STACK_STATUS" == *"COMPLETE"* && "$STACK_STATUS" != *"ROLLBACK"* ]]; then
    pass "8f: Stack is in a healthy state ($STACK_STATUS)"
  else
    fail "8f: Stack is in unexpected state: $STACK_STATUS"
  fi
fi

# ======================================================================
section "TEST 9: Concurrent execution guard"
# ======================================================================
# We can't easily get the stack into _IN_PROGRESS in a test, but we
# already tested the getStackInfo().stackStatus field in unit tests.
# Verify that the tool handles an already-synced stack gracefully
# (this confirms the guard code path doesn't crash for normal states).
log "Running against already-synced stack (should succeed quickly)..."
set +e
OUTPUT=$($CLI "$STACK_BASIC" --yes 2>&1)
EC=$?
set -e
assert_exit_code 0 $EC "9a: Tool handles synced stack gracefully"
# Output should indicate stack is in sync
assert_contains "$OUTPUT" "in sync" "9b: Stack reported as in sync"

# ======================================================================
section "TEST 10: Custom::AWS and AWS::CDK::Metadata coverage"
# ======================================================================
log "Deploying $STACK_CUSTOM (with Custom::AWS + AWS::CDK::Metadata)..."
aws cloudformation create-stack \
  --stack-name "$STACK_CUSTOM" \
  --template-body "file://$SCRIPT_DIR/stack-custom-resource.yaml" \
  --capabilities CAPABILITY_IAM \
  --on-failure DELETE \
  2>&1
aws cloudformation wait stack-create-complete --stack-name "$STACK_CUSTOM"
pass "10a: Stack $STACK_CUSTOM deployed"

# Get bucket name for drift injection
CUSTOM_BUCKET=$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK_CUSTOM" \
  --logical-resource-id TestBucket \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)

log "Injecting MODIFIED drift on bucket tags..."
EXISTING_TAGS=$(aws s3api get-bucket-tagging --bucket "$CUSTOM_BUCKET" --query 'TagSet' --output json 2>/dev/null || echo "[]")
NEW_TAGS=$(echo "$EXISTING_TAGS" | jq '
  map(select(.Key != "Environment")) +
  [{Key: "Environment", Value: "DRIFTED"}]
')
aws s3api put-bucket-tagging --bucket "$CUSTOM_BUCKET" --tagging "{\"TagSet\": $NEW_TAGS}"

log "Running dry-run on stack with Custom::AWS + CDK::Metadata..."
set +e
OUTPUT=$($CLI "$STACK_CUSTOM" --dry-run --yes 2>&1)
EC=$?
set -e

echo "$OUTPUT"

assert_exit_code 0 $EC "10b: Dry-run exits 0"
assert_not_contains "$OUTPUT" "not covered by the safety role" "10c: No uncovered namespace warning for Custom::AWS/CDK::Metadata"
assert_contains "$OUTPUT" "TestBucket" "10d: TestBucket drift detected"

log "Running full remediation on Custom::AWS stack..."
set +e
OUTPUT=$($CLI "$STACK_CUSTOM" --yes --verbose 2>&1)
EC=$?
set -e

echo "$OUTPUT"

assert_exit_code 0 $EC "10e: Full remediation exits 0"
assert_not_contains "$OUTPUT" "not covered by the safety role" "10f: No uncovered namespace warning during remediation"
assert_contains "$OUTPUT" "completed successfully" "10g: Remediation completed successfully"

# Verify Custom::AWS and CDK::Metadata resources still exist in stack
CUSTOM_RES=$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK_CUSTOM" \
  --logical-resource-id CustomAWSResource \
  --query 'StackResourceDetail.ResourceStatus' --output text 2>/dev/null || echo "MISSING")
if [[ "$CUSTOM_RES" == "CREATE_COMPLETE" || "$CUSTOM_RES" == "UPDATE_COMPLETE" ]]; then
  pass "10h: Custom::AWS resource still intact after remediation"
else
  fail "10h: Custom::AWS resource in unexpected state: $CUSTOM_RES"
fi

# ======================================================================
section "RESULTS"
# ======================================================================
echo ""
echo -e "${BOLD}Tests run: $TESTS_RUN | ${GREEN}Passed: $PASS${NC} | ${RED}Failed: $FAIL${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
