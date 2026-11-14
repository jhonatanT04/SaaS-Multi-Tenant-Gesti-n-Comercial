import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'platform:public';

/** Exime la ruta (o el controlador) del guard JWT global. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
