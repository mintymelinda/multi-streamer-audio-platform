import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspacesModule } from './workspaces.module.js';
import { WorkspaceLifecycleController } from './workspace-lifecycle.controller.js';
import { WorkspaceLifecycleService } from './workspace-lifecycle.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, WorkspacesModule, AssetsModule],
  controllers: [WorkspaceLifecycleController],
  providers: [WorkspaceLifecycleService],
})
export class WorkspaceLifecycleModule {}
