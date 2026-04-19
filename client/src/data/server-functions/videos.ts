import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  createVideoService,
  fetchFeedService,
  fetchVideoByDocumentIdService,
  fetchVideoByVideoIdService,
  markSummaryFailedService,
  markSummaryPendingService,
  searchTagsService,
  updateSectionTimecodeService,
  updateVideoNotesService,
  type PaginatedVideos,
  type StrapiTag,
  type StrapiVideo,
} from '#/lib/services/videos';
import {
  fetchYouTubeMeta,
  generateVideoSummary,
  askAboutVideoService,
  readGenerationStep,
  type ChatMessage,
  type GenerationStep,
} from '#/lib/services/learning';
import {
  extractCitationsWithEvidence,
  isStoredIndex,
  type EvidenceCitation,
} from '#/lib/services/transcript';
import {
  CreateVideoInputSchema,
  GenerationModeSchema,
  extractYouTubeVideoId,
  parseTagInput,
  type GenerationMode,
} from '#/lib/validations/post';

// =============================================================================
// Feed
// =============================================================================

const FeedQuerySchema = z.object({
  page: z.number().int().min(1).max(1000).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  q: z.string().max(200).optional(),
  tag: z.string().max(80).optional(),
});

export const getFeed = createServerFn({ method: 'GET' })
  .inputValidator((data: z.input<typeof FeedQuerySchema>) => FeedQuerySchema.parse(data))
  .handler(async ({ data }): Promise<PaginatedVideos> => {
    return await fetchFeedService(data);
  });

// =============================================================================
// Single-video lookups
// =============================================================================

const VideoIdSchema = z.object({
  videoId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[\w-]+$/, 'Invalid video id'),
});

const DocumentIdSchema = z.object({ documentId: z.string().min(1) });

export const getVideoByDocumentId = createServerFn({ method: 'GET' })
  .inputValidator((data: { documentId: string }) => DocumentIdSchema.parse(data))
  .handler(async ({ data }): Promise<StrapiVideo | null> => {
    return await fetchVideoByDocumentIdService(data.documentId);
  });

export const getVideoByVideoId = createServerFn({ method: 'GET' })
  .inputValidator((data: { videoId: string }) => VideoIdSchema.parse(data))
  .handler(async ({ data }): Promise<StrapiVideo | null> => {
    return await fetchVideoByVideoIdService(data.videoId);
  });

// =============================================================================
// Share a video
//
// Extract video id → oEmbed metadata → create Video row → fire-and-forget
// the AI summary generation. By the time the user clicks through to
// /learn/$videoId the summary is usually done (or polling catches it).
// =============================================================================

const ShareVideoInputSchema = z.object({
  url: z.string().url(),
  caption: z.string().max(500).optional(),
  tags: z.string().max(240).optional(),
  mode: GenerationModeSchema.optional(),
});

export type ShareVideoResult =
  | { status: 'created'; video: StrapiVideo }
  | { status: 'exists'; video: StrapiVideo }
  | { status: 'error'; error: string };

// Shared in-memory set of videoIds for which a background generation is
// currently running. Previously split into two Sets (one for the share
// kickoff, one for trigger/regenerate) which let the SAME videoId run
// TWICE concurrently: the share flow kicked off gen A, then the learn
// page loader's trigger call didn't see gen A and kicked off gen B. Both
// writing to the same Video row, competing for GPU time, halving effective
// throughput. Single Set fixes it.
const generationInflight = new Set<string>();

function kickoffSummaryGeneration(videoId: string, mode?: GenerationMode) {
  if (generationInflight.has(videoId)) return;
  generationInflight.add(videoId);
  void (async () => {
    try {
      const result = await generateVideoSummary(videoId, { mode });
      if (!result.success) {
        console.error('[summary bg] failed', { videoId, error: result.error });
      }
    } catch (err) {
      // Last-resort catch: mark the Video row as failed so the UI flips out
      // of pending. Otherwise a crashed bg job leaves the row at
      // summaryStatus: 'pending' forever and the learn page polls forever.
      const message = err instanceof Error ? err.message : 'Generation crashed';
      console.error('[summary bg] exception', { videoId, err });
      const video = await fetchVideoByVideoIdService(videoId);
      if (video) await markSummaryFailedService(video.documentId);
      recentFailures.set(videoId, { error: message, at: Date.now() });
    } finally {
      generationInflight.delete(videoId);
    }
  })();
}

