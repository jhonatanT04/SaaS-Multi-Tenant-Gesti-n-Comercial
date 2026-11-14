import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { hashToken, newOpaqueToken } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/current-user.decorator.js';
import type { DB, Role } from '../db/schema.js';
import { TenantDb } from '../db/tenant-db.service.js';
import { PlanService } from '../plans/plan.service.js';
import type { ChangeRoleDto, InviteDto, ListQuery } from './users.schemas.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Miembros del tenant actual. Ninguna consulta filtra por `tenant_id`: lo hace
 * la RLS a través de `TenantDb.run`.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly plans: PlanService,
  ) {}

  list(query: ListQuery) {
    return this.tenantDb.run(async (trx) => {
      const data = await trx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.email', 'u.name', 'm.role', 'm.created_at as joinedAt'])
        .orderBy('m.created_at')
        .orderBy('u.id')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      const { total } = await trx
        .selectFrom('memberships')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow();
      return { data, page: query.page, pageSize: query.pageSize, total: Number(total) };
    });
  }

  /**
   * Crea (o reemplaza) la invitación pendiente para ese email. El token solo se
   * devuelve aquí; en la base queda su hash. Aún no hay envío de correo: quien
   * invita entrega el token.
   */
  invite(actor: AuthUser, dto: InviteDto) {
    assertCanGrant(actor, dto.role);
    return this.tenantDb.run(async (trx) => {
      const member = await trx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select('u.id')
        .where('u.email', '=', dto.email)
        .executeTakeFirst();
      if (member) throw new ConflictException('Ese usuario ya es miembro de la organización');

      await trx.deleteFrom('invitations').where('email', '=', dto.email).where('accepted_at', 'is', null).execute();
      // Después de borrar la pendiente del mismo email, que no debe contar dos veces.
      await this.plans.assertCanAddUser(trx);
      const token = newOpaqueToken();
      const invitation = await trx
        .insertInto('invitations')
        .values({
          tenant_id: actor.tenantId,
          email: dto.email,
          role: dto.role,
          token_hash: hashToken(token),
          invited_by: actor.userId,
          expires_at: new Date(Date.now() + INVITATION_TTL_MS),
        })
        .returning(['id', 'email', 'role', 'expires_at as expiresAt'])
        .executeTakeFirstOrThrow();
      return { ...invitation, token };
    });
  }

  listInvitations(query: ListQuery) {
    return this.tenantDb.run(async (trx) => {
      const data = await trx
        .selectFrom('invitations')
        .select(['id', 'email', 'role', 'expires_at as expiresAt', 'created_at as createdAt'])
        .where('accepted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      const { total } = await trx
        .selectFrom('invitations')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .where('accepted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return { data, page: query.page, pageSize: query.pageSize, total: Number(total) };
    });
  }

  async revokeInvitation(id: string): Promise<void> {
    const result = await this.tenantDb.run((trx) =>
      trx.deleteFrom('invitations').where('id', '=', id).where('accepted_at', 'is', null).executeTakeFirst(),
    );
    if (result.numDeletedRows === 0n) throw new NotFoundException('Invitación no encontrada');
  }

  changeRole(actor: AuthUser, userId: string, dto: ChangeRoleDto) {
    assertCanGrant(actor, dto.role);
    return this.tenantDb.run(async (trx) => {
      const target = await this.lockTarget(trx, actor, userId);
      if (target.role === 'owner' && dto.role !== 'owner') await assertNotLastOwner(trx);
      return trx
        .updateTable('memberships')
        .set({ role: dto.role })
        .where('user_id', '=', userId)
        .returning(['user_id as id', 'role'])
        .executeTakeFirstOrThrow();
    });
  }

  /** Quita al miembro del tenant. Sus refresh tokens se borran en cascada. */
  async remove(actor: AuthUser, userId: string): Promise<void> {
    await this.tenantDb.run(async (trx) => {
      const target = await this.lockTarget(trx, actor, userId);
      if (target.role === 'owner') await assertNotLastOwner(trx);
      await trx.deleteFrom('memberships').where('user_id', '=', userId).execute();
    });
  }

  private async lockTarget(trx: Transaction<DB>, actor: AuthUser, userId: string): Promise<{ role: Role }> {
    // Bloquea todas las memberships del tenant para que dos cambios simultáneos
    // no dejen a la organización sin owner.
    const members = await trx.selectFrom('memberships').select(['user_id', 'role']).forUpdate().execute();
    const target = members.find((m) => m.user_id === userId);
    if (!target) throw new NotFoundException('Miembro no encontrado');
    if (target.role === 'owner' && actor.role !== 'owner') {
      throw new ForbiddenException('Solo un owner puede modificar a otro owner');
    }
    return target;
  }
}

function assertCanGrant(actor: AuthUser, role: Role): void {
  if (role === 'owner' && actor.role !== 'owner') {
    throw new ForbiddenException('Solo un owner puede asignar el rol owner');
  }
}

async function assertNotLastOwner(trx: Transaction<DB>): Promise<void> {
  const { owners } = await trx
    .selectFrom('memberships')
    .select((eb) => eb.fn.countAll<string>().as('owners'))
    .where('role', '=', 'owner')
    .executeTakeFirstOrThrow();
  if (Number(owners) <= 1) throw new ConflictException('La organización debe conservar al menos un owner');
}
