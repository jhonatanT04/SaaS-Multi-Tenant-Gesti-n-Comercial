import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { BillingModule } from './billing/billing.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import { ENV_FILE, envSchema } from './platform/config/env.js';
import { DatabaseModule } from './platform/db/database.module.js';
import { tenantContext } from './platform/db/tenant-context.js';
import { HealthModule } from './platform/health/health.module.js';
import { PlansModule } from './platform/plans/plans.module.js';
import { UsersModule } from './platform/users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ENV_FILE, validationSchema: envSchema }),
    DatabaseModule,
    AuthModule,
    PlansModule,
    UsersModule,
    HealthModule,
    BillingModule,
  ],
  // Valida todo parámetro declarado con `{ schema }` (Zod / Standard Schema).
  providers: [{ provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Abre el contexto por request que el guard JWT completa con el tenant.
    consumer
      .apply((_req: unknown, _res: unknown, next: () => void) => tenantContext.run({}, next))
      .forRoutes('{*splat}');
  }
}
