import { Module } from '@nestjs/common';
import {
  CategoriesController,
  ProductsController,
} from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { CustomersController } from './customers/customers.controller.js';
import { CustomersService } from './customers/customers.service.js';
import { InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';

/**
 * Dominio de facturación: catálogo, clientes, comprobantes, pagos y reportes.
 * `TenantDb` llega del `DatabaseModule` global de la plataforma.
 */
@Module({
  controllers: [
    CategoriesController,
    ProductsController,
    CustomersController,
    InvoicesController,
    PaymentsController,
    ReportsController,
  ],
  providers: [
    CatalogService,
    CustomersService,
    InvoicesService,
    PaymentsService,
    ReportsService,
  ],
  exports: [
    CatalogService,
    CustomersService,
    InvoicesService,
    PaymentsService,
    ReportsService,
  ],
})
export class BillingModule {}
