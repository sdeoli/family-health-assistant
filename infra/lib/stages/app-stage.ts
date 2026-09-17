import { Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { applyBaseTags } from '../constructs/tagging';

export type EnvironmentName = 'dev' | 'prod';

export interface AppStageProps extends StageProps {
  readonly environmentName: EnvironmentName;
}

export class AppStage extends Stage {
  public readonly environmentName: EnvironmentName;

  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);

    this.environmentName = props.environmentName;
    applyBaseTags(this, props.environmentName);

    // Stacks are added here as each phase is built, e.g.:
    // new AuthStack(this, 'Auth', { environmentName: this.environmentName });
    // new DataStack(this, 'Data', { environmentName: this.environmentName });
  }
}
