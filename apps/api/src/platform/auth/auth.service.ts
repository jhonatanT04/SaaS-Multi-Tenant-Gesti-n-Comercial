import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Kysely, sql, type Transaction } from 'kysely';
import { KYSELY } from '../db/database.constants.js';
import type { DB, Role } from '../db/schema.js';
import { TenantDb } from '../db/tenant-db.service.js';
import type { AcceptInvitationDto, LoginDto, RegisterDto } from './auth.schemas.js';
import type { AuthUser } from './current-user.decorator.js';
import { TokenService } from './token.service.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Segundos de vida del access token. */
  expiresIn: number;
}

export interface AuthResult extends TokenPair {
  user: AuthUser;
}

interface LoginRow {
  user_id: string;
  password_hash: string;
  tenant_id: string | null;
  tenant_slug: string | null;
  tenant_name: string | null;
  role: Role | null;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');

@Injectable()
export class AuthService {
  /** Hash contra el que verificar cuando el email no existe, para no delatarlo por tiempo. */
  private dummyHash?: Promise<string>;

  constructor(
    // Conexión sin tenant: aquí solo se usa para llamar a las funciones
    // SECURITY DEFINER `auth_*` (ver cabecera de la migración 0001).
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly tenantDb: TenantDb,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const passwordHash = await argon2.hash(dto.password);
    const baseSlug = dto.tenantSlug ?? slugify(dto.tenantName);
    // Un slug derivado que choca se reintenta con sufijo; uno explícito devuelve 409.
    for (let attempt = 0; ; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug.slice(0, 53)}-${randomBytes(3).toString('hex')}`;
      try {
        const { rows } = await sql<{ tenant_id: string; user_id: string }>`
          select tenant_id, user_id from auth_register(
            ${dto.tenantName}, ${slug}, ${dto.currency}, ${dto.taxRate},
            ${dto.email}, ${passwordHash}, ${dto.name})`.execute(this.db);
        const user: AuthUser = { userId: rows[0].user_id, tenantId: rows[0].tenant_id, role: 'owner' };
        return await this.issue(user);
      } catch (err) {
        const constraint = uniqueViolation(err);
        if (constraint === 'users_email_key') {
          throw new ConflictException('Ya existe una cuenta con ese email');
        }
        if (constraint === 'tenants_slug_key') {
          if (!dto.tenantSlug && attempt < 3) continue;
          throw new ConflictException('Ese identificador de organización ya está en uso');
        }
        throw err;
      }
    }
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const { rows } = await sql<LoginRow>`
      select user_id, password_hash, tenant_id, tenant_slug, tenant_name, role
      from auth_login_lookup(${dto.email})`.execute(this.db);

    const hash = rows[0]?.password_hash ?? (await (this.dummyHash ??= argon2.hash(newOpaqueToken())));
    const ok = await argon2.verify(hash, dto.password);
    if (!ok || rows.length === 0) throw new UnauthorizedException('Credenciales inválidas');

    const memberships = rows.filter((r) => r.tenant_id !== null);
    if (memberships.length === 0) {
      throw new ForbiddenException('Tu cuenta no pertenece a ninguna organización');
    }
    let chosen = memberships[0];
    if (dto.tenantSlug) {
      const match = memberships.find((m) => m.tenant_slug === dto.tenantSlug);
      if (!match) throw new UnauthorizedException('Credenciales inválidas');
      chosen = match;
    } else if (memberships.length > 1) {
      throw new BadRequestException({
        message: 'Perteneces a varias organizaciones; indica tenantSlug',
        error: 'TenantSelectionRequired',
        statusCode: 400,
        tenants: memberships.map((m) => ({ slug: m.tenant_slug, name: m.tenant_name, role: m.role })),
      });
    }
    return this.issue({ userId: chosen.user_id, tenantId: chosen.tenant_id!, role: chosen.role! });
  }

  /**
   * Rota el refresh token: el presentado queda revocado y se emite otro de la
   * misma familia. Presentar uno ya revocado (posible robo) revoca la familia entera.
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const claims = await this.tokens.verifyRefresh(refreshToken);
    const next = await this.tokens.signRefresh(claims, claims.familyId);

    const outcome = await this.tenantDb.runAs(claims.tenantId, async (trx) => {
      const row = await trx
        .selectFrom('refresh_tokens')
        .select(['id', 'user_id', 'family_id', 'revoked_at', 'expires_at'])
        .where('id', '=', claims.jti)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.user_id !== claims.userId || row.expires_at <= new Date()) return 'invalid' as const;
      if (row.revoked_at) {
        await this.revokeFamily(trx, row.family_id);
        return 'reused' as const;
      }
      const membership = await trx
        .selectFrom('memberships')
        .select('role')
        .where('user_id', '=', claims.userId)
        .executeTakeFirst();
      if (!membership) return 'invalid' as const;

      await trx.updateTable('refresh_tokens').set({ revoked_at: new Date() }).where('id', '=', row.id).execute();
      await this.storeRefresh(trx, next);
      return { role: membership.role };
    });

    if (outcome === 'invalid' || outcome === 'reused') {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }
    const user: AuthUser = { userId: claims.userId, tenantId: claims.tenantId, role: outcome.role };
    return this.pair(user, next.token);
  }

  /** Cierra la sesión: revoca la familia del refresh token. Idempotente. */
  async logout(refreshToken: string): Promise<void> {
    let claims;
    try {
      claims = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      return;
    }
    await this.tenantDb.runAs(claims.tenantId, (trx) => this.revokeFamily(trx, claims.familyId));
  }

  async acceptInvitation(dto: AcceptInvitationDto): Promise<AuthResult> {
    const tokenHash = hashToken(dto.token);
    const invalid = () => new NotFoundException('Invitación inválida o expirada');

    const lookup = await sql<{ email: string; existing_user_id: string | null; existing_password_hash: string | null }>`
      select email, existing_user_id, existing_password_hash
      from auth_invitation_lookup(${tokenHash})`.execute(this.db);
    const invitation = lookup.rows[0];
    if (!invitation) throw invalid();

    let passwordHash: string | null = null;
    if (invitation.existing_password_hash) {
      // La cuenta ya existe: el token solo no basta, hay que probar que es suya.
      if (!(await argon2.verify(invitation.existing_password_hash, dto.password))) {
        throw new UnauthorizedException('Ya tienes una cuenta: usa tu contraseña actual');
      }
    } else {
      if (!dto.name) throw new BadRequestException('name: obligatorio para crear la cuenta');
      passwordHash = await argon2.hash(dto.password);
    }

    const accepted = await sql<{ tenant_id: string; user_id: string; role: Role }>`
      select tenant_id, user_id, role
      from auth_accept_invitation(${tokenHash}, ${passwordHash}, ${dto.name ?? null})`.execute(this.db);
    const row = accepted.rows[0];
    if (!row) throw invalid();
    return this.issue({ userId: row.user_id, tenantId: row.tenant_id, role: row.role });
  }

  async me(user: AuthUser) {
    return this.tenantDb.run(async (trx) => {
      const row = await trx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .innerJoin('tenants as t', 't.id', 'm.tenant_id')
        .select(['u.id', 'u.email', 'u.name', 'm.role', 't.id as tenant_id', 't.name as tenant_name', 't.slug', 't.currency', 't.tax_rate'])
        .where('m.user_id', '=', user.userId)
        .executeTakeFirst();
      // El token sigue vigente pero el usuario ya no es miembro.
      if (!row) throw new UnauthorizedException('Ya no perteneces a esta organización');
      return {
        user: { id: row.id, email: row.email, name: row.name, role: row.role },
        tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.slug, currency: row.currency, taxRate: row.tax_rate },
      };
    });
  }

  private async issue(user: AuthUser): Promise<AuthResult> {
    const refresh = await this.tokens.signRefresh(user);
    await this.tenantDb.runAs(user.tenantId, (trx) => this.storeRefresh(trx, refresh));
    return this.pair(user, refresh.token);
  }

  private async pair(user: AuthUser, refreshToken: string): Promise<AuthResult> {
    return {
      accessToken: await this.tokens.signAccess(user),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      user,
    };
  }

  private async storeRefresh(
    trx: Transaction<DB>,
    refresh: Awaited<ReturnType<TokenService['signRefresh']>>,
  ): Promise<void> {
    await trx
      .insertInto('refresh_tokens')
      .values({
        id: refresh.claims.jti,
        tenant_id: refresh.claims.tenantId,
        user_id: refresh.claims.userId,
        family_id: refresh.claims.familyId,
        expires_at: refresh.expiresAt,
      })
      .execute();
  }

  private async revokeFamily(trx: Transaction<DB>, familyId: string): Promise<void> {
    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug.length >= 3 ? slug : `org-${randomBytes(4).toString('hex')}`;
}

/** Nombre del constraint si `err` es una violación de unicidad de Postgres. */
export function uniqueViolation(err: unknown): string | undefined {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' ? (e.constraint ?? 'unknown') : undefined;
}
