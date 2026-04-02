"use client";

import type { NewsPost } from "@/lib/api";

interface NewsFeedProps {
  news: NewsPost[];
  onSelectToken: (coin: string) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

const SENTIMENT_STYLE = {
  positive: { bg: "bg-[var(--hl-green)]/10", text: "text-[var(--hl-green)]", icon: "+" },
  negative: { bg: "bg-[var(--hl-red)]/10", text: "text-[var(--hl-red)]", icon: "-" },
  neutral: { bg: "bg-[var(--hl-surface)]", text: "text-[var(--hl-muted)]", icon: "~" },
};

export function NewsFeed({ news, onSelectToken }: NewsFeedProps) {
  if (!news.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        No news available
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        News Feed
      </h2>
      <div className="overflow-y-auto max-h-[220px] space-y-0">
        {news.map((post) => {
          const style = SENTIMENT_STYLE[post.sentiment] || SENTIMENT_STYLE.neutral;
          return (
            <div
              key={post.id}
              className="flex items-start gap-2 px-2 py-1.5 border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              {/* Sentiment indicator */}
              <span className={`text-[10px] font-bold mt-0.5 w-4 text-center ${style.text}`}>
                {style.icon}
              </span>

              <div className="flex-1 min-w-0">
                <a
                  href={post.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[var(--foreground)] hover:text-[var(--hl-green)] leading-tight line-clamp-2"
                >
                  {post.title}
                </a>
                <div className="flex items-center gap-2 mt-0.5 text-[9px] text-[var(--hl-muted)]">
                  <span>{post.source}</span>
                  <span>{timeAgo(post.publishedAt)}</span>
                  {post.currencies.length > 0 && (
                    <div className="flex items-center gap-1">
                      {post.currencies.slice(0, 3).map((c) => (
                        <button
                          key={c}
                          onClick={(e) => { e.preventDefault(); onSelectToken(c); }}
                          className="px-1 py-0 rounded bg-[var(--hl-surface)] text-[var(--hl-green)] hover:bg-[var(--hl-surface-hover)]"
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
