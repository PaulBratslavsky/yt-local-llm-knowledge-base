import { Link } from '@tanstack/react-router';
import { type StrapiVideo } from '#/lib/services/videos';

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function SummaryStatusBadge({ video }: Readonly<{ video: StrapiVideo }>) {
  if (video.summaryStatus === 'generated') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
        Summary ready
      </span>
    );
  }
  if (video.summaryStatus === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-destructive">
        Summary failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ink-muted)]" />
      Generating…
    </span>
  );
}

function TagChips({ video }: Readonly<{ video: StrapiVideo }>) {
  if (!video.tags || video.tags.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {video.tags.map((t) => (
        <Link
          key={t.id}
          to="/feed"
          search={{ tag: t.slug }}
          className="inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-2.5 py-0.5 text-[0.65rem] font-medium text-[var(--ink-muted)] transition hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
        >
          #{t.name}
        </Link>
      ))}
    </div>
  );
}

export function VideoCard({ video }: Readonly<{ video: StrapiVideo }>) {
  const src = `https://www.youtube-nocookie.com/embed/${video.youtubeVideoId}`;
  return (
    <article className="rise-in overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--card)] transition-shadow duration-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),0_12px_32px_rgba(9,9,11,0.06)]">
      <header className="flex items-center gap-3 px-5 pt-5">
        <div className="flex flex-1 flex-col leading-tight">
          <span className="text-xs text-[var(--ink-muted)]">
            Added {relativeTime(video.createdAt)}
          </span>
        </div>
        <SummaryStatusBadge video={video} />
      </header>

      <div className="mt-4 aspect-video w-full overflow-hidden bg-black">
        <iframe
          src={src}
          title={video.videoTitle ?? 'YouTube video'}
          loading="lazy"
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="h-full w-full border-0"
        />
      </div>

      <div className="grid gap-1.5 px-5 py-4">
        {video.videoTitle && (
          <h3 className="text-base font-semibold leading-snug tracking-tight text-[var(--ink)]">
            {video.videoTitle}
          </h3>
        )}
        {video.videoAuthor && (
          <p className="text-xs text-[var(--ink-muted)]">{video.videoAuthor}</p>
        )}
        {video.caption && (
          <p className="mt-1 text-sm leading-relaxed text-[var(--ink-soft)]">{video.caption}</p>
        )}
        <TagChips video={video} />
      </div>

      <div className="flex items-center justify-end gap-1 border-t border-[var(--line)] px-3 py-2">
        <Link
          to="/learn/$videoId"
          params={{ videoId: video.youtubeVideoId }}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--ink-muted)] transition hover:bg-[var(--bg-subtle)] hover:text-[var(--ink)]"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 1a5 5 0 0 0-3 9v1.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V10a5 5 0 0 0-3-9zm-2 13.5V13h4v1.5a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5z"
            />
          </svg>
          Open summary
        </Link>
      </div>
    </article>
  );
}
