import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TeamController, MyInvitationsController } from './team.controller.js';
import { TeamService } from './team.service.js';
import { TwitchDirectoryService } from './twitch-directory.service.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import { WorkspacePermissionGuard } from './workspace-permission.guard.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';
import { WorkspaceOnboardingController } from './workspace-onboarding.controller.js';
import { WorkspaceOnboardingService } from './workspace-onboarding.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [WorkspacesController, TeamController, MyInvitationsController, WorkspaceOnboardingController],
  providers: [
    WorkspacesService,
    WorkspaceOnboardingService,
    TeamService,
    TwitchDirectoryService,
    WorkspaceAccessGuard,
    WorkspacePermissionGuard,
  ],
  exports: [WorkspaceAccessGuard, WorkspacePermissionGuard],
})
export class WorkspacesModule {}
