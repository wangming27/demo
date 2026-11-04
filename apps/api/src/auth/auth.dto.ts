import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

function normalizeEmail(params: TransformFnParams): unknown {
  const value: unknown = params.value;
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function trimName(params: TransformFnParams): unknown {
  const value: unknown = params.value;
  return typeof value === 'string' ? value.trim() : value;
}

class EmailDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  @MaxLength(254)
  email!: string;
}

export class CredentialsDto extends EmailDto {
  @IsString()
  @Length(1, 128, { message: '请输入密码，最多 128 个字符' })
  password!: string;
}

export class RegisterDto extends EmailDto {
  @IsString()
  @Length(12, 128, { message: '密码长度必须为 12–128 个字符' })
  password!: string;

  @Transform(trimName)
  @IsString()
  @Length(1, 80, { message: '昵称长度必须为 1–80 个字符' })
  name!: string;
}
