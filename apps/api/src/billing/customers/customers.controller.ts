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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../platform/auth/roles.decorator.js';
import { TenantDb } from '../../platform/db/tenant-db.service.js';
import { ANY_MEMBER, MANAGERS } from '../common/roles.js';
import { idParamSchema } from '../common/schemas.js';
import { customerResponse, pageOf } from '../common/responses.js';
import {
  createCustomerSchema,
  listCustomersSchema,
  updateCustomerSchema,
  type CreateCustomerBody,
  type ListCustomersQuery,
  type UpdateCustomerBody,
} from './customers.schemas.js';
import { CustomersService } from './customers.service.js';

type IdParam = { id: string };

/** El cajero registra y corrige clientes al vender; solo owner/admin los eliminan. */
@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly db: TenantDb,
    private readonly customers: CustomersService,
  ) {}

  @Get()
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: pageOf(customerResponse) })
  list(@Query({ schema: listCustomersSchema }) query: ListCustomersQuery) {
    return this.db.run((trx) => this.customers.list(trx, query));
  }

  @Get(':id')
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: customerResponse })
  get(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.customers.get(trx, id));
  }

  @Post()
  @Roles(...ANY_MEMBER)
  @ApiCreatedResponse({ standardSchema: customerResponse })
  create(@Body({ schema: createCustomerSchema }) body: CreateCustomerBody) {
    return this.db.run((trx) => this.customers.create(trx, body));
  }

  @Patch(':id')
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: customerResponse })
  update(
    @Param({ schema: idParamSchema }) { id }: IdParam,
    @Body({ schema: updateCustomerSchema }) body: UpdateCustomerBody,
  ) {
    return this.db.run((trx) => this.customers.update(trx, id, body));
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.customers.delete(trx, id));
  }
}