export const shareVideo = createServerFn({ method: 'POST' })
  .inputValidator((data: z.input<typeof ShareVideoInputSchema>) =>
    ShareVideoInputSchema.parse(data),
  )
  .handler(async ({ data }): Promise<ShareVideoResult> => {
    const videoId = extractYouTubeVideoId(data.url);
    if (!videoId) {
      return { status: 'error', error: "Doesn't look like a YouTube URL" };
    }

    const alreadyExists = await fetchVideoByVideoIdService(videoId);
    if (alreadyExists) return { status: 'exists', video: alreadyExists };

    const parsed = CreateVideoInputSchema.parse({
      videoId,
      url: data.url,
      caption: data.caption,
      tagNames: parseTagInput(data.tags ?? ''),
    });

    const meta = await fetchYouTubeMeta(videoId);

    const result = await createVideoService({
      videoId: parsed.videoId,
      url: parsed.url,
      caption: parsed.caption,
      tagNames: parsed.tagNames,
      videoTitle: meta.title,
      videoAuthor: meta.author,
      videoThumbnailUrl:
        meta.thumbnailUrl ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    });

    if (!result.success) {
      if (result.kind === 'exists') return { status: 'exists', video: result.video };

      // Race recovery — if the server dedupe check caught what our pre-check
      // missed, re-fetch and surface as 'exists' for clean redirect.
      if (/already exists/i.test(result.error)) {
        const recovered = await fetchVideoByVideoIdService(videoId);
        if (recovered) return { status: 'exists', video: recovered };
      }
      return { status: 'error', error: result.error };
    }

    kickoffSummaryGeneration(videoId, data.mode);
    return { status: 'created', video: result.video };
  });

// =============================================================================
// Summary lifecycle — trigger + clear for retry
// =============================================================================

export type TriggerResult =
  | { status: 'found'; video: StrapiVideo }
  | { status: 'started' }
  | { status: 'error'; error: string };

// `inflight` is an alias to the shared set — kept as a local name here
// for readability in the trigger/regenerate handlers below.
const inflight = generationInflight;
type RecentFailure = { error: string; at: number };
const recentFailures = new Map<string, RecentFailure>();
const FAILURE_TTL_MS = 5 * 60 * 1000;

function readRecentFailure(videoId: string): string | null {
  const entry = recentFailures.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.at > FAILURE_TTL_MS) {
    recentFailures.delete(videoId);
    return null;
  }
  return entry.error;
}

const TriggerInputSchema = VideoIdSchema.extend({
  mode: GenerationModeSchema.optional(),
});

export const triggerSummaryGeneration = createServerFn({ method: 'POST' })
  .inputValidator((data: z.input<typeof TriggerInputSchema>) =>
    TriggerInputSchema.parse(data),
  )
  .handler(async ({ data }): Promise<TriggerResult> => {
    const existing = await fetchVideoByVideoIdService(data.videoId);
    if (existing && existing.summaryStatus === 'generated') {
      recentFailures.delete(data.videoId);
      return { status: 'found', video: existing };
    }

    if (inflight.has(data.videoId)) return { status: 'started' };

    const previousError = readRecentFailure(data.videoId);
    if (previousError) return { status: 'error', error: previousError };

    inflight.add(data.videoId);
    void (async () => {
      try {
        const result = await generateVideoSummary(data.videoId, { mode: data.mode });
        if (!result.success) {
          recentFailures.set(data.videoId, { error: result.error, at: Date.now() });
          console.error('[bg generation] failed', {
            videoId: data.videoId,
            error: result.error,
          });
        } else {
          recentFailures.delete(data.videoId);
        }
      } catch (err) {
        // generateVideoSummary threw (vs. returning {success:false}). It
        // may not have reached its own markSummaryFailedService call, so
        // flip the DB row here — otherwise the UI polls a pending row
        // forever while the only evidence of failure lives in memory.
        const message = err instanceof Error ? err.message : 'Generation failed';
        recentFailures.set(data.videoId, { error: message, at: Date.now() });
        console.error('[bg generation] exception', { videoId: data.videoId, err });
        try {
          const row = await fetchVideoByVideoIdService(data.videoId);
          if (row) await markSummaryFailedService(row.documentId);
        } catch (markErr) {
          console.error('[bg generation] mark-failed itself failed', {
            videoId: data.videoId,
            markErr,
          });
        }
      } finally {
        inflight.delete(data.videoId);
      }
    })();

    return { status: 'started' };
  });

