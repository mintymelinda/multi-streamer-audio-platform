import { Injectable } from '@nestjs/common';
import {
  InvidiousResolverService,
  type InvidiousResolvedMedia,
} from './invidious-resolver.service.js';

export interface PlaybackMediaSource {
  providerId: string;
  mediaId: string | null;
  mediaUrl: string | null;
}

export interface ResolvedPlaybackMedia {
  sourceProviderId: 'youtube';
  mediaId: string;
  title: string;
  artist: string | null;
  durationSeconds: number;
  mimeType: string;
  bitrate: number;
  streamUrl: string;
}

export interface PlaybackMediaSourceResolver {
  readonly providerId: string;
  resolve(source: PlaybackMediaSource): Promise<ResolvedPlaybackMedia>;
}

@Injectable()
export class YouTubeInvidiousMediaResolver implements PlaybackMediaSourceResolver {
  readonly providerId = 'youtube';

  constructor(private readonly invidious: InvidiousResolverService) {}

  async resolve(source: PlaybackMediaSource): Promise<ResolvedPlaybackMedia> {
    if (source.providerId.trim().toLowerCase() !== this.providerId) {
      throw new TypeError('The YouTube resolver cannot resolve another source provider.');
    }
    const mediaUrl = source.mediaUrl?.trim() ||
      (source.mediaId && /^[A-Za-z0-9_-]{11}$/.test(source.mediaId)
        ? `https://www.youtube.com/watch?v=${source.mediaId}`
        : '');
    if (!mediaUrl) throw new TypeError('A valid YouTube media URL or ID is required.');
    const resolved = await this.invidious.resolve(mediaUrl);
    return mapResolvedMedia(resolved);
  }
}

function mapResolvedMedia(value: InvidiousResolvedMedia): ResolvedPlaybackMedia {
  return {
    sourceProviderId: 'youtube',
    mediaId: value.mediaId,
    title: value.title,
    artist: value.author,
    durationSeconds: value.durationSeconds,
    mimeType: value.mimeType,
    bitrate: value.bitrate,
    streamUrl: value.streamUrl,
  };
}
