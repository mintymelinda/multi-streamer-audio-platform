import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { AssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';
import { ObjectStorageService } from './object-storage.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, WorkspacesModule],
  controllers: [AssetsController],
  providers: [AssetsService, ObjectStorageService],
  exports: [AssetsService, ObjectStorageService],
})
export class AssetsModule {}
