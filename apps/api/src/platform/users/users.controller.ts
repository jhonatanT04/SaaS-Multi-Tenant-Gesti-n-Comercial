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
import { ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../auth/current-user.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import {
  type ChangeRoleDto,
  changeRoleSchema,
  idSchema,
  type InviteDto,
  inviteSchema,
  type ListQuery,
  listQuerySchema,
} from './users.schemas.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('users')
@Roles('owner', 'admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query({ schema: listQuerySchema }) query: ListQuery) {
    return this.users.list(query);
  }

  @Post('invitations')
  invite(@CurrentUser() actor: AuthUser, @Body({ schema: inviteSchema }) dto: InviteDto) {
    return this.users.invite(actor, dto);
  }

  @Get('invitations')
  listInvitations(@Query({ schema: listQuerySchema }) query: ListQuery) {
    return this.users.listInvitations(query);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  revokeInvitation(@Param('id', { schema: idSchema }) id: string): Promise<void> {
    return this.users.revokeInvitation(id);
  }

  @Patch(':userId/role')
  changeRole(
    @CurrentUser() actor: AuthUser,
    @Param('userId', { schema: idSchema }) userId: string,
    @Body({ schema: changeRoleSchema }) dto: ChangeRoleDto,
  ) {
    return this.users.changeRole(actor, userId, dto);
  }

  @Delete(':userId')
  @HttpCode(204)
  remove(@CurrentUser() actor: AuthUser, @Param('userId', { schema: idSchema }) userId: string): Promise<void> {
    return this.users.remove(actor, userId);
  }
}
