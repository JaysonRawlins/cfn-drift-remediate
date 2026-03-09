#!/usr/bin/env bash
#
# E2E tests for auto-bootstrapped restrictive IAM safety role.
#
# Verifies that the tool auto-creates the cfn-drift-remediate-role stack
# on first use, and that the restrictive role prevents resource deletion
# during DELETED+cascade drift remediation.
#
# Usage: AWS_PROFILE=jjrawlins-Dev-AdministratorAccess AWS_REGION=us-east-2 bash run-e2e.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI="node $PROJECT_ROOT/lib/index.js"
TEST_STACK="cfn-e2e-bootstrap-$(date +%s)"
CASCADE_TEMPLATE="$SCRIPT_DIR/../e2e-error-handling/stack-cascade.yaml"
BOOTSTRAP_STACK="cfn-drift-remediate-role-${AWS_REGION}"

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

  log "Deleting test stack $TEST_STACK..."
  aws cloudformation delete-stack --stack-name "$TEST_STACK" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "$TEST_STACK" 2>/dev/null || true

  log "Deleting bootstrap stack $BOOTSTRAP_STACK..."
  aws cloudformation delete-stack --stack-name "$BOOTSTRAP_STACK" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "$BOOTSTRAP_STACK" 2>/dev/null || true

  # Clean up checkpoint files
  rm -f .cfn-drift-remediate-backup-${TEST_STACK}-*.json 2>/dev/null || true

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

# ============================================================
section "SETUP: Ensure bootstrap stack does NOT exist"
# ============================================================

log "Pre-cleaning bootstrap stack (if leftover from previous run)..."
aws cloudformation delete-stack --stack-name "$BOOTSTRAP_STACK" 2>/dev/null || true
aws cloudformation wait stack-delete-complete --stack-name "$BOOTSTRAP_STACK" 2>/dev/null || true
log "Bootstrap stack pre-cleaned."

# ============================================================
section "SETUP: Deploy cascade test stack"
# ============================================================

log "Deploying cascade test stack: $TEST_STACK"
aws cloudformation deploy \
  --stack-name "$TEST_STACK" \
  --template-file "$CASCADE_TEMPLATE" \
  --no-fail-on-empty-changeset

# Get the Topic ARN so we can delete it
TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$TEST_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`TopicArn`].OutputValue' \
  --output text)

log "Deleting SNS topic to create DELETED drift: $TOPIC_ARN"
aws sns delete-topic --topic-arn "$TOPIC_ARN"
sleep 5

# ============================================================
section "TEST 1: Auto-bootstrap creates safety role"
# ============================================================

log "Verifying bootstrap stack does not exist..."
BOOTSTRAP_EXISTS=$(aws cloudformation describe-stacks \
  --stack-name "$BOOTSTRAP_STACK" 2>&1 || echo "does not exist")

if echo "$BOOTSTRAP_EXISTS" | grep -q "does not exist"; then
  pass "1: Bootstrap stack does not exist before first run"
else
  fail "1: Bootstrap stack already exists (should have been cleaned)"
fi

log "Running remediation (should auto-bootstrap)..."
set +e
OUTPUT=$($CLI "$TEST_STACK" --yes --verbose 2>&1)
EXIT_CODE=$?
set -e

echo "$OUTPUT"
echo ""
log "Exit code: $EXIT_CODE"

# Verify bootstrap stack was created
BOOTSTRAP_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "$BOOTSTRAP_STACK" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || echo "NOT_FOUND")

if [[ "$BOOTSTRAP_STATUS" == "CREATE_COMPLETE" ]]; then
  pass "2: Bootstrap stack was auto-created (CREATE_COMPLETE)"
else
  fail "2: Bootstrap stack status: $BOOTSTRAP_STATUS (expected CREATE_COMPLETE)"
fi

# Verify the role ARN is in the outputs
ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$BOOTSTRAP_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`RoleArn`].OutputValue' \
  --output text 2>/dev/null || echo "NOT_FOUND")

if echo "$ROLE_ARN" | grep -q "cfn-drift-remediate-role-${AWS_REGION}"; then
  pass "3: Bootstrap stack has region-specific RoleArn output"
else
  fail "3: Bootstrap stack RoleArn output: $ROLE_ARN (expected to contain cfn-drift-remediate-role-${AWS_REGION})"
fi

# Verify remediation succeeded
assert_exit_code 0 "$EXIT_CODE" "4: Remediation exits successfully"
assert_contains "$OUTPUT" "completed successfully" "5: Reports success"
assert_not_contains "$OUTPUT" "Access Denied" "6: No Access Denied errors"
assert_contains "$OUTPUT" "Safety role created" "7: Reports safety role creation"

# Check final stack status
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "$TEST_STACK" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || echo "UNKNOWN")
log "Final stack status: $STACK_STATUS"

if [[ "$STACK_STATUS" =~ ^(UPDATE_COMPLETE|IMPORT_COMPLETE)$ ]]; then
  pass "8: Stack in stable state ($STACK_STATUS)"
else
  fail "8: Stack in unexpected state ($STACK_STATUS)"
fi

# ============================================================
section "TEST 2: Subsequent run reuses existing bootstrap stack"
# ============================================================

# Redeploy the test stack (topics were removed in Test 1)
log "Re-deploying cascade test stack for Test 2..."
aws cloudformation delete-stack --stack-name "$TEST_STACK" 2>/dev/null || true
aws cloudformation wait stack-delete-complete --stack-name "$TEST_STACK" 2>/dev/null || true
aws cloudformation deploy \
  --stack-name "$TEST_STACK" \
  --template-file "$CASCADE_TEMPLATE" \
  --no-fail-on-empty-changeset

# Get the new Topic ARN and delete it
TOPIC_ARN2=$(aws cloudformation describe-stacks \
  --stack-name "$TEST_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`TopicArn`].OutputValue' \
  --output text)

log "Deleting SNS topic: $TOPIC_ARN2"
aws sns delete-topic --topic-arn "$TOPIC_ARN2"
sleep 5

log "Running remediation again (should reuse existing role)..."
set +e
OUTPUT2=$($CLI "$TEST_STACK" --yes --verbose 2>&1)
EXIT_CODE2=$?
set -e

echo "$OUTPUT2"
echo ""
log "Exit code: $EXIT_CODE2"

assert_exit_code 0 "$EXIT_CODE2" "9: Second remediation exits successfully"
assert_contains "$OUTPUT2" "completed successfully" "10: Second run reports success"
assert_not_contains "$OUTPUT2" "Creating cfn-drift-remediate-role-${AWS_REGION}" "11: Does NOT re-create bootstrap stack"

# ============================================================
section "RESULTS"
# ============================================================

echo -e "\n${BOLD}Tests: $TESTS_RUN total, ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
