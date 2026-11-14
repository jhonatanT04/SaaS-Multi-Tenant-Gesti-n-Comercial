import { HttpException, HttpStatus } from '@nestjs/common';
import type { PlanCode } from '../db/schema.js';

export type PlanLimitCode = 'PLAN_LIMIT_INVOICES' | 'PLAN_LIMIT_USERS' | 'PLAN_UPGRADE_REQUIRED';

/**
 * El plan del tenant no permite la operación. HTTP 402 con un `code` estable
 * para que el cliente muestre la pantalla "mejorar plan":
 * `{ statusCode: 402, error: 'Payment Required', code, message, plan, limit?, used? }`.
 */
export class PlanLimitException extends HttpException {
  constructor(
    readonly code: PlanLimitCode,
    message: string,
    details: { plan: PlanCode; limit?: number; used?: number; requiredPlans?: PlanCode[] },
  ) {
    super(
      { statusCode: HttpStatus.PAYMENT_REQUIRED, error: 'Payment Required', code, message, ...details },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
