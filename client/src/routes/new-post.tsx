import { createFileRoute } from '@tanstack/react-router';
import { NewPostForm } from '#/components/NewPostForm';

export const Route = createFileRoute('/new-post')({
  component: NewPostPage,
  head: () => ({ meta: [{ title: 'Share a video · YT Knowledge Base' }] }),
});

function NewPostPage() {
  return (
    <main className="page-wrap px-4 pb-20 pt-10 sm:pt-16">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1 text-xs font-medium text-[var(--ink-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            Share
          </span>
          <h1 className="display-title mt-5 text-3xl text-[var(--ink)] sm:text-5xl">
            Add a video to the knowledge base.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-[var(--ink-soft)]">
            Paste a YouTube URL. We'll pull the title, channel, and thumbnail automatically, and
            start generating the AI summary in the background so it's ready when you click
            through.
          </p>
        </header>

        <div className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
          <NewPostForm />
        </div>
      </div>
    </main>
  );
}
