import { Link, useLocation } from '@tanstack/react-router'
import ThemeToggle from './ThemeToggle'

export default function Header() {
  const pathname = useLocation({ select: (l) => l.pathname })
  const onNewPost = pathname === '/new-post'

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--header-bg)] backdrop-blur-lg">
      <nav className="flex items-center gap-3 px-6 py-3 sm:px-10 sm:py-4 lg:px-14">
        <Link to="/" className="inline-flex items-center gap-2 no-underline">
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
            >
              <path d="M4 6l16 0" />
              <path d="M4 12l16 0" />
              <path d="M10 18l10 0" />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">
            YT Knowledge Base
          </span>
        </Link>

        {/* Desktop nav — hidden on mobile; mobile uses the bottom nav */}
        <div className="ml-auto hidden items-center gap-5 md:flex">
          <Link
            to="/feed"
            className="nav-link text-sm"
            activeProps={{ className: 'nav-link is-active text-sm' }}
          >
            Feed
          </Link>
          <Link
            to="/about"
            className="nav-link text-sm"
            activeProps={{ className: 'nav-link is-active text-sm' }}
          >
            About
          </Link>
          {!onNewPost && (
            <Link
              to="/new-post"
              aria-label="Share a video"
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ink)] px-3.5 py-1.5 text-sm font-medium text-[var(--cream)] no-underline transition hover:bg-[var(--ink-soft)]"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Share
            </Link>
          )}
          <ThemeToggle />
        </div>

        {/* Mobile: just theme toggle; mobile uses BottomNav for routing */}
        <div className="ml-auto flex items-center gap-2 md:hidden">
          <ThemeToggle />
        </div>
      </nav>
    </header>
  )
}
