import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export interface PublicIncident {
  id: string; title: string; summary: string;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  impact: 'degraded' | 'partial_outage' | 'major_outage';
  affected_services: string[]; created_at: Date; updated_at: Date; resolved_at: Date | null;
}
export interface PublicMaintenance {
  id: string; title: string; summary: string; expected_impact: string;
  affected_services: string[]; starts_at: Date; ends_at: Date | null;
  created_at: Date; updated_at: Date; state: 'scheduled' | 'in_progress' | 'completed';
}

@Injectable()
export class ServiceStatusService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async publicStatus() {
    const { incidents, maintenance } = await this.database.transaction({}, async (client) => {
      const incidentResult = await client.query<PublicIncident>('SELECT * FROM list_public_service_incidents()');
      const maintenanceResult = await client.query<PublicMaintenance>('SELECT * FROM list_public_planned_maintenance()');
      return { incidents: incidentResult.rows, maintenance: maintenanceResult.rows };
    });
    const active = incidents.filter((incident) => incident.status !== 'resolved');
    const status = active.some((incident) => incident.impact === 'major_outage')
      ? 'major_outage'
      : active.some((incident) => incident.impact === 'partial_outage')
        ? 'partial_outage'
        : active.length > 0 ? 'degraded' : 'operational';
    return { status, incidents, maintenance };
  }
}
