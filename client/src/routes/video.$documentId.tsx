import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '#/components/ui/button';
import { VideoCard } from '#/components/VideoCard';
import { getVideoByDocumentId } from '#/data/server-functions/videos';

export const Route = createFileRoute('/video/$documentId')({
  loader: async ({ params }) => {
    const video = await getVideoByDocumentId({
      data: { documentId: params.documentId },
    });
    return { video };
  },
  component: VideoPage,
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.video?.videoTitle
          ? `${loaderData.video.videoTitle} · YT Knowledge Base`
          : 'Video · YT Knowledge Base',
      },
    ],
  }),
});

function VideoPage() {
  const { video } = Route.useLoaderData();
  if (!video) return <NotFound />;
  return (
    <main className="page-wrap px-4 pb-20 pt-10 sm:pt-14">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6">
          <Link to="/feed" className="text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]">
            ← Back to feed
          </Link>
        </div>
        <VideoCard video={video} />
      </div>
    </main>
  );
}

function NotFound() {
  return (
    <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-14">
      <div className="rise-in mx-auto max-w-md rounded-2xl border border-[var(--line)] bg-[var(--card)] p-10 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
          Not found
        </p>
        <h1 className="display-title mt-2 text-3xl text-[var(--ink)]">
          That video isn't here.
        </h1>
        <Button asChild size="pill" className="mt-6">
          <Link to="/feed">Back to feed</Link>
        </Button>
      </div>
    </main>
  );
}
