#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="CfnDriftTestStack"
REGION="${AWS_REGION:-us-east-2}"
PROFILE="${AWS_PROFILE:-jjrawlins-Dev-AdministratorAccess}"

echo "=== Running Drift Remediation ==="
echo "Stack: $STACK_NAME"
echo "Region: $REGION"
echo "Profile: $PROFILE"
echo ""

# Path to the built CLI tool (relative to the cdk-test-app directory)
CLI_PATH="$(cd "$(dirname "$0")/../../.." && pwd)/lib/index.js"

if [ ! -f "$CLI_PATH" ]; then
  echo "ERROR: CLI not found at $CLI_PATH"
  echo "Run 'npx projen compile' from the project root first."
  exit 1
fi

echo "Using CLI: $CLI_PATH"
echo ""

# Run the remediation tool interactively
node "$CLI_PATH" "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --verbose
