import { NextResponse } from 'next/server';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkLiveUrlAllowed, isBlockedByDNS, isValidProxyUrl } from '@/lib/ssrf';
import { fetchWithSafeRedirects } from '@/lib/fetch-utils';
import { rewriteM3u8, LIVE_STREAM_BASE } from '@/lib/m3u8';

/**
 * 代理目标地址的两种传入形式：
 * - 路径段：/api/proxy/<encodeURIComponent(url)>（旧形式，保持兼容）；
 * - 查询串：/api/proxy?url=<encodeURIComponent(url)>（新形式）。
 *
 * 路径形式在 EdgeOne 等会做 URL 归一化的网关上有致命缺陷：路径里的 %2F
 * 会在路由匹配前被解码成 /，多段路径令单段动态路由 [url] 匹配失败（404）。
 * 查询串不参与路径归一化，全平台行为一致；路由同时支持两种形式，
 * 旧地址（缓存页 / 已下发的播放列表）不受影响。
 */

const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT || '8000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '1', 10);
const HEADER_TIMEOUT_MS = 15_000;
const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 代理诊断日志：记录每条分片请求的上游期望长度 / 实际转发字节 / 耗时 / 结束原因。
 * 播放卡顿时据此区分「上游 CDN 提前断流」与「本地转发中断」，比浏览器控制台只报
 * ERR_INCOMPLETE_CHUNKED_ENCODING 有用得多。写在 <cwd>/logs/proxy.log，超过 5MB 自动清空。
 */
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function proxyLog(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) writeFileSync(LOG_FILE, '');
    } catch {
      /* 文件还不存在 */
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志失败绝不影响代理本身 */
  }
}

/**
 * 精确域名匹配：仅 `douban.com` 本身及其子域放行。
 * 不能用 endsWith('douban.com')——那样 `evil-douban.com` 也会命中，形成鉴权绕过。
 */
function isDoubanHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'douban.com' || h.endsWith('.douban.com') ||
    h === 'doubanio.com' || h.endsWith('.doubanio.com')
  );
}

/**
 * 未登录即可代理的图片域白名单（精确后缀匹配，防 `evil-bgm.tv` 类绕过）：
 * 豆瓣封面需要 Referer 伪装；热榜 cover_proxy 镜像与 Bangumi 封面
 * 均为公开图片 CDN，无 Referer 校验，仅需防开放代理滥用。
 */
function isAnonymousImageHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    isDoubanHost(h) ||
    h === 'doubanio.viki.moe' || h.endsWith('.doubanio.viki.moe') ||
    h === 'bgm.tv' || h.endsWith('.bgm.tv')
  );
}

// 未鉴权的图片等资源也允许走代理（豆瓣防盗链需要 Referer 伪装）；
// 但为防止被当作开放代理滥用，仅放行上述公开图片域，其余必须已登录。
function looksLikeImageUrl(target: string): boolean {
  const host = (() => {
    try { return new URL(target).hostname; } catch { return ''; }
  })();
  return isAnonymousImageHost(host);
}

/** 解码路径段形式的代理目标（网关可能已把 %2F 解码为 /，失败时原样返回） */
export function decodePathTarget(encodedUrl: string): string {
  try { return decodeURIComponent(encodedUrl); } catch { return encodedUrl; }
}

/**
 * 通用流式代理（点播 / 图片）：
 * - 已登录会话（httpOnly cookie）→ m3u8 重写后的分片同源请求自动携带，不再有旧版丢鉴权参数的问题；
 * - 未登录仅放行图片目标（豆瓣封面等），且同样受 SSRF 防护约束；
 * - m3u8 文本重写为代理地址，分片/key/map 全部经本站转发，规避上游 CORS。
 */
/** 并行分块下载：低于该体积（字节）不值得多连接 */
const PARALLEL_MIN_BYTES = 400 * 1024;
/** 每片切成几块并行拉取。实测这类免费 CDN 按下限连接限速：1 路 90KB/s，3 路 143，6 路 227 */
const PARALLEL_CHUNKS = 6;

/**
 * 各源是否支持 Range 的探测结果缓存（10 分钟）。
 * 很多 CDN 实际支持 206，却不返回 `Accept-Ranges` 头，只能靠探针确认；
 * 缓存下来避免每个分片都多打一次探针。
 */
const rangeSupport = new Map<string, { ok: boolean; expiresAt: number }>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 取某个字节区间（含 Range 头），沿用同一套 SSRF 校验与 UA */
async function fetchByteRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number
): Promise<Response> {
  const result = await fetchWithSafeRedirects(
    url,
    { headers: { ...headers, Range: `bytes=${start}-${end}` } },
    { headerTimeoutMs: HEADER_TIMEOUT_MS }
  );
  return result.res;
}

/**
 * 把一个大分片切成 N 段并行下载，再按顺序拼成单条流返回。
 *
 * 免费采集站 CDN 普遍按「单连接」限速（实测单连接 90KB/s、6 路并发 227KB/s），
 * 串行下载会让一个 5 秒分片下成 10 秒以上，播放缓冲直接被抽干。
 * 返回 null 表示该源不支持 Range（或探针失败），调用方退回普通流式透传。
 */
