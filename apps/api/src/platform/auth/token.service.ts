import { randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { type Env, ttlSeconds } from '../config/env.js';
import type { AuthUser } from './current-user.decorator.js';

const ROLES: readonly string[] = ['owner', 'admin', 'cashier'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RefreshClaims {
  userId: string;
  tenantId: string;
  /** Id de la fila en `refresh_tokens`. */
  jti: string;
  familyId: string;
}

/** Firma y verifica los JWT. Access y refresh usan secretos distintos y un claim `typ`. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get accessTtlSeconds(): number {
    return ttlSeconds(this.config.get('JWT_ACCESS_TTL', { infer: true }));
  }

  get refreshTtlSeconds(): number {
    return ttlSeconds(this.config.get('JWT_REFRESH_TTL', { infer: true }));
  }

  signAccess(user: AuthUser): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.userId, tid: user.tenantId, role: user.role, typ: 'access' },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        algorithm: 'HS256',
        expiresIn: this.accessTtlSeconds,
      },
    );
  }

  async signRefresh(
    user: Pick<AuthUser, 'userId' | 'tenantId'>,
    familyId: string = randomUUID(),
  ): Promise<{ token: string; claims: RefreshClaims; expiresAt: Date }> {
    const claims: RefreshClaims = {
      userId: user.userId,
      tenantId: user.tenantId,
      jti: randomUUID(),
      familyId,
    };
    const token = await this.jwt.signAsync(
      { sub: claims.userId, tid: claims.tenantId, fam: claims.familyId, typ: 'refresh' },
      {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        algorithm: 'HS256',
        expiresIn: this.refreshTtlSeconds,
        jwtid: claims.jti,
      },
    );
    return { token, claims, expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000) };
  }

  async verifyAccess(token: string): Promise<AuthUser> {
    const p = await this.verify(token, 'JWT_ACCESS_SECRET');
    if (p.typ !== 'access' || !isUuid(p.sub) || !isUuid(p.tid) || !ROLES.includes(p.role as string)) {
      throw new UnauthorizedException('Token de acceso inválido');
    }
    return { userId: p.sub, tenantId: p.tid, role: p.role as AuthUser['role'] };
  }

  async verifyRefresh(token: string): Promise<RefreshClaims> {
    const p = await this.verify(token, 'JWT_REFRESH_SECRET');
    if (p.typ !== 'refresh' || !isUuid(p.sub) || !isUuid(p.tid) || !isUuid(p.jti) || !isUuid(p.fam)) {
      throw new UnauthorizedException('Refresh token inválido');
    }
    return { userId: p.sub, tenantId: p.tid, jti: p.jti, familyId: p.fam };
  }

  private async verify(
    token: string,
    secretKey: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET',
  ): Promise<Record<string, unknown>> {
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.get(secretKey, { infer: true }),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
