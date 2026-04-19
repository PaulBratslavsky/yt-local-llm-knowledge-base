import { Link, useRouterState } from '@tanstack/react-router';

type TabId = 'feed' | 'new' | 'about';

type Tab = {
  id: TabId;
  label: string;
  to: string;
  icon: React.ReactNode;
};

const TABS: Tab[] = [
  {
    id: 'feed',
    label: 'Feed',
    to: '/feed',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 12L12 3l9 9" />
        <path d="M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    id: 'new',
    label: 'Share',
    to: '/new-post',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    ),
  },
  {
    id: 'about',
    label: 'About',
    to: '/about',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v.01M11 12h1v5h1" />
      </svg>
    ),
  },
];

export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isActive = (to: string) =>
    to === '/' ? pathname === '/' : pathname.startsWith(to);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--line)] bg-[var(--header-bg)] backdrop-blur-lg md:hidden">
      <ul className="flex items-stretch justify-around px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2">
        {TABS.map((t) => {
          const active = isActive(t.to);
          return (
            <li key={t.id} className="flex-1">
              <Link
                to={t.to}
                className={`flex flex-col items-center gap-0.5 rounded-2xl px-2 py-1.5 transition ${
                  active ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'
                }`}
              >
                <span
                  className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
                    active ? 'bg-[var(--ink)] text-[var(--cream)]' : ''
                  }`}
                >
                  {t.icon}
                </span>
                <span className="text-[0.65rem] font-bold uppercase tracking-wider">
                  {t.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
