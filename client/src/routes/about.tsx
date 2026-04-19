import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '#/components/ui/button';

export const Route = createFileRoute('/about')({
  component: About,
  head: () => ({ meta: [{ title: 'About · YT Knowledge Base' }] }),
});

function About() {
  return (
    <main className="page-wrap px-4 py-14 sm:py-20">
      <div className="mx-auto max-w-3xl">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1 text-xs font-medium text-[var(--ink-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          About
        </span>
        <h1 className="display-title mt-5 text-4xl text-[var(--ink)] sm:text-6xl">
          A local-first knowledge base for YouTube videos.
        </h1>
        <p className="mt-6 text-base leading-relaxed text-[var(--ink-soft)] sm:text-lg">
          Paste any YouTube URL — the app pulls the title, channel, and thumbnail, caches the
          full transcript, and runs a local AI model (Ollama + Gemma 3) to produce a structured
          summary with a timestamped walkthrough and concrete action steps. Everything stays on
          your machine.
        </p>

        <section className="mt-12 grid gap-6 sm:grid-cols-2">
          <Feature
            kicker="Zero auth"
            title="Single-user, local-first"
            body="No sign-up, no credits, no cloud. You're the only user. The app runs on your machine against a local Strapi + Ollama."
          />
          <Feature
            kicker="Bring your own model"
            title="Ollama powered"
            body="Pull any model (gemma3, llama3.2, mistral, qwen…) and set OLLAMA_MODEL in your .env. Swap models any time."
          />
          <Feature
            kicker="Tags, search, pagination"
            title="Free-form taxonomy"
            body="Tags are created on the fly from your comma-separated input, normalized to lowercase, deduped automatically. Click any tag to filter."
          />
          <Feature
            kicker="Persistent transcripts"
            title="Ready for Q&A"
            body="The raw transcript is saved alongside the summary. Future: chat with any video using the local model."
          />
        </section>

        <div className="mt-16 flex flex-wrap gap-3">
          <Button asChild size="pill-lg">
            <Link to="/new-post">Share your first video</Link>
          </Button>
          <Button asChild size="pill-lg" variant="outline">
            <Link to="/feed">Browse the feed</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}

function Feature({
  kicker,
  title,
  body,
}: Readonly<{ kicker: string; title: string; body: string }>) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        {kicker}
      </p>
      <h3 className="mt-2 text-lg font-semibold text-[var(--ink)]">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">{body}</p>
    </div>
  );
}
