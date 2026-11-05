import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isDriverAdapterError } from '@prisma/driver-adapter-utils';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { CreateUserInput, ListUsersInput, UserUpdate } from '@repo/contracts';

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: ListUsersInput) {
    const where: Prisma.UserWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.search
        ? {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' } },
              { email: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.prisma.$transaction(
      async (transaction) => {
        const total = await transaction.user.count({ where });
        const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)));
        const items = await transaction.user.findMany({
          where,
          select: userSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * input.pageSize,
          take: input.pageSize,
        });
        const all = await transaction.user.count();
        const active = await transaction.user.count({ where: { status: 'ACTIVE' } });
        return {
          items,
          total,
          page,
          pageSize: input.pageSize,
          stats: { total: all, active, disabled: all - active },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!user) throw new NotFoundException('用户不存在');
    return { user };
  }

  async create(actorId: string, input: CreateUserInput) {
    const passwordHash = await hashPassword(input.password);
    return this.write(async (transaction) => {
      await this.assertAdmin(transaction, actorId);
      const user = await transaction.user.create({
        data: { name: input.name, email: input.email, passwordHash, role: input.role },
        select: userSelect,
      });
      return { user };
    });
  }

  async update(actorId: string, id: string, input: UserUpdate) {
    return this.write(async (transaction) => {
      await this.assertAdmin(transaction, actorId);
      const current = await transaction.user.findUnique({ where: { id }, select: userSelect });
      if (!current) throw new NotFoundException('用户不存在');
      if (current.updatedAt.getTime() !== Date.parse(input.updatedAt)) {
        throw new ConflictException('用户信息已发生变化，请刷新列表后重试');
      }
      if (actorId === id && (input.status !== 'ACTIVE' || input.role !== 'ADMIN')) {
        throw new ConflictException('不能停用自己或移除自己的管理员权限');
      }
      if (
        current.role === 'ADMIN' &&
        current.status === 'ACTIVE' &&
        (input.role !== 'ADMIN' || input.status !== 'ACTIVE')
      ) {
        const admins = await transaction.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
        if (admins <= 1) throw new ConflictException('至少需要保留一位启用的管理员');
      }
      const user = await transaction.user.update({
        where: { id },
        data: { name: input.name, email: input.email, role: input.role, status: input.status },
        select: userSelect,
      });
      // Re-enabling a user never resurrects their previous sessions.
      if (
        input.status === 'DISABLED' ||
        current.role !== input.role ||
        current.email !== input.email
      ) {
        await transaction.session.deleteMany({ where: { userId: id } });
      }
      return { user };
    });
  }

  private async assertAdmin(transaction: Prisma.TransactionClient, actorId: string) {
    const actor = await transaction.user.findUnique({
      where: { id: actorId },
      select: { role: true, status: true },
    });
    if (actor?.role !== 'ADMIN' || actor.status !== 'ACTIVE') {
      throw new ForbiddenException('管理员权限已失效，请重新登录');
    }
  }

  private async write<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === 'P2002') throw new ConflictException('该邮箱已注册');
        }
        const writeConflict =
          (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') ||
          (isDriverAdapterError(error) && error.cause.kind === 'TransactionWriteConflict');
        if (writeConflict) {
          if (attempt < 2) continue;
          throw new ConflictException('账号信息正在被修改，请刷新后重试');
        }
        throw error;
      }
    }
    throw new ConflictException('操作冲突，请重试');
  }
}
