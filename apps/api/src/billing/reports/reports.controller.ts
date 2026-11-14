import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../platform/auth/roles.decorator.js';
import { TenantDb } from '../../platform/db/tenant-db.service.js';
import { MANAGERS } from '../common/roles.js';
import {
  paymentMethodsResponse,
  salesSummaryResponse,
  topProductsResponse,
} from '../common/responses.js';
import {
  paymentMethodsQuerySchema,
  summaryQuerySchema,
  topProductsQuerySchema,
  type PaymentMethodsQuery,
  type SummaryQuery,
  type TopProductsQuery,
} from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

/** Reportes del dashboard: solo owner/admin. */
@ApiTags('reports')
@Controller('reports')
@Roles(...MANAGERS)
export class ReportsController {
  constructor(
    private readonly db: TenantDb,
    private readonly reports: ReportsService,
  ) {}

  /** Ventas de hoy, del mes y comparación con el mes anterior. */
  @Get('sales-summary')
  @ApiOkResponse({ standardSchema: salesSummaryResponse })
  summary(@Query({ schema: summaryQuerySchema }) query: SummaryQuery) {
    return this.db.run((trx) => this.reports.summary(trx, query));
  }

  @Get('top-products')
  @ApiOkResponse({ standardSchema: topProductsResponse })
  topProducts(
    @Query({ schema: topProductsQuerySchema }) query: TopProductsQuery,
  ) {
    return this.db.run((trx) => this.reports.topProducts(trx, query));
  }

  @Get('payment-methods')
  @ApiOkResponse({ standardSchema: paymentMethodsResponse })
  paymentMethods(
    @Query({ schema: paymentMethodsQuerySchema }) query: PaymentMethodsQuery,
  ) {
    return this.db.run((trx) => this.reports.paymentMethods(trx, query));
  }
}
