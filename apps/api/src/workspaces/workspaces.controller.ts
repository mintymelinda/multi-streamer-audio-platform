import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../identity/csrf.guard.js';
import type { HttpRequest } from '../identity/http.types.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import { WorkspacesService } from './workspaces.service.js';

@Controller('workspaces')
@UseGuards(SessionGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@Req() request: HttpRequest) {
    return this.workspaces.list(request.user!.id);
  }

  @Post()
  @UseGuards(CsrfGuard)
  create(@Req() request: HttpRequest, @Body() body: unknown) {
    const name = typeof body === 'object' && body !== null && 'name' in body ? body.name : undefined;
    return this.workspaces.create(request.user!.id, name);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceAccessGuard)
  getCurrentWorkspace(@Param('workspaceId') workspaceId: string, @Req() request: HttpRequest) {
    return { workspaceId, role: request.workspace!.role, status: request.workspace!.status };
  }
}
