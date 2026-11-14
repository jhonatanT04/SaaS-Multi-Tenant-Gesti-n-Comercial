import { SetMetadata } from '@nestjs/common';
import type { AuthUser } from './current-user.decorator.js';

export const ROLES_KEY = 'platform:roles';

/** Restringe la ruta (o el controlador) a los roles indicados. Sin él, basta con estar autenticado. */
export const Roles = (...roles: AuthUser['role'][]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
