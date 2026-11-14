import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiPaymentRequiredResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../../platform/auth/current-user.decorator.js';
import { Roles } from '../../platform/auth/roles.decorator.js';
import { TenantDb } from '../../platform/db/tenant-db.service.js';
import { ANY_MEMBER, MANAGERS } from '../common/roles.js';
import { idParamSchema } from '../common/schemas.js';
import {
  invoiceDetailResponse,
  invoiceResponse,
  pageOf,
} from '../common/responses.js';
import {
  createInvoiceSchema,
  listInvoicesSchema,
  replaceInvoiceSchema,
  voidInvoiceSchema,
  type CreateInvoiceBody,
  type ListInvoicesQuery,
  type ReplaceInvoiceBody,
  type VoidInvoiceBody,
} from './invoices.schemas.js';
import { InvoicesService } from './invoices.service.js';

type IdParam = { id: string };

/** El cajero vende (crea, edita borradores, emite); solo owner/admin anulan. */
@ApiTags('invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly db: TenantDb,
    private readonly invoices: InvoicesService,
  ) {}

  @Get()
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: pageOf(invoiceResponse) })
  list(@Query({ schema: listInvoicesSchema }) query: ListInvoicesQuery) {
    return this.db.run((trx) => this.invoices.list(trx, query));
  }

  @Get(':id')
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: invoiceDetailResponse })
  get(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.invoices.get(trx, id));
  }

  @Post()
  @Roles(...ANY_MEMBER)
  @ApiCreatedResponse({ standardSchema: invoiceDetailResponse })
  @ApiPaymentRequiredResponse({
    description:
      'El plan no permite más emisiones este mes (code = PLAN_LIMIT_INVOICES)',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body({ schema: createInvoiceSchema }) body: CreateInvoiceBody,
  ) {
    return this.db.run((trx) => this.invoices.create(trx, user.userId, body));
  }

  @Put(':id')
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: invoiceDetailResponse })
  replace(
    @Param({ schema: idParamSchema }) { id }: IdParam,
    @Body({ schema: replaceInvoiceSchema }) body: ReplaceInvoiceBody,
  ) {
    return this.db.run((trx) => this.invoices.replace(trx, id, body));
  }

  @Delete(':id')
  @Roles(...ANY_MEMBER)
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.invoices.deleteDraft(trx, id));
  }

  @Post(':id/issue')
  @Roles(...ANY_MEMBER)
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: invoiceDetailResponse })
  @ApiPaymentRequiredResponse({
    description:
      'El plan no permite más emisiones este mes (code = PLAN_LIMIT_INVOICES)',
  })
  issue(
    @CurrentUser() user: AuthUser,
    @Param({ schema: idParamSchema }) { id }: IdParam,
  ) {
    return this.db.run((trx) => this.invoices.issue(trx, user.userId, id));
  }

  @Post(':id/void')
  @Roles(...MANAGERS)
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: invoiceDetailResponse })
  void(
    @CurrentUser() user: AuthUser,
    @Param({ schema: idParamSchema }) { id }: IdParam,
    @Body({ schema: voidInvoiceSchema }) body: VoidInvoiceBody,
  ) {
    return this.db.run((trx) =>
      this.invoices.void(trx, user.userId, id, body.reason),
    );
  }
}
