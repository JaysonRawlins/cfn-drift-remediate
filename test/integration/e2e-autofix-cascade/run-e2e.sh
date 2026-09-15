#!/usr/bin/env bash
#
# E2E test for issue #62: a re-import target that references a DELETED resource
# must be re-imported, not orphaned.
#
# The fixture drifts one stack two ways at once:
#   SourceTopic    deleted out of band  -> DELETED  -> default decision "remove"
#   DependentQueue retagged out of band -> MODIFIED -> default decision "autofix"
# DependentQueue references SourceTopic via !Ref, so it is both a re-import
# target and a cascade dependent of the resource being permanently removed.
#
# Before the fix, Step 10 rebuilt the template from the original and ran the
# removal cascade over it, which swept DependentQueue back out of the stack
# after Step 9 had imported it: gone from the stack, still live in AWS, and
# reported as remediated.
#
# Usage: AWS_PROFILE=jjrawlins-Dev-AdministratorAccess AWS_REGION=us-east-2 bash run-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI="node $PROJECT_ROOT/lib/index.js"
STACK="cfn-e2e-autofix-cascade-$(date +%s)"

PASS=0
FAIL=0
TESTS_RUN=0

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

  # The queue survives the stack with DeletionPolicy:Retain, so delete it directly.
  if [[ -n "${QUEUE_URL:-}" ]]; then
    log "Deleting queue $QUEUE_URL..."
    aws sqs delete-queue --queue-url "$QUEUE_URL" 2>/dev/null || true
  fi

  log "Deleting stack $STACK..."
  aws cloudformation delete-stack --stack-name "$STACK" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" 2>/dev/null || true

  rm -f "${PROJECT_ROOT}"/.cfn-drift-remediate-backup-${STACK}-*.json 2>/dev/null || true
  rm -f .cfn-drift-remediate-backup-${STACK}-*.json 2>/dev/null || true

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
  fi
}

assert_equals() {
  local expected="$1" actual="$2" desc="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$desc"
  else
    fail "$desc — expected '$expected', got '$actual'"
  fi
}

# ======================================================================
section "SETUP: Compile project"
# ======================================================================
(cd "$PROJECT_ROOT" && npx projen compile 2>&1) || { fail "Project compilation failed"; exit 1; }
pass "Project compiled"

# ======================================================================
section "SETUP: Deploy fixture stack"
# ======================================================================
log "Deploying $STACK..."
aws cloudformation create-stack \
  --stack-name "$STACK" \
  --template-body "file://$SCRIPT_DIR/stack-autofix-cascade.yaml" \
  --on-failure DELETE \
  2>&1
aws cloudformation wait stack-create-complete --stack-name "$STACK"
pass "Stack $STACK deployed"

TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`TopicArn`].OutputValue' --output text)
QUEUE_URL=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`QueueUrl`].OutputValue' --output text)
log "topic=$TOPIC_ARN queue=$QUEUE_URL"

# ======================================================================
section "SETUP: Inject both drifts"
# ======================================================================
log "Deleting the topic out of band (DELETED drift)..."
aws sns delete-topic --topic-arn "$TOPIC_ARN"

log "Retagging the queue out of band (MODIFIED drift)..."
aws sqs tag-queue --queue-url "$QUEUE_URL" --tags Environment=DRIFTED

log "Waiting 15s for the deletion to propagate..."
sleep 15

# ======================================================================
section "TEST 1: Remediation re-imports the dependent re-import target"
# ======================================================================
set +e
OUTPUT=$(cd "$PROJECT_ROOT" && $CLI "$STACK" --yes --verbose 2>&1)
EC=$?
set -e

echo "$OUTPUT"

assert_exit_code 0 $EC "1a: Remediation exits 0"
assert_contains "$OUTPUT" "completed successfully" "1b: Reports success"
assert_contains "$OUTPUT" "DependentQueue" "1c: DependentQueue named in the summary"

# The heart of issue #62: the queue must still be a stack resource.
QUEUE_STATUS=$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK" \
  --logical-resource-id DependentQueue \
  --query 'StackResourceDetail.ResourceStatus' --output text 2>/dev/null || echo "MISSING")
if [[ "$QUEUE_STATUS" == *"COMPLETE"* ]]; then
  pass "1d: DependentQueue is still managed by the stack ($QUEUE_STATUS)"