async function buildParallelBody(
  url: string,
  headers: Record<string, string>,
  original: Response,
  total: number
): Promise<ReadableStream<Uint8Array> | null> {
  const host = hostOf(url);
  const cached = rangeSupport.get(host);
  const fresh = cached && cached.expiresAt > Date.now();

  if (fresh && !cached.ok) return null;

  // 缓存未命中（或已过期）：发一个 1 字节的 Range 探针，看是否返回 206
  if (!fresh) {
    const probe = await fetchByteRange(url, headers, 0, 0);
    const probeOk = probe.status === 206;
    await probe.body?.cancel().catch(() => {});
    rangeSupport.set(host, { ok: probeOk, expiresAt: Date.now() + 10 * 60 * 1000 });
    if (!probeOk) return null;
  }

  // 确认可用：原始整段响应用不上了，取消它释放连接
  await original.body?.cancel().catch(() => {});

  const chunkSize = Math.ceil(total / PARALLEL_CHUNKS);
  const jobs: Promise<Response>[] = [];
  for (let i = 0; i < PARALLEL_CHUNKS; i++) {
    const start = i * chunkSize;
    if (start >= total) break;
    const end = Math.min(total - 1, start + chunkSize - 1);
    // 六块同时发出，才能拿到并发带宽；按顺序读取保证字节序正确
    jobs.push(fetchByteRange(url, headers, start, end));
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const job of jobs) {
          const res = await job;
          if (!res.body) throw new Error(`分块请求失败 HTTP ${res.status}`);
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export async function handleProxyRequest(req: Request, targetUrl: string): Promise<Response> {
  const guarded = guardRequest(req);
  if (guarded && !looksLikeImageUrl(targetUrl)) return guarded;

  if (!isValidProxyUrl(targetUrl)) {
    return new NextResponse('无效的 URL', { status: 400 });
  }
  if (await isBlockedByDNS(targetUrl)) {
    return new NextResponse('不允许访问私有/保留网络地址', { status: 403 });
  }

  const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' };
  try {
    if (isDoubanHost(new URL(targetUrl).hostname)) {
      headers.Referer = 'https://movie.douban.com/';
    }
  } catch { /* 忽略非法 URL */ }

  const range = req.headers.get('range');
  if (range) headers.Range = range;

  // 客户端断开（换集 / 关页 / 拖动进度）时终止上游连接，避免连接泄漏
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });

  let response: Response | undefined;
  let finalUrl = targetUrl;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 只对「等待响应头」限时，不对 body 设总超时。
      // 分片动辄 2~8 MB，源站限速时下载一个分片常常超过 8 秒；
      // 用 AbortSignal.timeout 会把 body 拦腰截断，浏览器报
      // ERR_INCOMPLETE_CHUNKED_ENCODING（表现为播放一直卡在同一处、疯狂重试）。
      const result = await fetchWithSafeRedirects(
        targetUrl,
        { headers, signal: controller.signal },
        { headerTimeoutMs: TIMEOUT_MS }
      );
      response = result.res;
      finalUrl = result.finalUrl;
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!response) {
    proxyLog(`status=502 fetch-fail err=${lastError instanceof Error ? lastError.message : 'unknown'} url=${targetUrl}`);
    return new NextResponse(
      `代理请求失败: ${lastError instanceof Error ? lastError.message : '未知错误'}`,
      { status: 502 }
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const isM3u8 =
    contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
    targetUrl.toLowerCase().endsWith('.m3u8');

  // m3u8 文本：重写为代理地址（以重定向后的最终 URL 为 base 解析相对地址）
  if (isM3u8) {
    const text = await response.text();
    proxyLog(`m3u8 status=${response.status} len=${text.length} url=${targetUrl}`);
    return new NextResponse(rewriteM3u8(text, finalUrl), {
      status: response.status,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // 其余（图片 / JSON / 分片 / key）流式透传
  const outHeaders = new Headers();
  for (const name of ['content-type', 'accept-ranges', 'content-range', 'etag', 'last-modified']) {
    const v = response.headers.get(name);
    if (v) outHeaders.set(name, v);
  }
  // fetch 会自动解压，转发时必须去掉长度相关头避免浏览器二次解压
  // 图片基本不变：长缓存交给浏览器与边缘 CDN（分片 / key 仍保守 1 小时）
  outHeaders.set(
    'Cache-Control',
    contentType.startsWith('image/') ? 'public, max-age=2592000' : 'public, max-age=3600'
  );
  outHeaders.set('Access-Control-Allow-Origin', '*');

  // 逐条记录分片的真实字节数：卡顿时能区分「上游提前断开」与「本地转发中断」
  const expected = Number.parseInt(response.headers.get('content-length') || '', 10);
  const startedAt = Date.now();
  let sent = 0;
  const logOnce = (outcome: string) => {
    proxyLog(
      `status=${response?.status ?? '-'} expect=${Number.isFinite(expected) ? expected : '-'} sent=${sent} ` +
        `ms=${Date.now() - startedAt} outcome=${outcome} url=${targetUrl}`
    );
  };

  // 大分片 + 客户端没指定范围 → 分块并行下载（这项才是真正的提速点）。
  // 不依赖 `Accept-Ranges` 响应头：不少 CDN 支持 206 却不带这个头，交给探针判断。
  const clientRange = req.headers.get('range');
  if (!clientRange && Number.isFinite(expected) && expected >= PARALLEL_MIN_BYTES) {
    try {
      const parallel = await buildParallelBody(targetUrl, headers, response, expected);
      if (parallel) {
        sent = expected;
        proxyLog(
          `status=200 expect=${expected} sent=${expected} ms=${Date.now() - startedAt} ` +
            `outcome=parallel url=${targetUrl}`
        );
        outHeaders.set('X-LibreTV-Proxy', 'parallel');
        return new NextResponse(parallel, { status: response.status, headers: outHeaders });
      }
    } catch {
      /* 并行失败：退回下面的普通流式透传 */
    }
  }

  outHeaders.set('X-LibreTV-Proxy', 'stream');
  const body = response.body
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          const reader = response.body!.getReader();
          const pump = (): void => {
            reader.read().then(
              ({ done, value }) => {
                if (done) {
                  logOnce('eof');
                  controller.close();
                  return;
                }
                sent += value.byteLength;
                controller.enqueue(value);
                pump();
              },
              (err: unknown) => {
                logOnce(`error:${err instanceof Error ? err.message : 'unknown'}`);
                controller.error(err);
              }
            );
          };
          pump();
        },
        cancel(reason) {
          logOnce(`client-cancel:${String(reason ?? '')}`);
          response?.body?.cancel(reason).catch(() => {});
        },
      })
    : null;

  return new NextResponse(body, {
    status: response.status,
    headers: outHeaders,
  });
}

/**
 * 直播流专用长连接代理（不复用 /api/proxy）：
 *
 * /api/proxy 的 AbortSignal.timeout(TIMEOUT_MS) 作用于整个响应流，
 * 8 秒后即切断长连接——对 HTTP-FLV（单一无限长连接）是致命的。
 * 本路由改为「仅对响应头等待设超时」（fetchWithSafeRedirects 的
 * headerTimeoutMs）：fetch 拿到响应头后立即清除计时器，
 * 之后 body 无限时长流式透传，直到客户端断开。
 *
 * - 不重试（重试对直播无意义）；
 * - m3u8 manifest 仍需重写（变体/分片地址改指本路由），FLV 等纯透传；
 * - 每一跳都强制 SSRF 校验（不信任解析阶段的校验结果）；
 * - 部署者可设 LIVE_ALLOW_PRIVATE=1 显式放行内网自建源（默认拒绝）。
 */
export async function handleLiveStreamRequest(req: Request, targetUrl: string): Promise<Response> {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const verdict = await checkLiveUrlAllowed(targetUrl);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  const controller = new AbortController();
  // 客户端断开（切台/关页）时终止上游连接，防止连接泄漏
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });

  const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' };

  let response: Response;
  let finalUrl: string;
  try {
    // 客户端断开（切台/关页）时经 controller.signal 终止上游连接，防止连接泄漏
    const result = await fetchWithSafeRedirects(
      targetUrl,
      { headers, signal: controller.signal },
      { allowPrivate: true, headerTimeoutMs: HEADER_TIMEOUT_MS }
    );
    response = result.res;
    finalUrl = result.finalUrl;
  } catch (err) {
    return jsonError(
      `直播流连接失败: ${err instanceof Error ? err.message : '未知错误'}`,
      502
    );
  }

  if (!response.ok && response.body) {
    // 非直播正常响应（403/404 等）：透传原始状态码便于前端与开发者工具定位
    // （一律包成 502 会掩盖「token 过期 403」与「源瞬断」的区别）
    try { await response.body.cancel(); } catch { /* 忽略 */ }
    return NextResponse.json(
      { error: `直播流上游返回 ${response.status}` },
      {
        status: response.status,
        headers: { 'Cache-Control': 'no-store', 'X-Live-Upstream-Status': String(response.status) },
      }
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const isM3u8 =
    contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
    targetUrl.toLowerCase().split('?')[0].endsWith('.m3u8');

  // HLS manifest：重写变体/分片地址指向本路由，保证后续请求同源同鉴权。
  // 关键：以重定向后的最终 URL 为 base 解析相对地址（gslb 调度源 302 后路径会变）
  if (isM3u8) {
    const text = await response.text();
    return new NextResponse(rewriteM3u8(text, finalUrl, 0, LIVE_STREAM_BASE), {
      status: response.status,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      },
    });
  }

  // FLV / TS 等流媒体：纯流式透传（禁止缓冲与缓存）
  const outHeaders = new Headers();
  const ct = contentType || 'video/mp2t';
  outHeaders.set('Content-Type', ct);
  outHeaders.set('Cache-Control', 'no-store, no-transform');
  outHeaders.set('X-Accel-Buffering', 'no');

  return new NextResponse(response.body, {
    status: response.status,
    headers: outHeaders,
  });
}
