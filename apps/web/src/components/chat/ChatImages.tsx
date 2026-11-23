import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@douyinfe/semi-ui';
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGES_PER_MESSAGE, ChatImageSchema } from '@repo/contracts';
import type { ChatImage } from '@repo/contracts';
import Icon from '../common/Icon';

async function readImage(file: File): Promise<ChatImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > CHAT_IMAGE_MAX_BYTES) throw new Error(`${file.name} 超过 2 MB`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('图片读取失败，请重新选择'));
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择'));
    reader.onabort = () => reject(new Error('图片读取已取消'));
    reader.readAsDataURL(file);
  });
  const parsed = ChatImageSchema.safeParse({ name: file.name.slice(0, 255), dataUrl });
  if (!parsed.success) throw new Error(`${file.name} 不是有效的 PNG、JPEG 或 WebP 图片`);
  return parsed.data;
}

export function ImagePreviews({ images }: { images: ChatImage[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {images.map((image, index) => (
        <img
          key={index}
          src={image.dataUrl}
          alt={image.name}
          className="max-h-64 max-w-full rounded-lg border border-line object-contain"
        />
      ))}
    </div>
  );
}

export default function ChatImages({
  images,
  disabled,
  onChange,
  onError,
  onBusyChange,
  children,
}: {
  images: ChatImage[];
  disabled: boolean;
  onChange: (images: ChatImage[]) => void;
  onError: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function select(files: File[]) {
    if (!files.length || busy || disabled) return;
    if (images.length + files.length > CHAT_IMAGES_PER_MESSAGE) {
      onError('每条消息最多添加 4 张图片');
      return;
    }
    setBusy(true);
    onBusyChange(true);
    onError('');
    try {
      const next: ChatImage[] = [];
      for (const file of files) next.push(await readImage(file));
      onChange([...images, ...next]);
    } catch (error) {
      onError(error instanceof Error ? error.message : '图片读取失败');
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <div className="mt-3 space-y-2">
      {!!images.length && (
        <div className="flex flex-wrap gap-3" aria-label="待发送图片">
          {images.map((image, index) => (
            <div key={index} className="relative w-24 rounded-lg border border-line p-1">
              <img
                src={image.dataUrl}
                alt={image.name}
                className="h-20 w-full rounded object-contain"
              />
              <p className="mt-1 truncate text-xs text-muted" title={image.name}>
                {image.name}
              </p>
              <Button
                className="absolute -right-2 -top-2"
                size="small"
                theme="solid"
                type="tertiary"
                icon={<Icon name="close" />}
                aria-label={`移除图片 ${image.name}`}
                disabled={disabled || busy}
                onClick={() => onChange(images.filter((_image, itemIndex) => itemIndex !== index))}
              />
            </div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        aria-label="选择图片"
        className="sr-only"
        disabled={disabled || busy || images.length >= CHAT_IMAGES_PER_MESSAGE}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void select(files);
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          size="small"
          theme="borderless"
          icon={<Icon name="image" />}
          aria-label="添加图片"
          loading={busy}
          disabled={disabled || busy || images.length >= CHAT_IMAGES_PER_MESSAGE}
          onClick={() => inputRef.current?.click()}
        />
        {children}
      </div>
    </div>
  );
}
