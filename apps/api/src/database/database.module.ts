import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { DATABASE_READINESS } from './database-readiness.js';

@Global()
@Module({
  providers: [
    DatabaseService,
    { provide: DATABASE_READINESS, useExisting: DatabaseService },
  ],
  exports: [DatabaseService, DATABASE_READINESS],
})
export class DatabaseModule {}
