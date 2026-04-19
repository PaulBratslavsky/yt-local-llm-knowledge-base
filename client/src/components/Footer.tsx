import { Link } from '@tanstack/react-router';

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-[var(--line)] bg-[var(--card)]">
      <div className="flex flex-col gap-8 px-6 py-10 sm:flex-row sm:items-start sm:justify-between sm:px-10 sm:py-14 lg:px-14">
        <div className="max-w-sm">
          <div className="inline-flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ink)] text-[var(--card)]">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 6l16 0" />
                <path d="M4 12l16 0" />
                <path d="M10 18l10 0" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">
              YT Knowledge Base
            </span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--ink-muted)]">
            A local-first, single-user knowledge base for YouTube videos. Paste a URL, get
            a structured AI summary with timestamped walkthrough — then chat with the
            transcript.
          </p>
        </div>

        <nav
          aria-label="Footer"
          className="grid grid-cols-2 gap-x-10 gap-y-4 text-sm sm:grid-cols-3"
        >
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              Library
            </span>
            <Link
              to="/feed"
              className="text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              Feed
            </Link>
            <Link
              to="/new-post"
              className="text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              Share a video
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              About
            </span>
            <Link
              to="/about"
              className="text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              About
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              Built with
            </span>
            <a
              href="https://strapi.io"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              Strapi
            </a>
            <a
              href="https://tanstack.com/start"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              TanStack Start
            </a>
            <a
              href="https://tanstack.com/ai/latest"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              TanStack AI
            </a>
            <a
              href="https://ollama.com"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              Ollama (local LLM)
            </a>
          </div>
        </nav>
      </div>
      <div className="border-t border-[var(--line)]">
        <div className="flex flex-col gap-2 px-6 py-5 text-xs text-[var(--ink-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-10 sm:gap-4 lg:px-14">
          <span>&copy; {year} YT Knowledge Base — local-first, single-user.</span>
          <span className="flex flex-wrap items-center gap-1.5">
            Built with{' '}
            <a
              href="https://strapi.io"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              Strapi
            </a>
            ,{' '}
            <a
              href="https://tanstack.com/start"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              TanStack
            </a>
            , and{' '}
            <a
              href="https://tanstack.com/ai/latest"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              TanStack AI
            </a>
            , powered by a local LLM via{' '}
            <a
              href="https://ollama.com"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              Ollama
            </a>
            . Built by Paul @{' '}
            <a
              href="https://strapi.io"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
            >
              Strapi
            </a>
            .
          </span>
        </div>
      </div>
    </footer>
  );
}
