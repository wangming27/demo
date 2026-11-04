import { ConflictException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { CredentialsDto, RegisterDto } from './auth.dto';
import { PublicUser } from './auth.types';
import { createToken, hashToken, SESSION_DURATION_MS } from './session';

const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const passwordOptions = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyPasswordHash = '';

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Unknown accounts still perform password verification.
    this.dummyPasswordHash = await hash(createToken(), passwordOptions);
  }

  async register(
    input: RegisterDto,
    previousToken: string | undefined,
  ): Promise<{ user: PublicUser; token: string }> {
    const passwordHash = await hash(input.password, passwordOptions);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: { email: input.email, name: input.name, passwordHash },
          select: publicUserSelect,
        });
        const token = await this.createSession(transaction, user.id, previousToken);
        return { user, token };
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该邮箱已注册');
      }
      throw error;
    }
  }

  async login(
    input: CredentialsDto,
    previousToken: string | undefined,
  ): Promise<{ user: PublicUser; token: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { ...publicUserSelect, passwordHash: true, status: true },
    });
    const valid = await verify(user?.passwordHash ?? this.dummyPasswordHash, input.password);
    if (!user || !valid || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    const token = await this.prisma.$transaction((transaction) =>
      this.createSession(transaction, user.id, previousToken),
    );
    return {
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
      token,
    };
  }

  async currentUser(token: string | undefined): Promise<PublicUser> {
    if (!token) {
      throw new UnauthorizedException('请先登录');
    }
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        expiresAt: true,
        user: { select: { ...publicUserSelect, status: true } },
      },
    });
    if (!session || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }
    const { id, email, name, createdAt } = session.user;
    return { id, email, name, createdAt };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) {
      await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
  }

  private async createSession(
    transaction: Prisma.TransactionClient,
    userId: string,
    previousToken: string | undefined,
  ): Promise<string> {
    if (previousToken) {
      await transaction.session.deleteMany({
        where: { tokenHash: hashToken(previousToken) },
      });
    }
    const token = createToken();
    await transaction.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
      },
    });
    return token;
  }
}