// Manually override a section's timecode — the escape hatch for AI drift
// that BM25 grounding doesn't fix. Scoped to the single section so edits
// don't race against other summary updates.
const UpdateSectionTimecodeSchema = z.object({
  documentId: z.string().min(1),
  sectionId: z.number().int().nonnegative(),
  timeSec: z.number().int().min(0).max(24 * 3600), // sanity: <= 24h
});

export const updateSectionTimecode = createServerFn({ method: 'POST' })
  .inputValidator((data: z.input<typeof UpdateSectionTimecodeSchema>) =>
    UpdateSectionTimecodeSchema.parse(data),
  )
  .handler(async ({ data }): Promise<{ success: true } | { success: false; error: string }> => {
    return await updateSectionTimecodeService(data);
  });

// Persist the user's markdown notes on a Video. Called from the Tiptap
// editor on the learn page (autosave on idle). The field is a Strapi
// `richtext` so the admin panel's built-in markdown editor also works
// as a manual fallback.
const UpdateVideoNotesSchema = z.object({
  documentId: z.string().min(1),
  notes: z.string().max(200_000),
});

export const updateVideoNotes = createServerFn({ method: 'POST' })
  .inputValidator((data: z.input<typeof UpdateVideoNotesSchema>) =>
    UpdateVideoNotesSchema.parse(data),
  )
  .handler(async ({ data }): Promise<{ success: true } | { success: false; error: string }> => {
    return await updateVideoNotesService(data);
  });

export const clearSummaryFailure = createServerFn({ method: 'POST' })
  .inputValidator((data: { videoId: string }) => VideoIdSchema.parse(data))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    recentFailures.delete(data.videoId);
    return { ok: true };
  });

// Manual regenerate — for videos that already have a summary but the user
// wants to re-run generation (e.g. after prompt changes or a mediocre result).
// Flips the Strapi row back to 'pending' and kicks off the same background
// job as the share flow. Safe to click while the old summary is on the row;
// fields are overwritten on success, preserved on failure.
export type RegenerateResult =
  | { status: 'started' }
  | { status: 'already_running' }
  | { status: 'error'; error: string };

const RegenerateInputSchema = z.object({
  videoId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[\w-]+$/),
  // Skip the transcript cache and re-fetch fresh from YouTube. Needed
  // when the uploader updated captions or the cached segments are bad.
  forceRefetch: z.boolean().optional(),
  mode: GenerationModeSchema.optional(),
});

