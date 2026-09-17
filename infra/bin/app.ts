#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AppStage } from '../lib/stages/app-stage';

const app = new App();

const region = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

const DEV_ACCOUNT = '733360597085';
const PROD_ACCOUNT = '147956725112';

new AppStage(app, 'FamilyHealthDev', {
  environmentName: 'dev',
  env: { account: DEV_ACCOUNT, region },
});

new AppStage(app, 'FamilyHealthProd', {
  environmentName: 'prod',
  env: { account: PROD_ACCOUNT, region },
});
