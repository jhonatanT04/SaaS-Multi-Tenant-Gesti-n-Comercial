import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Selectable, Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.js';
import type { CustomersTable, IdentificationType } from '../billing.tables.js';
import { rethrowPgError } from '../common/pg-errors.js';
import { offsetOf, toPage, type Page } from '../common/schemas.js';
import { likeContains } from '../common/sql.js';
import type {
  CreateCustomerBody,
  ListCustomersQuery,
  UpdateCustomerBody,
} from './customers.schemas.js';

export interface CustomerDto {
  id: string;
  name: string;
  identificationType: IdentificationType | null;
  identification: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CUSTOMER_ERRORS = {
  customers_tenant_identification_key:
    'Ya existe un cliente con esa identificación',
  customers_check: new BadRequestException(
    'identification e identificationType van juntos',
  ),
  invoices_tenant_id_customer_id_fkey:
    'El cliente tiene comprobantes y no se puede eliminar',
};

function toCustomer(row: Selectable<CustomersTable>): CustomerDto {
  return {
    id: row.id,
    name: row.name,
    identificationType: row.identification_type,
    identification: row.identification,
    email: row.email,
    phone: row.phone,
    address: row.address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class CustomersService {
  async list(
    trx: Transaction<DB>,
    query: ListCustomersQuery,
  ): Promise<Page<CustomerDto>> {
    let base = trx.selectFrom('customers');
    if (query.q) {
      const term = likeContains(query.q);
      base = base.where((eb) =>
        eb.or([eb('name', 'ilike', term), eb('identification', 'ilike', term)]),
      );
    }
    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy('name')
        .orderBy('id')
        .limit(query.pageSize)
        .offset(offsetOf(query))
        .execute(),
      base
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow(),
    ]);
    return toPage(rows.map(toCustomer), count.total, query);
  }

  async get(trx: Transaction<DB>, id: string): Promise<CustomerDto> {
    const row = await trx
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Cliente no encontrado');
    return toCustomer(row);
  }

  async create(
    trx: Transaction<DB>,
    body: CreateCustomerBody,
  ): Promise<CustomerDto> {
    const row = await trx
      .insertInto('customers')
      .values({
        name: body.name,
        identification_type: body.identificationType ?? null,
        identification: body.identification ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address: body.address ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((err) => rethrowPgError(err, CUSTOMER_ERRORS));
    return toCustomer(row);
  }

  /** No altera comprobantes ya emitidos: guardan su copia de nombre e identificación. */
  async update(
    trx: Transaction<DB>,
    id: string,
    body: UpdateCustomerBody,
  ): Promise<CustomerDto> {
    const row = await trx
      .updateTable('customers')
      .set({
        name: body.name,
        identification_type: body.identificationType,
        identification: body.identification,
        email: body.email,
        phone: body.phone,
        address: body.address,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
      .catch((err) => rethrowPgError(err, CUSTOMER_ERRORS));
    if (!row) throw new NotFoundException('Cliente no encontrado');
    return toCustomer(row);
  }

  async delete(trx: Transaction<DB>, id: string): Promise<void> {
    const result = await trx
      .deleteFrom('customers')
      .where('id', '=', id)
      .executeTakeFirst()
      .catch((err) => rethrowPgError(err, CUSTOMER_ERRORS));
    if (result.numDeletedRows === 0n)
      throw new NotFoundException('Cliente no encontrado');
  }
}
