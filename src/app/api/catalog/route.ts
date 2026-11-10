import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchCatalogPage } from '@/lib/cms-catalog';
import type { CatalogResponse } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * 片库：按分类浏览单个源。
 * GET /api/catalog?url=<api 地址>&type=<分类ID>&page=1&filterAdult=1
 * `type` 省略表示「全部」（源站默认按最新排序）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const url = (sp.get('url') || '').trim().replace(/\/+$/, '');
  const type = (sp.get('type') || '').trim();
  const rawPage = parseInt(sp.get('page') || '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 5000) : 1;
  const filterAdult = sp.get('filterAdult') !== '0';

  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: '无效的源地址' }, { status: 400 });
  }

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 地址已通过正则校验，这里只做展示兜底 */
  }

  try {
    const result = await fetchCatalogPage(
      { key: sp.get('key') || host, name: sp.get('name') || host, url },
      { type, page, filterAdult }
    );
    const payload: CatalogResponse = result;
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
