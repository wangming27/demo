import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { load } from 'cheerio';
import { decode, encodingExists } from 'iconv-lite';
import type { ChatWebRequest } from '@repo/contracts';

const requestHeaders = Object.freeze({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Connection: 'keep-alive',
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function publicWebRequest(url: URL): ChatWebRequest {
  const headers = { ...requestHeaders };
  return {
    requestedAt: new Date().toISOString(),
    method: 'GET',
    url: url.href,
    headers,
    curl: [
      "curl --http1.1 --noproxy '*' --request GET --max-time 12 --compressed",
      ...Object.entries(headers).map(
        ([name, value]) => `--header ${shellQuote(`${name}: ${value}`)}`,
      ),
      `--url ${shellQuote(url.href)}`,
    ].join(' \\\n  '),
  };
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const publicIpv6 = new BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && publicIpv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicWebUrl(value: string, base?: URL): URL {
  const url = new URL(value, base);
  const address = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > 2048 ||
    (url.port && !['80', '443'].includes(url.port)) ||
    (isIP(address) && !isPublicAddress(address)) ||
    /(^|\.)localhost$|\.local$|\.internal$/i.test(address)
  )
    throw new Error('不允许访问该网页地址');
  url.hash = '';
  return url;
}

export interface WebPage {
  url: string;
  html: string;
}

// Validate every redirect and pin DNS to public addresses before opening a socket.
export async function readPublicPage(
  url: URL,
  signal: AbortSignal,
  onRequest?: (request: ChatWebRequest) => void,
): Promise<WebPage> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  let current = publicWebUrl(url.href);
  for (let redirects = 0; redirects <= 4; redirects++) {
    bounded.throwIfAborted();
    if (onRequest) {
      try {
        onRequest(publicWebRequest(current));
      } catch {
        // Request diagnostics cannot change transport headers or stop a web request.
      }
    }
    const response = await new Promise<{ html?: string; location?: string }>((resolve, reject) => {
      const request = (current.protocol === 'https:' ? httpsRequest : httpRequest)(
        current,
        {
          signal: bounded,
          headers: requestHeaders,
          lookup: (hostname, options, callback) => {
            lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
              if (error) return callback(error, []);
              if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
                return callback(new Error('不允许访问内网地址'), []);
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            });
          },
        },
        (incoming) => {
          incoming.on('error', reject);
          const status = incoming.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            incoming.destroy();
            if (!incoming.headers.location) reject(new Error('网页重定向缺少地址'));
            else resolve({ location: incoming.headers.location });
            return;
          }
          if (status < 200 || status >= 300) {
            incoming.destroy();
            reject(new Error(`网页请求失败（HTTP ${status}）`));
            return;
          }
          const contentType = incoming.headers['content-type'] ?? '';
          if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
            incoming.destroy();
            reject(new Error('网页不是 HTML，无法读取正文'));
            return;
          }
          const encoding = incoming.headers['content-encoding'];
          const decompressor =
            encoding === 'gzip'
              ? createGunzip()
              : encoding === 'br'
                ? createBrotliDecompress()
                : encoding === 'deflate'
                  ? createInflate()
                  : undefined;
          if (encoding && encoding !== 'identity' && !decompressor) {
            incoming.destroy();
            reject(new Error('不支持该网页压缩格式'));
            return;
          }
          const body = decompressor ? incoming.pipe(decompressor) : incoming;
          const chunks: Buffer[] = [];
          let bytes = 0;
          let wireBytes = 0;
          incoming.on('data', (chunk: Buffer) => {
            wireBytes += chunk.length;
            if (wireBytes > 2 * 1024 * 1024) request.destroy(new Error('网页过大'));
          });
          body.on('error', (error) => {
            request.destroy();
            reject(error);
          });
          request.on('error', () => decompressor?.destroy());
          body.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) {
              request.destroy(new Error('网页过大'));
              decompressor?.destroy();
              return;
            }
            chunks.push(chunk);
          });
          body.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const meta = buffer.subarray(0, 8192).toString('ascii');
            const charset =
              /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ??
              /<meta\b[^>]*charset\s*=\s*["']?\s*([\w-]+)/i.exec(meta)?.[1] ??
              'utf-8';
            if (!encodingExists(charset)) reject(new Error('不支持该网页字符编码'));
            else resolve({ html: decode(buffer, charset) });
          });
        },
      );
      request.on('error', reject);
      request.end();
    });
    if (response.location) {
      current = publicWebUrl(response.location, current);
      continue;
    }
    return { url: current.href, html: response.html ?? '' };
  }
  throw new Error('网页重定向次数过多');
}

export function pageContent(html: string): { title: string; content: string; truncated: boolean } {
  const $ = load(html);
  const title = $('title').first().text().trim().slice(0, 300);
  if (
    $('#b_captcha, #captcha, .g-recaptcha, #challenge-form').length ||
    /^(Just a moment|Access Denied|人机验证|安全验证|验证码)/i.test(title)
  )
    throw new Error('网页要求验证，无法读取正文');
  $(
    'script, style, noscript, svg, iframe, nav, footer, form, [hidden], [aria-hidden="true"]',
  ).remove();
  // Preserve article headers: they often contain the headline and publication date.
  $('header').each((_index, element) => {
    if (!$(element).parents('article, main, [role="main"]').length) $(element).remove();
  });
  const main = $('article, main, [role="main"]').first();
  const root = main.length && main.text().trim().length >= 100 ? main : $('body');
  root.find('p, div, section, article, h1, h2, h3, h4, li, tr, br').each((_index, element) => {
    $(element).append('\n');
  });
  const content = root
    .text()
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  if (content.length < 80) throw new Error('网页正文不足，可能需要 JavaScript 或登录');
  return { title, content: content.slice(0, 12_000), truncated: content.length > 12_000 };
}
