import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Button } from '#/components/ui/button';
import {
  TimecodeMarkdown,
  stripInlineTimecodes,
} from '#/components/TimecodeMarkdown';
import { SectionTimecodeEditor } from '#/components/SectionTimecodeEditor';
import { VideoChat } from '#/components/VideoChat';
import {
  GenerationModeSelect,
  GenerationModeOptions,
} from '#/components/GenerationModeSelect';
import {
  clearSummaryFailure,
  getGenerationProgress,
  getVideoByVideoId,
  regenerateSummary,
  triggerSummaryGeneration,
  type GenerationProgress,
} from '#/data/server-functions/videos';
import type { StrapiVideo } from '#/lib/services/videos';
import type { GenerationMode } from '#/lib/validations/post';

// The learn page loads by videoId (the YouTube id in the URL). There are
// four possible states:
//   1. Video row doesn't exist yet → user hasn't shared this video. Prompt
//      to share.
//   2. Row exists, summaryStatus === 'generated' → render everything.
//   3. Row exists, summaryStatus === 'pending' → show the pending UI and
//      poll every 3s. Auto-trigger a fallback generation if it's been
//      pending too long (handled by triggerSummaryGeneration's dedupe).
//   4. Row exists, summaryStatus === 'failed' → show the error state with
//      retry.
type LoaderData =
  | { status: 'ready'; video: StrapiVideo }
  | { status: 'pending'; video: StrapiVideo; progress: GenerationProgress }
  | { status: 'failed'; video: StrapiVideo; error?: string }
  | { status: 'unshared' };

export const Route = createFileRoute('/learn/$videoId')({
  loader: async ({ params }): Promise<LoaderData> => {
    const video = await getVideoByVideoId({ data: { videoId: params.videoId } });
    if (!video) return { status: 'unshared' };
    if (video.summaryStatus === 'generated') return { status: 'ready', video };
    if (video.summaryStatus === 'failed') return { status: 'failed', video };

    // Still pending — nudge the background job (no-op if already running).
    // If the trigger reports a recent in-memory failure, the DB row is stale
    // (bg job threw before it could mark the row failed). Surface the error
    // so the UI doesn't poll forever.
    const trigger = await triggerSummaryGeneration({ data: { videoId: params.videoId } });
    if (trigger.status === 'error') {
      return { status: 'failed', video, error: trigger.error };
    }
    const progress = await getGenerationProgress({ data: { videoId: params.videoId } });
    return { status: 'pending', video, progress };
  },
  component: LearnPage,
  head: ({ loaderData }) => {
    if (loaderData?.status === 'ready') {
      const v = loaderData.video;
      return {
        meta: [
          { title: `${v.summaryTitle ?? v.videoTitle ?? 'Summary'} · YT Knowledge Base` },
          ...(v.summaryDescription
            ? [{ name: 'description', content: v.summaryDescription }]
            : []),
        ],
      };
    }
    return { meta: [{ title: 'Summary · YT Knowledge Base' }] };
  },
});

// Poll the loader while generation is pending. Long videos doing
// map-reduce summaries can run 5–10 min, so the cap has to exceed that or
// the UI freezes mid-run as polling dies. Also invalidates when the tab
// regains focus — tabbing back triggers an immediate refresh instead of
// waiting for the next interval tick.
function usePollingInvalidation(active: boolean) {
  const router = useRouter();
  const attemptsRef = useRef(0);

  useEffect(() => {
    if (!active) {
      attemptsRef.current = 0;
      return;
    }

    // 200 attempts × 3s = 10 min. Beyond that something is genuinely
    // wrong and the user should use "Force retry" rather than wait.
    const MAX_ATTEMPTS = 200;

    const id = window.setInterval(() => {
      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_ATTEMPTS) {
        window.clearInterval(id);
        return;
      }
      void router.invalidate();
    }, 3000);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void router.invalidate();
      }
    };
    const onFocus = () => {
      void router.invalidate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, router]);
}

function LearnPage() {
  const data = Route.useLoaderData();
  const { videoId } = Route.useParams();

  usePollingInvalidation(data.status === 'pending');

  if (data.status === 'unshared') return <UnsharedState videoId={videoId} />;
  if (data.status === 'pending')
    return <PendingState videoId={videoId} progress={data.progress} />;
  if (data.status === 'failed') return <FailedState video={data.video} error={data.error} />;
  return <SummaryView video={data.video} videoId={videoId} />;
}

