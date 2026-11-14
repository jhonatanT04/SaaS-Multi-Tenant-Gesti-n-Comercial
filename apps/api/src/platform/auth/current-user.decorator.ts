import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  userId: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'cashier';
}

/** Usuario autenticado del request (lo fija el guard JWT global). */
export const CurrentUser: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<{ user: AuthUser }>().user,
);
