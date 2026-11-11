import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchCatalogPage } from '@/lib/cms-catalog';
import { getCache, setCache } from '@/lib/fetch-utils';
import type { FeedResponse, FeedSourceResult, SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';

/** 一次最多并行取多少个源：10 个左右的源首屏就够密，再多只是拖慢 */
const MAX_SOURCES = 12;
const DEFAULT_LIMIT = 12;
/** 单源死线：首页不能因为一个慢源卡住十几秒 */
const SOURCE_TIMEOUT_MS = 6000;
/** 结果缓存 2 分钟：既避免每次刷新都轰炸源站，ms 也仍是近期实测值 */
const FEED_CACHE_TTL = 2 * 60 * 1000;

interface FeedBody {
  sources: SourceConfig[];
  limit?: number;
  filterAdult?: boolean;
}

/**
 * 首页「各源最新」：按源并行取第一页列表（源站默认按入库时间倒序），
 * 同时把这次请求的服务端耗时一并返回——首页的速度榜就是按它排序的。
 * 每个源独立成败，个别源挂了不影响其它源上屏。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: FeedBody;
  try {
    body = (await req.json()) as FeedBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const sources = (Array.isArray(body.sources) ? body.sources : [])
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
    .slice(0, MAX_SOURCES);
  if (sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }

  const limit = Math.min(24, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
  const filterAdult = body.filterAdult !== false;

  // 流式模式：每个源一结算就推一条，前端边收边上屏；
  // 否则 Promise.all 要等最慢的源（最长 6 秒）才渲染，首页会明显卡顿。
  if (new URL(req.url).searchParams.get('stream') === '1') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (event: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          } catch {
            closed = true; // 客户端已断开
          }
        };
        const results = await Promise.all(
          sources.map(async (source) => {
            const result = await loadSource(source, limit, filterAdult);
            send({ type: 'source', ...result });
            return result;
          })
        );
        send({ type: 'done', sources: results });
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已断开 */
        }
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const results = await Promise.all(sources.map((source) => loadSource(source, limit, filterAdult)));
  const payload: FeedResponse = { sources: results };
  return NextResponse.json(payload);
}

async function loadSource(
  source: SourceConfig,
  limit: number,
  filterAdult: boolean
): Promise<FeedSourceResult> {
  const cacheKey = `feed:${source.url.replace(/\/+$/, '')}:${limit}:${filterAdult ? 1 : 0}`;
  const cached = getCache<FeedSourceResult>(cacheKey);
  if (cached) return cached;

  const start = Date.now();
  try {
    const page = await fetchCatalogPage(source, { page: 1, filterAdult, timeoutMs: SOURCE_TIMEOUT_MS });
    const result: FeedSourceResult = {
      sourceKey: source.key,
      sourceName: source.name,
      ok: true,
      ms: Date.now() - start,
      list: page.list.slice(0, limit),
      total: page.total,
      categories: page.categories,
    };
    setCache(cacheKey, result, FEED_CACHE_TTL);
    return result;
  } catch (err) {
    return {
      sourceKey: source.key,
      sourceName: source.name,
      ok: false,
      ms: Date.now() - start,
      list: [],
      error: err instanceof Error ? err.message : '请求失败',
    };
  }
}
