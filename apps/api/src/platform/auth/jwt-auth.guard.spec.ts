import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tenantContext } from '../db/tenant-context.js';
import type { AuthUser } from './current-user.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Public } from './public.decorator.js';
import { Roles } from './roles.decorator.js';
import type { TokenService } from './token.service.js';

const user: AuthUser = { userId: 'u1', tenantId: 't1', role: 'cashier' };

class Routes {
  open() {}
  @Public()
  pub() {}
  @Roles('owner', 'admin')
  managers() {}
  @Roles('cashier')
  cashiers() {}
}

@Roles('owner')
class OwnersOnly {
  any() {}
  @Roles('cashier')
  override() {}
}

function setup(authorization?: string) {
  const verifyAccess = vi.fn().mockResolvedValue(user);
  const guard = new JwtAuthGuard(new Reflector(), { verifyAccess } as unknown as TokenService);
  const request: { headers: Record<string, string | undefined>; user?: AuthUser } = { headers: { authorization } };
  const ctx = (cls: new () => object, method: string) =>
    ({
      getHandler: () => (cls.prototype as Record<string, unknown>)[method],
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;
  return { guard, request, ctx, verifyAccess };
}

describe('JwtAuthGuard', () => {
  it('@Public() pasa sin token y sin verificar nada', async () => {
    const { guard, ctx, verifyAccess } = setup();
    await expect(guard.canActivate(ctx(Routes, 'pub'))).resolves.toBe(true);
    expect(verifyAccess).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'token-suelto'])('cabecera %j → 401', async (header) => {
    const { guard, ctx } = setup(header);
    await expect(guard.canActivate(ctx(Routes, 'open'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('con token válido fija request.user y el tenant del contexto', async () => {
    const { guard, ctx, request, verifyAccess } = setup('Bearer abc');
    const tenantId = await tenantContext.run({}, async () => {
      await guard.canActivate(ctx(Routes, 'open'));
      return tenantContext.getTenantId();
    });
    expect(verifyAccess).toHaveBeenCalledWith('abc');
    expect(request.user).toEqual(user);
    expect(tenantId).toBe('t1');
  });

  it('@Roles: 403 si el rol no está permitido, pasa si lo está', async () => {
    const { guard, ctx } = setup('Bearer abc');
    await tenantContext.run({}, async () => {
      await expect(guard.canActivate(ctx(Routes, 'managers'))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(ctx(Routes, 'cashiers'))).resolves.toBe(true);
    });
  });

  it('@Roles de clase aplica a sus métodos y el del método tiene prioridad', async () => {
    const { guard, ctx } = setup('Bearer abc');
    await tenantContext.run({}, async () => {
      await expect(guard.canActivate(ctx(OwnersOnly, 'any'))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(ctx(OwnersOnly, 'override'))).resolves.toBe(true);
    });
  });
});
