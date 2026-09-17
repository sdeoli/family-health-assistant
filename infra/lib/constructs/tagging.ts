import { Tags } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

export const PROJECT_NAME = 'family-health-assistant';

export function applyBaseTags(scope: IConstruct, environmentName: string): void {
  Tags.of(scope).add('Project', PROJECT_NAME);
  Tags.of(scope).add('Environment', environmentName);
}

export function applyComponentTag(scope: IConstruct, component: string): void {
  Tags.of(scope).add('Component', component);
}
