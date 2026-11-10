import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { HttpReply } from '../identity/http.types.js';
import { OverlayRuntimeService } from './overlay-runtime.service.js';

@Controller('overlay/scenes')
export class OverlayRuntimeController {
  constructor(@Inject(OverlayRuntimeService) private readonly runtime: OverlayRuntimeService) {}

  @Get(':sceneId/snapshot')
  async snapshot(
    @Param('sceneId') sceneId: string,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    reply.header('Cache-Control', 'no-store, private');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Vary', 'Authorization');
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new NotFoundException('Overlay scene is unavailable.');
    const snapshot = await this.runtime.snapshot(sceneId, token);
    if (!snapshot) throw new NotFoundException('Overlay scene is unavailable.');
    return snapshot;
  }
}
