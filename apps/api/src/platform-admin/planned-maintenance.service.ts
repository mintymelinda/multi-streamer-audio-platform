import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

const SERVICES = ['all', 'api', 'dashboard', 'overlay', 'playback', 'authentication', 'twitch', 'spotify', 'lyrion'];

export interface PlannedMaintenanceRecord {
  id: string;
  title: string;
  summary: string;
  expected_impact: string;
  affected_services: string[];
  starts_at: Date;
  ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
  cancelled_at?: Date | null;
  state: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
}

@Injectable()
export class PlannedMaintenanceService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(actorUserId: string): Promise<PlannedMaintenanceRecord[]> {
    return this.database.transaction({ userId: actorUserId }, async (client) => {
      const result = await client.query<PlannedMaintenanceRecord>('SELECT * FROM list_platform_planned_maintenance()');
      return result.rows;
    });
  }

  async save(actorUserId: string, input: {
    id?: unknown; title?: unknown; summary?: unknown; expectedImpact?: unknown;
    affectedServices?: unknown; startsAt?: unknown; endsAt?: unknown;
  }): Promise<{ id: string }> {
    const id = input.id === undefined || input.id === null ? null : input.id;
    if (id !== null && (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
      throw new BadRequestException('A valid maintenance ID is required.');
    }
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    const expectedImpact = typeof input.expectedImpact === 'string' ? input.expectedImpact.trim() : '';
    if (title.length < 5 || title.length > 160) throw new BadRequestException('Title must be between 5 and 160 characters.');
    if (summary.length < 10 || summary.length > 2000) throw new BadRequestException('Summary must be between 10 and 2,000 characters.');
    if (expectedImpact.length < 5 || expectedImpact.length > 1000) throw new BadRequestException('Expected impact must be between 5 and 1,000 characters.');
    if (!Array.isArray(input.affectedServices) || input.affectedServices.length < 1 || input.affectedServices.length > SERVICES.length ||
        input.affectedServices.some((value) => typeof value !== 'string' || !SERVICES.includes(value)) ||
        new Set(input.affectedServices).size !== input.affectedServices.length) {
      throw new BadRequestException('Select one or more valid affected services.');
    }
    const startsAt = typeof input.startsAt === 'string' ? new Date(input.startsAt) : new Date(Number.NaN);
    const endsAt = input.endsAt === null || input.endsAt === '' || input.endsAt === undefined
      ? null : typeof input.endsAt === 'string' ? new Date(input.endsAt) : new Date(Number.NaN);
    if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      throw new BadRequestException('Maintenance must have a valid future start time.');
    }
    if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt <= startsAt)) {
      throw new BadRequestException('End time must be later than the start time.');
    }
    return this.database.transaction({ userId: actorUserId }, async (client) => {
      const result = await client.query<{ id: string }>(
        'SELECT set_platform_planned_maintenance($1::uuid, $2, $3, $4, $5::text[], $6::timestamptz, $7::timestamptz) AS id',
        [id, title, summary, expectedImpact, input.affectedServices, startsAt.toISOString(), endsAt?.toISOString() ?? null],
      );
      if (!result.rows[0]) throw new Error('Maintenance save returned no record.');
      return { id: result.rows[0].id };
    });
  }

  async cancel(actorUserId: string, id: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('A valid maintenance ID is required.');
    }
    await this.database.transaction({ userId: actorUserId }, async (client) => {
      const result = await client.query<{ cancel_platform_planned_maintenance: boolean }>(
        'SELECT cancel_platform_planned_maintenance($1::uuid)', [id],
      );
      if (!result.rows[0]) throw new NotFoundException('Planned maintenance was not found.');
    });
  }
}
