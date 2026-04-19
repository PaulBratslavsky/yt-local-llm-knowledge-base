import { createFileRoute, redirect } from '@tanstack/react-router';

// Local-first, single-user app — no landing page distinct from the feed.
// Land on / → go to /feed. The feed itself handles the empty state with a
// "share your first video" prompt.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/feed' });
  },
});
