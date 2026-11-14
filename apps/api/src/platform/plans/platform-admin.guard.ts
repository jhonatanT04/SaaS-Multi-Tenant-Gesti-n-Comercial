import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { AuthUser } from '../auth/current-user.decorator.js';
import { KYSELY } from '../db/database.constants.js';
import type { DB } from '../db/schema.js';

/**
 * Solo super-admins de plataforma (usuarios listados en `platform_admins`, ver
 * migración 0002). Se consulta en cada request, así que quitar a alguien de la
 * tabla surte efecto de inmediato. No da acceso a datos de otros tenants.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!user) throw new ForbiddenException();
    const { rows } = await sql<{ ok: boolean }>`select platform_is_admin(${user.userId}) as ok`.execute(this.db);
    if (!rows[0]?.ok) throw new ForbiddenException('Solo para administradores de la plataforma');
    return true;
  }
}
