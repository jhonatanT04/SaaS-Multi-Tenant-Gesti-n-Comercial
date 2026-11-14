import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { type Env, ttlSeconds } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { TokenService } from './token.service.js';

@Module({
  // Los secretos se pasan en cada firma/verificación (access y refresh usan distintos).
  imports: [
    JwtModule.register({}),
    // Un único throttler `default`, aplicado solo en AuthController (no es global).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => [
        {
          ttl: ttlSeconds(config.get('AUTH_RATE_LIMIT_WINDOW', { infer: true })) * 1000,
          limit:
            config.get('AUTH_RATE_LIMIT_MAX', { infer: true }) ??
            (config.get('NODE_ENV', { infer: true }) === 'test' ? 1_000_000 : 10),
        },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [TokenService],
})
export class AuthModule {}
