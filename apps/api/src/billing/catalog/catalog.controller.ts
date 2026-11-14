import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { Roles } from '../../platform/auth/roles.decorator.js';
import { TenantDb } from '../../platform/db/tenant-db.service.js';
import { ANY_MEMBER, MANAGERS } from '../common/roles.js';
import { idParamSchema } from '../common/schemas.js';
import {
  categoryResponse,
  pageOf,
  productResponse,
} from '../common/responses.js';
import {
  categoryBodySchema,
  createProductSchema,
  listCategoriesSchema,
  listProductsSchema,
  updateProductSchema,
  type CategoryBody,
  type CreateProductBody,
  type ListCategoriesQuery,
  type ListProductsQuery,
  type UpdateProductBody,
} from './catalog.schemas.js';
import { CatalogService } from './catalog.service.js';

type IdParam = { id: string };

/** Todos pueden consultar el catálogo; solo owner/admin lo editan. */
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly db: TenantDb,
    private readonly catalog: CatalogService,
  ) {}

  @Get()
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: pageOf(categoryResponse) })
  list(@Query({ schema: listCategoriesSchema }) query: ListCategoriesQuery) {
    return this.db.run((trx) => this.catalog.listCategories(trx, query));
  }

  @Post()
  @Roles(...MANAGERS)
  @ApiCreatedResponse({ standardSchema: categoryResponse })
  create(@Body({ schema: categoryBodySchema }) body: CategoryBody) {
    return this.db.run((trx) => this.catalog.createCategory(trx, body));
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOkResponse({ standardSchema: categoryResponse })
  update(
    @Param({ schema: idParamSchema }) { id }: IdParam,
    @Body({ schema: categoryBodySchema }) body: CategoryBody,
  ) {
    return this.db.run((trx) => this.catalog.updateCategory(trx, id, body));
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.catalog.deleteCategory(trx, id));
  }
}

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly db: TenantDb,
    private readonly catalog: CatalogService,
  ) {}

  @Get()
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: pageOf(productResponse) })
  list(@Query({ schema: listProductsSchema }) query: ListProductsQuery) {
    return this.db.run((trx) => this.catalog.listProducts(trx, query));
  }

  @Get(':id')
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: productResponse })
  get(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.catalog.getProduct(trx, id));
  }

  @Post()
  @Roles(...MANAGERS)
  @ApiCreatedResponse({ standardSchema: productResponse })
  create(@Body({ schema: createProductSchema }) body: CreateProductBody) {
    return this.db.run((trx) => this.catalog.createProduct(trx, body));
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOkResponse({ standardSchema: productResponse })
  update(
    @Param({ schema: idParamSchema }) { id }: IdParam,
    @Body({ schema: updateProductSchema }) body: UpdateProductBody,
  ) {
    return this.db.run((trx) => this.catalog.updateProduct(trx, id, body));
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.catalog.deleteProduct(trx, id));
  }
}
