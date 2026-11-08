import { BadRequestException, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { HttpRequest } from '../identity/http.types.js';
import { TwitchEventSubService } from './twitch-eventsub.service.js';

interface WebhookReply {
  code(statusCode: number): this;
  type(contentType: string): this;
  send(payload?: string): unknown;
}

@Controller('webhooks/twitch/eventsub')
export class TwitchEventSubController {
  constructor(
    @Inject(TwitchEventSubService) private readonly eventSub: TwitchEventSubService,
  ) {}

  @Post()
  async receive(@Req() request: HttpRequest, @Res() reply: WebhookReply) {
    if (!request.rawBody) {
      throw new BadRequestException('Raw Twitch EventSub request body is unavailable.');
    }
    const result = await this.eventSub.receive(request.headers, request.rawBody);
    if (result.kind === 'challenge') {
      return reply.code(200).type('text/plain; charset=utf-8').send(result.challenge);
    }
    return reply.code(204).send();
  }
}
