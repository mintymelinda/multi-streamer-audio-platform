import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  HttpRequest,
  WorkspaceRequestContext,
} from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import { WorkspacesService } from './workspaces.service.js';

function requireAuthenticatedUser(request: HttpRequest): AuthenticatedUser {
  const user = request.user;
  if (!user) throw new UnauthorizedException('Sign-in is required.');
  return user;
}

function requireWorkspaceContext(request: HttpRequest): WorkspaceRequestContext {
  const workspace = request.workspace;
  if (!workspace) throw new NotFoundException('Workspace not found.');
  return workspace;
}

@Controller('workspaces')
@UseGuards(SessionGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@Req() request: HttpRequest) {
    return this.workspaces.list(requireAuthenticatedUser(request).id);
  }

  @Post()
  @UseGuards(CsrfGuard)
  create(@Req() request: HttpRequest, @Body() body: unknown) {
    const name =
      typeof body === 'object' && body !== null && 'name' in body ? body.name : undefined;
    return this.workspaces.create(requireAuthenticatedUser(request).id, name);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceAccessGuard)
  getCurrentWorkspace(@Param('workspaceId') workspaceId: string, @Req() request: HttpRequest) {
    const workspace = requireWorkspaceContext(request);
    return { workspaceId, role: workspace.role, status: workspace.status };
  }
}
