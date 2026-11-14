import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tenantContext } from '../db/tenant-context.js';
import type { AuthUser } from './current-user.decorator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { ROLES_KEY } from './roles.decorator.js';
import { TokenService } from './token.service.js';

/**
 * Guard global: exige un access token válido salvo en rutas `@Public()`, deja
 * el usuario en `request.user`, fija el tenant del request para `TenantDb.run`
 * y aplica `@Roles()`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined>; user?: AuthUser }>();
    const header = request.headers.authorization;
    const [scheme, token] = typeof header === 'string' ? header.split(' ') : [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Falta el token de acceso');
    }

    const user = await this.tokens.verifyAccess(token);
    request.user = user;
    tenantContext.setTenantId(user.tenantId);

    const roles = this.reflector.getAllAndOverride<AuthUser['role'][] | undefined>(ROLES_KEY, targets);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException('Tu rol no permite esta operación');
    }
    return true;
  }
}
