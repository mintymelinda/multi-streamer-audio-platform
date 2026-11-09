import type { VerifiedWorkspaceId } from '@platform/contracts';

export interface AuthenticatedUser {
  id: string;
  twitchUserId: string;
  sessionId: string;
  csrfTokenHash: string;
}

export interface WorkspaceRequestContext {
  id: VerifiedWorkspaceId;
  role: 'owner' | 'admin' | 'moderator' | 'viewer';
  status: 'active' | 'restricted' | 'suspended';
}

export interface HttpRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  user?: AuthenticatedUser;
  workspace?: WorkspaceRequestContext;
  rawBody?: Buffer;
}

export interface HttpReply {
  header(name: string, value: string | string[]): this;
  redirect(url: string): this;
  code(statusCode: number): this;
}
