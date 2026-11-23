import { request } from 'node:http';
import type { ChatCompletionResponse } from '@repo/contracts';
import { z } from 'zod';

const capacity = z.number().int().positive().max(2_147_483_647);
const loadedModels = z.object({
  models: z.array(
    z.object({
      name: z.string().optional(),
      model: z.string().optional(),
      context_length: capacity.optional(),
    }),
  ),
});
const modelInfo = z.object({ model_info: z.record(z.unknown()) });
type ContextUsage = NonNullable<ChatCompletionResponse['contextUsage']>;

// Only the known local Ollama endpoint is probed. No redirects, DNS resolution,
// remote-provider assumptions or model-name-based guesses are involved.
export function localOllamaOrigin(baseUrl: string): URL | undefined {
  const url = new URL(baseUrl);
  if (
    process.env['NODE_ENV'] === 'production' ||
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.port !== '11434' ||
    !['/v1', '/v1/chat/completions'].includes(url.pathname.replace(/\/+$/, ''))
  )
    return undefined;
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return new URL(url.origin);
}

async function metadata(
  origin: URL,
  path: string,
  apiKey: string,
  signal: AbortSignal,
  model?: string,
): Promise<unknown> {
  signal.throwIfAborted();
  const payload = model ? JSON.stringify({ model }) : undefined;
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, origin),
      {
        method: payload ? 'POST' : 'GET',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('Metadata unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) req.destroy(new Error('Metadata too large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Invalid metadata JSON'));
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('Metadata timed out')), 1500);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function resolveContextWindow(
  model: { baseUrl: string; model: string; apiKey: string; contextWindow?: number | null },
  signal: AbortSignal,
): Promise<ContextUsage> {
  signal.throwIfAborted();
  const origin = localOllamaOrigin(model.baseUrl);
  if (origin) {
    try {
      const parsed = loadedModels.safeParse(
        await metadata(origin, '/api/ps', model.apiKey, signal),
      );
      const loaded = parsed.success
        ? parsed.data.models.find((item) => item.name === model.model || item.model === model.model)
        : undefined;
      if (loaded?.context_length) return { windowTokens: loaded.context_length, source: 'runtime' };
    } catch {
      signal.throwIfAborted();
    }
  }
  if (model.contextWindow) return { windowTokens: model.contextWindow, source: 'configured' };
  if (origin) {
    try {
      const parsed = modelInfo.safeParse(
        await metadata(origin, '/api/show', model.apiKey, signal, model.model),
      );
      if (parsed.success) {
        const info = parsed.data.model_info;
        const architecture = info['general.architecture'];
        const declared = capacity.safeParse(
          typeof architecture === 'string' ? info[`${architecture}.context_length`] : undefined,
        );
        if (declared.success) return { windowTokens: declared.data, source: 'declared' };
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  signal.throwIfAborted();
  return { windowTokens: null, source: 'unknown' };
}
