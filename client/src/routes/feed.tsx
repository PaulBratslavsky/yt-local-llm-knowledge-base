import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { VideoCard } from '#/components/VideoCard';
import { Button } from '#/components/ui/button';
import { getFeed } from '#/data/server-functions/videos';

const FeedSearchSchema = z.object({
  q: z.string().max(200).optional(),
  tag: z.string().max(80).optional(),
  page: z.number().int().min(1).max(1000).optional(),
});

export const Route = createFileRoute('/feed')({
  validateSearch: FeedSearchSchema,
  loaderDeps: ({ search }) => ({ q: search.q, tag: search.tag, page: search.page }),
  loader: async ({ deps }) => {
    const result = await getFeed({
      data: { q: deps.q, tag: deps.tag, page: deps.page ?? 1, pageSize: 20 },
    });
    return { result };
  },
  component: FeedPage,
  head: () => ({ meta: [{ title: 'Feed · YT Knowledge Base' }] }),
});

function FeedPage() {
  const { result } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <main className="px-6 pb-20 pt-10 sm:px-10 sm:pt-14 lg:px-14">
      <header className="mb-8">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1 text-xs font-medium text-[var(--ink-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          Knowledge feed
        </span>
        <h1 className="display-title mt-5 max-w-3xl text-[2.75rem] text-[var(--ink)] sm:text-[4rem]">
          Shared videos,
          <br />
          <span className="text-[var(--ink-muted)]">summarized.</span>
        </h1>
      </header>

      <SearchBar q={search.q ?? ''} tag={search.tag} />

      {search.tag && <ActiveTagPill tag={search.tag} />}

      {result.videos.length === 0 ? (
        <EmptyFeed q={search.q} tag={search.tag} />
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between text-sm text-[var(--ink-muted)]">
            <span>
              {result.total} {result.total === 1 ? 'video' : 'videos'}
            </span>
            <span>
              Page {result.page} of {Math.max(1, result.pageCount)}
            </span>
          </div>
          <section className="grid items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {result.videos.map((video) => (
              <VideoCard key={video.documentId} video={video} />
            ))}
          </section>
          <Pagination
            currentPage={result.page}
            pageCount={result.pageCount}
            q={search.q}
            tag={search.tag}
          />
        </>
      )}
    </main>
  );
}

function SearchBar({ q, tag }: Readonly<{ q: string; tag?: string }>) {
  return (
    <form method="get" action="/feed" className="mb-6 flex flex-wrap gap-2">
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search titles, channels, captions…"
        className="h-10 min-w-0 flex-1 rounded-full border border-[var(--line)] bg-[var(--card)] px-4 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--line-strong)] focus:outline-none"
      />
      {tag && <input type="hidden" name="tag" value={tag} />}
      <Button type="submit" size="pill">
        Search
      </Button>
    </form>
  );
}

function ActiveTagPill({ tag }: Readonly<{ tag: string }>) {
  return (
    <div className="mb-5 flex items-center gap-2 text-sm text-[var(--ink-muted)]">
      Filtered by
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-3 py-1 text-xs font-medium text-[var(--ink)]">
        #{tag}
        <Link
          to="/feed"
          search={{}}
          aria-label="Clear tag filter"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--line)]"
        >
          ×
        </Link>
      </span>
    </div>
  );
}

function Pagination({
  currentPage,
  pageCount,
  q,
  tag,
}: Readonly<{ currentPage: number; pageCount: number; q?: string; tag?: string }>) {
  if (pageCount <= 1) return null;
  const prev = Math.max(1, currentPage - 1);
  const next = Math.min(pageCount, currentPage + 1);

  return (
    <nav className="mt-10 flex items-center justify-center gap-3" aria-label="Pagination">
      <Button asChild size="pill" variant="outline" disabled={currentPage === 1}>
        <Link to="/feed" search={{ q, tag, page: prev }}>
          ← Prev
        </Link>
      </Button>
      <span className="text-sm font-medium text-[var(--ink-muted)]">
        {currentPage} / {pageCount}
      </span>
      <Button asChild size="pill" variant="outline" disabled={currentPage === pageCount}>
        <Link to="/feed" search={{ q, tag, page: next }}>
          Next →
        </Link>
      </Button>
    </nav>
  );
}

function EmptyFeed({ q, tag }: Readonly<{ q?: string; tag?: string }>) {
  const filtered = Boolean(q || tag);
  return (
    <section className="mx-auto max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--card)] p-10 text-center">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
        {filtered ? 'No matches' : 'Nothing here yet'}
      </p>
      <h2 className="display-title mt-2 text-3xl text-[var(--ink)]">
        {filtered ? 'Try a different search.' : 'Share the first video.'}
      </h2>
      <p className="mt-3 text-sm text-[var(--ink-soft)]">
        {filtered
          ? 'Or clear the filter to see everything.'
          : 'Paste a YouTube URL to seed the knowledge base. The AI summary runs in the background.'}
      </p>
      <div className="mt-6 flex justify-center gap-2">
        {filtered ? (
          <Button asChild size="pill" variant="outline">
            <Link to="/feed" search={{}}>
              Clear filters
            </Link>
          </Button>
        ) : (
          <Button asChild size="pill">
            <Link to="/new-post">Share a video</Link>
          </Button>
        )}
      </div>
    </section>
  );
}
