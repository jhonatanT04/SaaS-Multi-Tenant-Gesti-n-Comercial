import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../../platform/auth/current-user.decorator.js';
import { Roles } from '../../platform/auth/roles.decorator.js';
import { TenantDb } from '../../platform/db/tenant-db.service.js';
import { ANY_MEMBER, MANAGERS } from '../common/roles.js';
import { idParamSchema } from '../common/schemas.js';
import { paymentResponse } from '../common/responses.js';
import {
  createPaymentSchema,
  type CreatePaymentBody,
} from './payments.schemas.js';
import { PaymentsService } from './payments.service.js';

type IdParam = { id: string };

/** El cajero cobra; solo owner/admin eliminan (reversan) un pago. */
@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly db: TenantDb,
    private readonly payments: PaymentsService,
  ) {}

  @Get('invoices/:id/payments')
  @Roles(...ANY_MEMBER)
  @ApiOkResponse({ standardSchema: paymentResponse.array() })
  list(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.payments.listForInvoice(trx, id));
  }

  @Post('invoices/:id/payments')
  @Roles(...ANY_MEMBER)
  @ApiCreatedResponse({ standardSchema: paymentResponse })
  create(
    @CurrentUser() user: AuthUser,
    @Param({ schema: idParamSchema }) { id }: IdParam,
    @Body({ schema: createPaymentSchema }) body: CreatePaymentBody,
  ) {
    return this.db.run((trx) =>
      this.payments.create(trx, user.userId, id, body),
    );
  }

  @Delete('payments/:id')
  @Roles(...MANAGERS)
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@Param({ schema: idParamSchema }) { id }: IdParam) {
    return this.db.run((trx) => this.payments.delete(trx, id));
  }
}
