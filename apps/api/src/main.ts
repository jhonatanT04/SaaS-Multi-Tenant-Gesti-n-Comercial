import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { Env } from './platform/config/env.js';
import { setupApp } from './platform/setup-app.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // Sin esto, tras un proxy todas las peticiones comparten IP (la del proxy) y el rate limit las agrupa.
  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  if (trustProxy) {
    const value = /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
    (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set('trust proxy', value);
  }
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
