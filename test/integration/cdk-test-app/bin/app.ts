#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftTestStack } from '../lib/drift-test-stack';

const app = new cdk.App();
new DriftTestStack(app, 'CfnDriftTestStack', {
  tags: {
    Project: 'cfn-drift-test',
    Purpose: 'integration-testing',
  },
});