export const regenerateSummary = createServerFn({ method: 'POST' })
  .inputValidator((data: z.input<typeof RegenerateInputSchema>) =>
    RegenerateInputSchema.parse(data),
  )
  .handler(async ({ data }): Promise<RegenerateResult> => {
    const video = await fetchVideoByVideoIdService(data.videoId);
    if (!video) {
      return { status: 'error', error: 'Video not found' };
    }
    if (inflight.has(data.videoId)) {
      return { status: 'already_running' };
    }

    // Clear any stale failure marker and flip the row to pending so the
    // loader sees a fresh pending state (not 'generated') while work runs.
    recentFailures.delete(data.videoId);
    const flip = await markSummaryPendingService(video.documentId);
    if (!flip.success) {
      return { status: 'error', error: flip.error };
    }

    inflight.add(data.videoId);
    void (async () => {
      try {
        const result = await generateVideoSummary(data.videoId, {
          forceRefetch: data.forceRefetch,
          mode: data.mode,
        });
        if (!result.success) {
          recentFailures.set(data.videoId, { error: result.error, at: Date.now() });
          console.error('[regenerate] failed', {
            videoId: data.videoId,
            error: result.error,
          });
        } else {
          recentFailures.delete(data.videoId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Regeneration failed';
        recentFailures.set(data.videoId, { error: message, at: Date.now() });
        console.error('[regenerate] exception', { videoId: data.videoId, err });
        try {
          const row = await fetchVideoByVideoIdService(data.videoId);
          if (row) await markSummaryFailedService(row.documentId);
        } catch (markErr) {
          console.error('[regenerate] mark-failed itself failed', { markErr });
        }
      } finally {
        inflight.delete(data.videoId);
      }
    })();

    return { status: 'started' };
  });

export type GenerationProgress = {
  step: GenerationStep | null;
  detail: string | null;
  elapsedMs: number | null;
  detailElapsedMs: number | null;
};

// POST (not GET) to sidestep any HTTP caching that would serve stale
// progress back to the UI while the background job keeps advancing. Also
// logs every read so we can spot-check "is the server returning fresh
// state on each poll tick" against what the UI shows.
export const getGenerationProgress = createServerFn({ method: 'POST' })
  .inputValidator((data: { videoId: string }) => VideoIdSchema.parse(data))
  .handler(async ({ data }): Promise<GenerationProgress> => {
    const current = readGenerationStep(data.videoId);
    if (!current) {
      return { step: null, detail: null, elapsedMs: null, detailElapsedMs: null };
    }
    // eslint-disable-next-line no-console
    console.log(
      `[${new Date().toISOString().slice(11, 23)}] [progress ${data.videoId}] ${current.step}${current.detail ? ` · ${current.detail}` : ''} (step +${Math.round(current.elapsedMs / 1000)}s, detail +${Math.round(current.detailElapsedMs / 1000)}s)`,
    );
    return {
      step: current.step,
      detail: current.detail,
      elapsedMs: current.elapsedMs,
      detailElapsedMs: current.detailElapsedMs,
    };
  });

// =============================================================================
// Chat about a video
// =============================================================================

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

const AskAboutVideoSchema = z.object({
  videoId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[\w-]+$/),
  messages: z.array(ChatMessageSchema).min(1).max(30),
});

export type AskAboutVideoResult =
  | { status: 'ok'; reply: string }
  | { status: 'not_ready' }
  | { status: 'error'; error: string };

export const askAboutVideo = createServerFn({ method: 'POST' })
  .inputValidator((data: z.input<typeof AskAboutVideoSchema>) =>
    AskAboutVideoSchema.parse(data),
  )
  .handler(async ({ data }): Promise<AskAboutVideoResult> => {
    const video = await fetchVideoByVideoIdService(data.videoId);
    if (!video || video.summaryStatus !== 'generated') return { status: 'not_ready' };

    const result = await askAboutVideoService(video, data.messages as ChatMessage[]);
    if (!result.success) return { status: 'error', error: result.error };
    return { status: 'ok', reply: result.data };
  });

// =============================================================================
// Chat response evidence
//
// Given a completed chat response text, returns every timecode citation the
// model produced alongside the actual transcript chunk that best grounds
// each one. The chat UI renders these as expandable accordions below the
// assistant message so the user can verify each citation against the real
// source text rather than trust a raw `[mm:ss]` chip.
// =============================================================================

const ChatEvidenceSchema = z.object({
  videoId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[\w-]+$/),
  responseText: z.string().min(1).max(50_000),
});

export const getChatResponseEvidence = createServerFn({ method: 'POST' })
  .inputValidator((data: z.input<typeof ChatEvidenceSchema>) =>
    ChatEvidenceSchema.parse(data),
  )
  .handler(async ({ data }): Promise<EvidenceCitation[]> => {
    const video = await fetchVideoByVideoIdService(data.videoId);
    if (!video || !isStoredIndex(video.transcriptSegments)) return [];
    return extractCitationsWithEvidence(
      data.responseText,
      video.transcriptSegments.bm25,
    );
  });

// =============================================================================
// Tag autocomplete
// =============================================================================

const TagSearchSchema = z.object({ q: z.string().max(40).default('') });

export const searchTags = createServerFn({ method: 'GET' })
  .inputValidator((data: z.input<typeof TagSearchSchema>) => TagSearchSchema.parse(data))
  .handler(async ({ data }): Promise<StrapiTag[]> => {
    return await searchTagsService(data.q);
  });
