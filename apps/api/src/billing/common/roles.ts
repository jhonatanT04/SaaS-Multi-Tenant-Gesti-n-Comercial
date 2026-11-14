import type { AuthUser } from '../../platform/auth/current-user.decorator.js';

type Role = AuthUser['role'];

/** Cualquier miembro del negocio: puede vender y consultar. */
export const ANY_MEMBER: Role[] = ['owner', 'admin', 'cashier'];
/** Solo dueños y administradores: catálogo, anulaciones, reportes. */
export const MANAGERS: Role[] = ['owner', 'admin'];
