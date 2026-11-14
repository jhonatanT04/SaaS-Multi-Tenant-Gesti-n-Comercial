import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto por request. El middleware abre el store vacío y el guard JWT lo
 * completa con el tenant del token; `TenantDb.run` lo lee de aquí.
 */
export interface TenantStore {
  tenantId?: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

export const tenantContext = {
  /** Ejecuta `fn` con un store nuevo (un request, un job, un test). */
  run<T>(store: TenantStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  /** Fija el tenant del request en curso. Lanza si no hay contexto abierto. */
  setTenantId(tenantId: string): void {
    const store = storage.getStore();
    if (!store) throw new Error('No hay contexto de request para fijar el tenant');
    store.tenantId = tenantId;
  },
  getTenantId(): string | undefined {
    return storage.getStore()?.tenantId;
  },
};
