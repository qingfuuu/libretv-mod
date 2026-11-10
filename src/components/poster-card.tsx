'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { SearchResultItem } from '@/lib/types';
import { SmartImage } from './smart-image';

/**
 * 竖版海报卡：首页「各源最新」的横向滑动行与片库网格共用。
 * 与搜索结果卡（左图右文）不同，这里信息密度更高，适合图片墙式浏览。
 */
export function PosterCard({
  item,
  onClick,
  showSource = false,
  className,
}: {
  item: SearchResultItem;
  onClick: () => void;
  /** 是否在海报下方显示来源名（片库同一时间只有一个源，通常不需要） */
  showSource?: boolean;
  className?: string;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);

  // 列表复用同一个组件实例时，换片要重置失败状态，否则新海报会沿用上一张的占位
  useEffect(() => setImgFailed(false), [item.pic]);

  const showImg = Boolean(item.pic) && !imgFailed;

  return (
    <button
      type="button"
      onClick={onClick}
      title={item.name}
      className={cn('group w-full text-left focus-visible:outline-none', className)}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-line/60 transition group-hover:shadow-md group-hover:ring-accent/40">
        {showImg ? (
          <SmartImage
            url={item.pic as string}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-lg text-faint">▶</div>
        )}
        {item.year && (
          <span className="absolute bottom-1 left-1 rounded bg-black/65 px-1.5 py-0 text-[10px] text-white/90">
            {item.year}
          </span>
        )}
        {item.remarks && (
          <span className="absolute right-1 top-1 max-w-[72%] truncate rounded bg-accent/90 px-1.5 py-0 text-[10px] text-on-accent">
            {item.remarks}
          </span>
        )}
      </div>
      <div className="mt-1.5 line-clamp-2 text-xs leading-snug text-content">{item.name}</div>
      {showSource && <div className="mt-0.5 truncate text-[11px] text-faint">{item.sourceName}</div>}
    </button>
  );
}