else
  fail "1d: DependentQueue was orphaned — stack resource status is '$QUEUE_STATUS'"
fi

# It must also still exist in AWS (never deleted, only ever retained).
if aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn >/dev/null 2>&1; then
  pass "1e: DependentQueue still exists in AWS"
else
  fail "1e: DependentQueue no longer exists in AWS"
fi

# The deleted topic is the one that should be gone from the stack.
TOPIC_STATUS=$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK" \
  --logical-resource-id SourceTopic \
  --query 'StackResourceDetail.ResourceStatus' --output text 2>/dev/null || echo "MISSING")
assert_equals "MISSING" "$TOPIC_STATUS" "1f: SourceTopic removed from the stack"

# ======================================================================
section "TEST 2: Final template dropped the stale reference"
# ======================================================================
DEPLOYED=$(aws cloudformation get-template --stack-name "$STACK" \
  --template-stage Processed --query 'TemplateBody' --output json)

# Assert on intrinsic functions, not on the string "SourceTopic" — CloudFormation
# names physical resources after their logical ID, so the resolved literal ARN
# legitimately contains it (...-SourceTopic-UdB3qQil5nUu).
STALE_REFS=$(echo "$DEPLOYED" | jq '[.. | objects | select(has("Ref")) | .Ref]
  | map(select(. == "SourceTopic")) | length')
assert_equals "0" "$STALE_REFS" "2a: No Ref to SourceTopic remains"

STALE_GETATTS=$(echo "$DEPLOYED" | jq '[.. | objects | select(has("Fn::GetAtt")) | ."Fn::GetAtt"]
  | map(if type == "array" then .[0] else split(".")[0] end)
  | map(select(. == "SourceTopic")) | length')
assert_equals "0" "$STALE_GETATTS" "2b: No GetAtt on SourceTopic remains"

DECLARED=$(echo "$DEPLOYED" | jq '.Resources | has("SourceTopic")')
assert_equals "false" "$DECLARED" "2c: SourceTopic no longer declared in the template"

QUEUE_DECLARED=$(echo "$DEPLOYED" | jq '.Resources | has("DependentQueue")')
assert_equals "true" "$QUEUE_DECLARED" "2d: DependentQueue still declared in the template"

# The detach replaced the intrinsic with the concrete ARN the tag always
# resolved to at runtime, which is what keeps the queue out of the cascade.
TAG_VALUE=$(echo "$DEPLOYED" | jq -r '.Resources.DependentQueue.Properties.Tags[]
  | select(.Key == "SourceTopicArn") | .Value')
if [[ "$TAG_VALUE" == arn:aws:sns:* ]]; then
  pass "2e: SourceTopicArn tag holds a resolved literal ARN ($TAG_VALUE)"
else
  fail "2e: SourceTopicArn tag is not a resolved literal: '$TAG_VALUE'"
fi

STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].StackStatus' --output text)
if [[ "$STACK_STATUS" == *"COMPLETE"* && "$STACK_STATUS" != *"ROLLBACK"* ]]; then
  pass "2f: Stack is healthy ($STACK_STATUS)"
else
  fail "2f: Stack is in unexpected state: $STACK_STATUS"
fi

# ======================================================================
section "TEST 3: Stack is back in sync"
# ======================================================================
DETECT_ID=$(aws cloudformation detect-stack-drift --stack-name "$STACK" \
  --query 'StackDriftDetectionId' --output text)
DRIFT_STATUS="UNKNOWN"
for _ in 1 2 3 4 5 6; do
  sleep 5
  STATUS=$(aws cloudformation describe-stack-drift-detection-status \
    --stack-drift-detection-id "$DETECT_ID" --query 'DetectionStatus' --output text)
  if [[ "$STATUS" == "DETECTION_COMPLETE" ]]; then
    DRIFT_STATUS=$(aws cloudformation describe-stack-drift-detection-status \
      --stack-drift-detection-id "$DETECT_ID" --query 'StackDriftStatus' --output text)
    break
  fi
done
assert_equals "IN_SYNC" "$DRIFT_STATUS" "3a: Stack is IN_SYNC after remediation"

# ======================================================================
section "RESULTS"
# ======================================================================
echo ""
echo -e "${BOLD}Tests run: $TESTS_RUN | ${GREEN}Passed: $PASS${NC} | ${RED}Failed: $FAIL${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
