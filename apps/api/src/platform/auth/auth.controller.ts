import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import {
  type AcceptInvitationDto,
  acceptInvitationSchema,
  type LoginDto,
  loginSchema,
  type RefreshDto,
  refreshSchema,
  type RegisterDto,
  registerSchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { type AuthUser, CurrentUser } from './current-user.decorator.js';
import { Public } from './public.decorator.js';

@ApiTags('auth')
@Controller('auth')
// Limita por IP las rutas públicas (login, registro, refresh, logout, invitaciones).
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Alta self-service: crea la organización y su usuario owner. */
  @Public()
  @Post('register')
  register(@Body({ schema: registerSchema }) dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body({ schema: loginSchema }) dto: LoginDto) {
    return this.auth.login(dto);
  }

  /** Rota el refresh token y devuelve un par nuevo. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body({ schema: refreshSchema }) dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body({ schema: refreshSchema }) dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  /** Acepta una invitación a una organización (crea la cuenta si no existe). */
  @Public()
  @Post('invitations/accept')
  @HttpCode(200)
  acceptInvitation(@Body({ schema: acceptInvitationSchema }) dto: AcceptInvitationDto) {
    return this.auth.acceptInvitation(dto);
  }

  @SkipThrottle()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
