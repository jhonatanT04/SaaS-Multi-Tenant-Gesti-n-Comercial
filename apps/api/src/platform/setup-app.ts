import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Configuración HTTP común a `main.ts` y a los tests e2e: prefijo `/api/v1` y
 * Swagger en `/api/docs`. La validación (Zod) es global vía APP_PIPE en AppModule.
 */
export function setupApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('Facturación SaaS API')
    .setDescription('API multi-tenant de facturación. Todas las rutas exigen JWT salvo las de /auth y /health.')
    .setVersion('1')
    .addBearerAuth()
    .addSecurityRequirements('bearer')
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));
}
