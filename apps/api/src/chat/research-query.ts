import { z } from 'zod';
export const webUrlInputSchema = z.object({ url: z.string().url().max(2048) }).strict();

// A short, standalone user message can already serve as a discovery query.
export function initialSearchQuery(text: string): string | undefined {
  const query = text
    .normalize('NFKC')
    .trim()
    .replace(/[?？]$/u, '')
    .trim();
  if (!/^[\p{L}\p{N}\p{M}\- ]{2,36}$/u.test(query)) return undefined;
  if (query.split(/\s+/u).length > 4 || (query.match(/\p{Script=Han}/gu)?.length ?? 0) > 12)
    return undefined;
  return query.replace(/ +/g, ' ');
}