function SummaryView({
  video,
  videoId,
}: Readonly<{ video: StrapiVideo; videoId: string }>) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const seekTo = (seconds: number) => {
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow;
    if (!win || !iframe) return;
    const origin = 'https://www.youtube.com';
    win.postMessage(
      JSON.stringify({ event: 'command', func: 'seekTo', args: [seconds, true] }),
      origin,
    );
    win.postMessage(
      JSON.stringify({ event: 'command', func: 'playVideo', args: [] }),
      origin,
    );
    // Desktop: the right column is sticky so the iframe is always visible —
    // no scroll needed. Mobile: the chat/video column stacks below summary,
    // so bring the iframe into view when a timecode is clicked.
    const rect = iframe.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const fullyVisible = rect.top >= 0 && rect.bottom <= viewportH;
    if (!fullyVisible) {
      iframe.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <main className="min-h-[calc(100vh-4rem)]">
      {/* Full-bleed edge-to-edge 60/40 split on lg+. LinkedIn-Learning /
          Udemy feel: the left summary panel has a subtle gray bg and
          extends to the left viewport edge; the right aside (video + chat)
          extends to the right viewport edge. Both columns fill the
          viewport vertically on desktop so the divider between them is a
          clean full-height line. */}
      <div className="grid min-h-[calc(100vh-4rem)] lg:grid-cols-[6fr_4fr] lg:items-stretch">
        <div className="min-w-0 bg-[var(--bg-subtle)] px-6 py-10 sm:px-10 sm:py-14 lg:px-14">
          <header className="mb-10">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1 text-xs font-medium text-[var(--ink-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              Summary
            </span>
            <h1 className="display-title mt-5 text-3xl leading-[1.1] text-[var(--ink)] sm:text-5xl">
              {video.summaryTitle ?? video.videoTitle ?? 'Video summary'}
            </h1>
            {video.summaryDescription && (
              <p className="mt-4 text-base leading-relaxed text-[var(--ink-soft)] sm:text-lg">
                {video.summaryDescription}
              </p>
            )}
            {(video.videoTitle ?? video.videoAuthor) && (
              <p className="mt-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                Based on{' '}
                {video.videoTitle && (
                  <span className="font-medium text-[var(--ink)]">{video.videoTitle}</span>
                )}
                {video.videoAuthor && (
                  <>
                    {video.videoTitle ? ' by ' : ''}
                    <span className="font-medium text-[var(--ink)]">{video.videoAuthor}</span>
                  </>
                )}
              </p>
            )}
          </header>
          {video.summaryOverview && (
            <section className="mb-10">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
                Overview
              </h2>
              <TimecodeMarkdown
                onSeek={seekTo}
                className="chat-md mt-4 text-base leading-relaxed text-[var(--ink-soft)]"
              >
                {video.summaryOverview}
              </TimecodeMarkdown>
            </section>
          )}

          {video.keyTakeaways && video.keyTakeaways.length > 0 && (
            <section className="mb-10">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
                Key takeaways
              </h2>
              <ul className="mt-4 grid gap-2.5">
                {video.keyTakeaways.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--card)] px-4 py-3 text-sm leading-relaxed text-[var(--ink-soft)]"
                  >
                    <span className="mt-[0.4rem] h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]" />
                    <TimecodeMarkdown
                      onSeek={seekTo}
                      className="chat-md min-w-0 flex-1"
                    >
                      {t.text}
                    </TimecodeMarkdown>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {video.sections && video.sections.length > 0 && (
            <section className="mb-10">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
                Walkthrough
              </h2>
              <div className="mt-4 grid gap-3">
                {/* Sort chronologically by timeSec (deterministic grounding
                    re-anchors these to real transcript moments, which may
                    not be in the model's narrative order). Sections with
                    no timeSec sink to the bottom. */}
                {[...video.sections]
                  .sort((a, b) => {
                    const aT = typeof a.timeSec === 'number' ? a.timeSec : Number.MAX_SAFE_INTEGER;
                    const bT = typeof b.timeSec === 'number' ? b.timeSec : Number.MAX_SAFE_INTEGER;
                    return aT - bT;
                  })
                  .map((s) => {
                  const hasTime = typeof s.timeSec === 'number';
                  return (
                    <article
                      key={s.id}
                      className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-5 sm:p-6"
                    >
                      <header className="flex items-start justify-between gap-3">
                        <h3 className="flex-1 text-base font-semibold leading-snug text-[var(--ink)]">
                          {s.heading}
                        </h3>
                        {hasTime && (
                          <SectionTimecodeEditor
                            documentId={video.documentId}
                            sectionId={s.id}
                            timeSec={s.timeSec as number}
                            iframeRef={iframeRef}
                            onSeek={seekTo}
                          />
                        )}
                      </header>
                      <TimecodeMarkdown
                        onSeek={seekTo}
                        className="chat-md mt-3 text-sm leading-relaxed text-[var(--ink-soft)]"
                      >
                        {stripInlineTimecodes(s.body)}
                      </TimecodeMarkdown>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {video.actionSteps && video.actionSteps.length > 0 && (
            <section className="mb-10">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
                Your plan
              </h2>
              <p className="mt-2 text-sm text-[var(--ink-muted)]">
                Concrete things to try this week, based on the video.
              </p>
              <ol className="mt-5 grid gap-3">
                {video.actionSteps.map((step, i) => (
                  <li
                    key={step.id}
                    className="flex gap-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-5 sm:p-6"
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[var(--ink)] text-sm font-bold text-[var(--cream)]">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold leading-snug text-[var(--ink)]">
                        {step.title}
                      </h3>
                      <TimecodeMarkdown
                        onSeek={seekTo}
                        className="chat-md mt-1.5 text-sm leading-relaxed text-[var(--ink-soft)]"
                      >
                        {step.body}
                      </TimecodeMarkdown>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <footer className="mt-12 border-t border-[var(--line)] pt-5 text-xs text-[var(--ink-muted)]">
            <h3 className="mb-3 text-sm font-medium text-[var(--ink)]">
              Generation mode
            </h3>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-xl">
                Auto-generated{video.aiModel ? ` by ${video.aiModel}` : ''}. Summaries are AI-
                produced and may miss nuance — treat them as reading notes, not a replacement
                for the video itself.
              </p>
              <RegenerateButton videoId={video.youtubeVideoId} />
            </div>
          </footer>
        </div>

        {/* Right column — video pinned at top edge-to-edge, chat filling
            remaining height. On lg+ the aside is sticky so the video stays
            visible while the left column scrolls. Bordered on the left to
            separate from the summary panel. */}
        <aside className="flex min-h-0 flex-col bg-[var(--card)] lg:sticky lg:top-16 lg:max-h-[calc(100vh-4rem)] lg:border-l lg:border-[var(--line)]">
          <div className="bg-black">
            <div className="relative aspect-video w-full">
              <iframe
                ref={iframeRef}
                src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0`}
                title={video.videoTitle ?? video.summaryTitle ?? 'Video'}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="absolute inset-0 h-full w-full"
              />
            </div>
          </div>
          <VideoChat
            videoId={videoId}
            onSeek={seekTo}
            className="min-h-[360px] flex-1 px-6 py-6 sm:px-8"
          />
        </aside>
      </div>
    </main>
  );
}

const STEPS: Array<{
  key: 'transcript' | 'ai' | 'saving';
  label: string;
  detail: string;
}> = [
  {
    key: 'transcript',
    label: 'Fetch transcript',
    detail: 'Pulling captions from the transcript service.',
  },
  {
    key: 'ai',
    label: 'Run local model',
    detail: 'Your Ollama model is reading the transcript and writing structured notes.',
  },
  {
    key: 'saving',
    label: 'Save to library',
    detail: 'Persisting the summary, sections, takeaways, and action steps.',
  },
];

function formatElapsed(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function PendingState({
  videoId,
  progress,
}: Readonly<{ videoId: string; progress: GenerationProgress }>) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const [retryMode, setRetryMode] = useState<GenerationMode>('auto');

  const handleForceRetry = async () => {
    setRetrying(true);
    await clearSummaryFailure({ data: { videoId } });
    await triggerSummaryGeneration({ data: { videoId, mode: retryMode } });
    await router.invalidate();
    setRetrying(false);
  };

  const currentIndex = progress.step
    ? STEPS.findIndex((s) => s.key === progress.step)
    : -1;
  const elapsed = formatElapsed(progress.elapsedMs);

  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-14 sm:px-10">
      <div className="mx-auto w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--card)] p-8 sm:p-10">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="h-8 w-8 flex-none animate-spin rounded-full border-[3px] border-[var(--line)] border-t-[var(--ink)]"
          />
          <div className="min-w-0">
            <h1 className="display-title text-xl text-[var(--ink)] sm:text-2xl">
              Generating your summary…
            </h1>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              You can leave this page — the job keeps running.
            </p>
          </div>
        </div>

        <ol className="mt-7 grid gap-3">
          {STEPS.map((step, i) => {
            const status =
              currentIndex === -1
                ? i === 0
                  ? 'active'
                  : 'pending'
                : i < currentIndex
                  ? 'done'
                  : i === currentIndex
                    ? 'active'
                    : 'pending';

            // For the active step, override the generic detail line with
            // the live sub-progress from the server (e.g. "map chunk 10/16")
            // so long map-reduce runs show forward motion instead of sitting
            // on a static label.
            const detailText =
              status === 'active' && progress.detail
                ? progress.detail
                : step.detail;
            const detailElapsed =
              status === 'active' && progress.detailElapsedMs != null
                ? formatElapsed(progress.detailElapsedMs)
                : null;

            return (
              <li
                key={step.key}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition ${
                  status === 'active'
                    ? 'border-[var(--line-strong)] bg-[var(--bg-subtle)]'
                    : 'border-[var(--line)] bg-transparent'
                }`}
              >
                <StepIcon status={status} index={i} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-sm font-medium ${
                        status === 'pending'
                          ? 'text-[var(--ink-muted)]'
                          : 'text-[var(--ink)]'
                      }`}
                    >
                      {step.label}
                    </span>
                    {status === 'active' && elapsed && (
                      <span className="rounded-full bg-[var(--card)] px-2 py-0.5 text-[0.65rem] font-medium text-[var(--ink-muted)]">
                        {elapsed}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
                      {detailText}
                    </p>
                    {detailElapsed && status === 'active' && progress.detail && (
                      <span className="rounded-full border border-[var(--line)] px-1.5 py-0.5 text-[0.6rem] font-medium text-[var(--ink-muted)]">
                        {detailElapsed}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-6 border-t border-[var(--line)] pt-4">
          <p className="text-xs text-[var(--ink-muted)]">
            Stuck? The background job may have crashed.
          </p>
          <GenerationModeSelect
            value={retryMode}
            onChange={setRetryMode}
            disabled={retrying}
            id="force-retry-mode"
            className="mt-3 sm:max-w-sm"
            trailing={
              <Button
                type="button"
                size="pill"
                variant="outline"
                onClick={handleForceRetry}
                disabled={retrying}
                className="shrink-0"
              >
                {retrying ? 'Retrying…' : 'Force retry'}
              </Button>
            }
          />
        </div>
      </div>
    </main>
  );
}

function StepIcon({
  status,
  index,
}: Readonly<{ status: 'done' | 'active' | 'pending'; index: number }>) {
  if (status === 'done') {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-[var(--ink)] text-[var(--cream)]"
      >
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8l3.5 3.5L13 5" />
        </svg>
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border-2 border-[var(--ink)] text-[var(--ink)]"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--ink)]" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border border-[var(--line)] text-[0.65rem] font-semibold text-[var(--ink-muted)]"
    >
      {index + 1}
    </span>
  );
}

function FailedState({
  video,
  error,
}: Readonly<{ video: StrapiVideo; error?: string }>) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    await clearSummaryFailure({ data: { videoId: video.youtubeVideoId } });
    await triggerSummaryGeneration({ data: { videoId: video.youtubeVideoId } });
    await router.invalidate();
    setRetrying(false);
  };

  return (
    <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-14">
      <div className="mx-auto max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
        <h1 className="display-title text-2xl text-[var(--ink)]">Generation failed</h1>
        <p className="mt-3 text-sm text-[var(--ink-soft)]">
          The AI model couldn't produce a summary for this video. Retry now, or check your
          Ollama daemon and model.
        </p>
        {error && (
          <p className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-left text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-center gap-2">
          <Button type="button" size="pill" onClick={handleRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    </main>
  );
}

function UnsharedState({ videoId }: Readonly<{ videoId: string }>) {
  return (
    <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-14">
      <div className="mx-auto max-w-md rounded-2xl border border-[var(--line)] bg-[var(--card)] p-10 text-center">
        <h1 className="display-title text-3xl text-[var(--ink)]">
          This video isn't in the knowledge base yet.
        </h1>
        <p className="mt-3 text-sm text-[var(--ink-soft)]">
          Share it from the new-post page to add it and generate the summary.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button asChild size="pill" variant="outline">
            <a
              href={`https://www.youtube.com/watch?v=${videoId}`}
              target="_blank"
              rel="noreferrer"
            >
              Watch on YouTube
            </a>
          </Button>
        </div>
      </div>
    </main>
  );
}

function RegenerateButton({ videoId }: Readonly<{ videoId: string }>) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<GenerationMode>('auto');

  const handleClick = async () => {
    if (running) return;
    if (
      !window.confirm(
        'Regenerate the summary? The old content stays if regeneration fails, and is replaced on success.',
      )
    ) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const result = await regenerateSummary({ data: { videoId, mode } });
      if (result.status === 'error') {
        setError(result.error);
        return;
      }
      await router.invalidate();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <GenerationModeSelect
        value={mode}
        onChange={setMode}
        disabled={running}
        id="regenerate-mode"
        className="w-full sm:w-80"
        trailing={
          <Button
            type="button"
            size="pill"
            variant="outline"
            onClick={handleClick}
            disabled={running}
            className="shrink-0"
          >
            {running ? 'Starting…' : 'Regenerate'}
          </Button>
        }
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

