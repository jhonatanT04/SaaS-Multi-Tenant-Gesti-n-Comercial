import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Selectable, Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.js';
import type { CategoriesTable, ProductsTable } from '../billing.tables.js';
import { rethrowPgError } from '../common/pg-errors.js';
import { offsetOf, toPage, type Page } from '../common/schemas.js';
import { likeContains } from '../common/sql.js';
import type {
  CategoryBody,
  CreateProductBody,
  ListCategoriesQuery,
  ListProductsQuery,
  UpdateProductBody,
} from './catalog.schemas.js';

export interface CategoryDto {
  id: string;
  name: string;
  createdAt: Date;
}

export interface ProductDto {
  id: string;
  categoryId: string | null;
  kind: 'product' | 'service';
  code: string | null;
  name: string;
  description: string | null;
  price: string;
  taxable: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CATEGORY_ERRORS = {
  categories_tenant_name_key: 'Ya existe una categoría con ese nombre',
};
const PRODUCT_ERRORS = {
  products_tenant_code_key: 'Ya existe un producto con ese código',
  invoice_items_tenant_id_product_id_fkey:
    'El producto ya tiene ventas y no se puede eliminar; desactívalo en su lugar',
};

function toCategory(row: Selectable<CategoriesTable>): CategoryDto {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

function toProduct(row: Selectable<ProductsTable>): ProductDto {
  return {
    id: row.id,
    categoryId: row.category_id,
    kind: row.kind,
    code: row.code,
    name: row.name,
    description: row.description,
    price: row.price,
    taxable: row.taxable,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Catálogo: categorías y productos/servicios. Todos los métodos reciben la
 * transacción de `TenantDb`, así que RLS ya limita las filas al tenant.
 */
@Injectable()
export class CatalogService {
  // ---- Categorías ----

  async listCategories(
    trx: Transaction<DB>,
    query: ListCategoriesQuery,
  ): Promise<Page<CategoryDto>> {
    let base = trx.selectFrom('categories');
    if (query.q) base = base.where('name', 'ilike', likeContains(query.q));
    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy('name')
        .limit(query.pageSize)
        .offset(offsetOf(query))
        .execute(),
      base
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow(),
    ]);
    return toPage(rows.map(toCategory), count.total, query);
  }

  async createCategory(
    trx: Transaction<DB>,
    body: CategoryBody,
  ): Promise<CategoryDto> {
    const row = await trx
      .insertInto('categories')
      .values({ name: body.name })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((err) => rethrowPgError(err, CATEGORY_ERRORS));
    return toCategory(row);
  }

  async updateCategory(
    trx: Transaction<DB>,
    id: string,
    body: CategoryBody,
  ): Promise<CategoryDto> {
    const row = await trx
      .updateTable('categories')
      .set({ name: body.name })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
      .catch((err) => rethrowPgError(err, CATEGORY_ERRORS));
    if (!row) throw new NotFoundException('Categoría no encontrada');
    return toCategory(row);
  }

  /** Los productos de la categoría quedan sin categoría (ON DELETE SET NULL). */
  async deleteCategory(trx: Transaction<DB>, id: string): Promise<void> {
    const result = await trx
      .deleteFrom('categories')
      .where('id', '=', id)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n)
      throw new NotFoundException('Categoría no encontrada');
  }

  // ---- Productos ----

  async listProducts(
    trx: Transaction<DB>,
    query: ListProductsQuery,
  ): Promise<Page<ProductDto>> {
    let base = trx.selectFrom('products');
    if (query.q) {
      const term = likeContains(query.q);
      base = base.where((eb) =>
        eb.or([eb('name', 'ilike', term), eb('code', 'ilike', term)]),
      );
    }
    if (query.categoryId)
      base = base.where('category_id', '=', query.categoryId);
    if (query.kind) base = base.where('kind', '=', query.kind);
    if (query.active !== undefined)
      base = base.where('active', '=', query.active);
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
    return toPage(rows.map(toProduct), count.total, query);
  }

  async getProduct(trx: Transaction<DB>, id: string): Promise<ProductDto> {
    const row = await trx
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Producto no encontrado');
    return toProduct(row);
  }

  async createProduct(
    trx: Transaction<DB>,
    body: CreateProductBody,
  ): Promise<ProductDto> {
    await this.assertCategory(trx, body.categoryId);
    const row = await trx
      .insertInto('products')
      .values({
        name: body.name,
        kind: body.kind,
        code: body.code ?? null,
        description: body.description ?? null,
        category_id: body.categoryId ?? null,
        price: body.price,
        taxable: body.taxable,
        active: body.active,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((err) => rethrowPgError(err, PRODUCT_ERRORS));
    return toProduct(row);
  }

  /** Cambiar nombre o precio no afecta comprobantes existentes: los ítems guardan su copia. */
  async updateProduct(
    trx: Transaction<DB>,
    id: string,
    body: UpdateProductBody,
  ): Promise<ProductDto> {
    await this.assertCategory(trx, body.categoryId);
    const row = await trx
      .updateTable('products')
      .set({
        name: body.name,
        kind: body.kind,
        code: body.code,
        description: body.description,
        category_id: body.categoryId,
        price: body.price,
        taxable: body.taxable,
        active: body.active,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
      .catch((err) => rethrowPgError(err, PRODUCT_ERRORS));
    if (!row) throw new NotFoundException('Producto no encontrado');
    return toProduct(row);
  }

  async deleteProduct(trx: Transaction<DB>, id: string): Promise<void> {
    const result = await trx
      .deleteFrom('products')
      .where('id', '=', id)
      .executeTakeFirst()
      .catch((err) => rethrowPgError(err, PRODUCT_ERRORS));
    if (result.numDeletedRows === 0n)
      throw new NotFoundException('Producto no encontrado');
  }

  private async assertCategory(
    trx: Transaction<DB>,
    categoryId: string | null | undefined,
  ) {
    if (!categoryId) return;
    const found = await trx
      .selectFrom('categories')
      .select('id')
      .where('id', '=', categoryId)
      .executeTakeFirst();
    if (!found)
      throw new BadRequestException('La categoría indicada no existe');
  }
}
