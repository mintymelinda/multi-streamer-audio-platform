export const DATABASE_READINESS = 'DATABASE_READINESS' as const;

export interface DatabaseReadinessProbe {
  queryInfrastructure(sql: string): Promise<unknown>;
}
