import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ChatImageSchema } from '@repo/contracts';
import type { ChatImage } from '@repo/contracts';
import { z } from 'zod';

export const resourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(255),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/json']),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  backend: z.literal('local'),
  key: z.string().regex(/^[a-f0-9-]{36}\.(png|jpeg|webp|json)$/),
  createdAt: z.string().datetime(),
});
export type ChatResource = z.output<typeof resourceSchema>;

@Injectable()
export class ChatStorageService {
  readonly root = resolve(process.env['CHAT_STORAGE_ROOT'] || '.chat-storage');

  directory(userId: string, historyId: string) {
    z.string().uuid().parse(userId);
    z.string().uuid().parse(historyId);
    return join(this.root, userId, historyId);
  }

  async save(
    userId: string,
    historyId: string,
    name: string,
    mime: ChatResource['mime'],
    data: Buffer,
  ) {
    if (data.length > 8 * 1024 * 1024) throw new Error('聊天资源超过存储上限');
    const id = randomUUID();
    const extension = mime === 'application/json' ? 'json' : mime.slice(6);
    const key = `${id}.${extension}`;
    const directory = this.directory(userId, historyId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${key}.tmp`);
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(directory, key));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return resourceSchema.parse({
      id,
      name,
      mime,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      backend: 'local',
      key,
      createdAt: new Date().toISOString(),
    });
  }

  async images(userId: string, historyId: string, images: ChatImage[]) {
    const resources: ChatResource[] = [];
    for (const input of images) {
      const image = ChatImageSchema.parse(input);
      const [prefix, base64] = image.dataUrl.split(',');
      const mime = resourceSchema.shape.mime.parse(prefix?.slice(5).split(';')[0]);
      resources.push(
        await this.save(userId, historyId, image.name, mime, Buffer.from(base64!, 'base64')),
      );
    }
    return resources;
  }

  async read(userId: string, historyId: string, descriptor: unknown) {
    const resource = resourceSchema.parse(descriptor);
    let data: Buffer;
    try {
      data = await readFile(join(this.directory(userId, historyId), resource.key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new NotFoundException('资源文件不存在');
      throw error;
    }
    if (
      data.length !== resource.bytes ||
      createHash('sha256').update(data).digest('hex') !== resource.sha256
    )
      throw new Error('资源文件校验失败');
    return { resource, data };
  }

  async remove(userId: string, historyId: string) {
    await rm(this.directory(userId, historyId), { recursive: true, force: true });
  }
}
