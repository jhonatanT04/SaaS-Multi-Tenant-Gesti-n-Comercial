import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { Kysely, sql } from 'kysely';
import { Public } from '../auth/public.decorator.js';
import { KYSELY } from '../db/database.constants.js';
import type { DB } from '../db/schema.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    @Inject(KYSELY) private readonly db: Kysely<DB>,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () =>
        this.indicators
          .check('database')
          .attempt(async () => {
            await sql`select 1`.execute(this.db);
          })
          .withTimeout(2000),
    ]);
  }
}
