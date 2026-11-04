import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RegisterDto } from '../auth/auth.dto';
import { UserRole, UserStatus } from '../generated/prisma/client';

function trim(params: TransformFnParams): unknown {
  const value: unknown = params.value;
  return typeof value === 'string' ? value.trim() : value;
}

function email(params: TransformFnParams): unknown {
  const value = trim(params);
  return typeof value === 'string' ? value.toLowerCase() : value;
}

export class ListUsersDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 10;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

export class CreateUserDto extends RegisterDto {
  @IsEnum(UserRole)
  role: UserRole = UserRole.USER;
}

export class UpdateUserDto {
  @IsISO8601({ strict: true })
  updatedAt!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name!: string;

  @Transform(email)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  @IsEnum(UserStatus)
  status!: UserStatus;
}
