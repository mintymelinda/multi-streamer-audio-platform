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

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [WorkspacesController, TeamController, MyInvitationsController],
  providers: [
    WorkspacesService,
    TeamService,
    TwitchDirectoryService,
    WorkspaceAccessGuard,
    WorkspacePermissionGuard,
  ],
})
export class WorkspacesModule {}
