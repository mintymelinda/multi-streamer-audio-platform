import { Injectable } from '@nestjs/common';
import {
  PlaybackCoordinatorError,
  type PlaybackAdapter,
  type PlaybackCommandInput,
} from '../playback/playback-coordinator.service.js';

export type PlaybackAdapterFactory = (
  input: PlaybackCommandInput,
) => Promise<PlaybackAdapter> | PlaybackAdapter;

@Injectable()
export class PlaybackAdapterRegistry {
  private readonly factories = new Map<string, PlaybackAdapterFactory>();

  register(providerId: string, factory: PlaybackAdapterFactory): void {
    const normalized = normalizeProviderId(providerId);
    if (this.factories.has(normalized)) {
      throw new Error(`A playback adapter is already registered for ${normalized}.`);
    }
    this.factories.set(normalized, factory);
  }

  async resolve(
    providerId: string,
    input: PlaybackCommandInput,
  ): Promise<PlaybackAdapter> {
    const normalized = normalizeProviderId(providerId);
    const factory = this.factories.get(normalized);
    if (!factory) {
      throw new PlaybackCoordinatorError(
        `No playback output adapter is registered for provider ${normalized}.`,
        'PROVIDER_OUTPUT_NOT_CONFIGURED',
      );
    }
    return factory(input);
  }

  has(providerId: string): boolean {
    return this.factories.has(normalizeProviderId(providerId));
  }
}

function normalizeProviderId(providerId: string): string {
  const value = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new TypeError('Playback output provider ID is invalid.');
  }
  return value;
}
