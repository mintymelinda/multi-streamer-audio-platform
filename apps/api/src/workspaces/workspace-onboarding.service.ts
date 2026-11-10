import type { VerifiedWorkspaceId } from '@platform/contracts';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';

export const ONBOARDING_STEPS = [
  { key: 'providers', title: 'Connect your audio providers', description: 'Choose the services you want to use for track discovery and playback.' },
  { key: 'rewards', title: 'Configure Twitch channel rewards', description: 'Choose which channel-point rewards trigger request and playback features.' },
  { key: 'moderation', title: 'Choose your moderation rules', description: 'Set how requests are reviewed, filtered, and admitted to the queue.' },
  { key: 'overlay', title: 'Set up your OBS overlay', description: 'Plan the scene and now-playing information your viewers will see.' },
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];
export type OnboardingStepStatus = 'pending' | 'completed' | 'skipped';

function isStepKey(value: unknown): value is OnboardingStepKey {
  return ONBOARDING_STEPS.some((step) => step.key === value);
}

@Injectable()
export class WorkspaceOnboardingService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(workspace: WorkspaceRequestContext, actor: AuthenticatedUser) {
    const result = await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) => client.query<{
        checklist: Record<string, OnboardingStepStatus>;
        dismissed_at: Date | null;
        completed_at: Date | null;
      }>(
        'SELECT checklist, dismissed_at, completed_at FROM workspace_onboarding WHERE workspace_id = $1',
        [workspace.id],
      ),
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Workspace onboarding state was not found.');
    const steps = ONBOARDING_STEPS.map((step) => ({
      ...step,
      status: row.checklist[step.key] ?? 'pending',
    }));
    return {
      essentialSetupComplete: true,
      dismissed: row.dismissed_at !== null,
      completed: row.completed_at !== null,
      completedAt: row.completed_at,
      steps,
      progress: {
        completed: steps.filter((step) => step.status === 'completed').length,
        skipped: steps.filter((step) => step.status === 'skipped').length,
        total: steps.length,
      },
    };
  }

  async updateStep(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    stepInput: unknown,
    statusInput: unknown,
  ) {
    if (!isStepKey(stepInput)) throw new BadRequestException('Unknown onboarding step.');
    if (!['pending', 'completed', 'skipped'].includes(String(statusInput))) {
      throw new BadRequestException('Step status must be pending, completed, or skipped.');
    }
    const status = statusInput as OnboardingStepStatus;
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const updated = await client.query(
          `UPDATE workspace_onboarding
              SET checklist = jsonb_set(checklist, ARRAY[$2]::text[], to_jsonb($3::text), true),
                  dismissed_at = NULL,
                  completed_at = CASE
                    WHEN NOT EXISTS (
                      SELECT 1
                      FROM jsonb_each_text(jsonb_set(checklist, ARRAY[$2]::text[], to_jsonb($3::text), true)) item
                      WHERE item.value NOT IN ('completed', 'skipped')
                    ) THEN now()
                    ELSE NULL
                  END,
                  updated_by = $4, updated_at = now()
            WHERE workspace_id = $1
            RETURNING workspace_id`,
          [workspace.id, stepInput, status, actor.id],
        );
        if (!updated.rowCount) throw new NotFoundException('Workspace onboarding state was not found.');
        await client.query(
          "INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id, details) VALUES ($1, $2, 'workspace.onboarding_step_updated', 'onboarding_step', $3, $4::jsonb)",
          [workspace.id, actor.id, stepInput, JSON.stringify({ status })],
        );
        return this.getWithinTransaction(client, workspace.id);
      },
    );
  }

  async setDismissed(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    dismissed: boolean,
  ) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const updated = await client.query(
          'UPDATE workspace_onboarding SET dismissed_at = $2, updated_by = $3, updated_at = now() WHERE workspace_id = $1 RETURNING workspace_id',
          [workspace.id, dismissed ? new Date() : null, actor.id],
        );
        if (!updated.rowCount) throw new NotFoundException('Workspace onboarding state was not found.');
        await client.query(
          "INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id, details) VALUES ($1, $2, 'workspace.onboarding_dismissed', 'workspace', $1, $3::jsonb)",
          [workspace.id, actor.id, JSON.stringify({ dismissed })],
        );
        return this.getWithinTransaction(client, workspace.id);
      },
    );
  }

  private async getWithinTransaction(client: import('pg').PoolClient, workspaceId: VerifiedWorkspaceId) {
    const result = await client.query<{
      checklist: Record<string, OnboardingStepStatus>;
      dismissed_at: Date | null;
      completed_at: Date | null;
    }>(
      'SELECT checklist, dismissed_at, completed_at FROM workspace_onboarding WHERE workspace_id = $1',
      [workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Workspace onboarding state was not found.');
    const steps = ONBOARDING_STEPS.map((step) => ({ ...step, status: row.checklist[step.key] ?? 'pending' }));
    return {
      essentialSetupComplete: true,
      dismissed: row.dismissed_at !== null,
      completed: row.completed_at !== null,
      completedAt: row.completed_at,
      steps,
      progress: {
        completed: steps.filter((step) => step.status === 'completed').length,
        skipped: steps.filter((step) => step.status === 'skipped').length,
        total: steps.length,
      },
    };
  }
}
