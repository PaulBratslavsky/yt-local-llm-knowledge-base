import { STRAPI_URL, STRAPI_API_TOKEN } from '#/lib/env';

// Build request headers with the optional bearer token. Server-side only.
function strapiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (STRAPI_API_TOKEN) headers.Authorization = `Bearer ${STRAPI_API_TOKEN}`;
  return headers;
}

// Log failed fetches loudly — the previous silent-empty-array pattern made
// "nothing in feed" undiagnosable. Every non-ok response prints status +
// body so you can see exactly why.
async function handleFetchError(res: Response, tag: string): Promise<void> {
  const body = await res.text().catch(() => '');
  console.error(`[${tag}] strapi request failed`, {
    status: res.status,
    url: res.url,
    body: body.slice(0, 500),
  });
}

// =============================================================================
// Types
// =============================================================================

export type StrapiMedia = {
  url: string;
  alternativeText: string | null;
} | null;

export type StrapiTag = {
  id: number;
  documentId: string;
  name: string;
  slug: string;
};

export type StrapiTakeaway = {
  id: number;
  text: string;
};

export type StrapiSection = {
  id: number;
  timeSec: number | null;
  heading: string;
  body: string;
};

export type StrapiActionStep = {
  id: number;
  title: string;
  body: string;
};

// Transcript = the cached YouTube caption source-of-truth. 1:1 with Video,
// but lives on its own row so the fetch is resilient: if AI generation
// fails after the fetch, the Transcript survives and regen skips YouTube.
export type StrapiTranscriptSegment = {
  text: string;
  startMs: number;
  endMs?: number;
};

export type StrapiTranscript = {
  id: number;
  documentId: string;
  youtubeVideoId: string;
  title: string | null;
  author: string | null;
  thumbnailUrl: string | null;
  language: string | null;
  durationSec: number | null;
  rawSegments: StrapiTranscriptSegment[] | null;
  rawText: string | null;
  fetchedAt: string | null;
};

export type SummaryStatus = 'pending' | 'generated' | 'failed';

export type StrapiVideo = {
  id: number;
  documentId: string;
  youtubeVideoId: string;
  url: string;
  videoTitle: string | null;
  videoAuthor: string | null;
  videoThumbnailUrl: string | null;
  caption: string | null;
  notes: string | null;
  createdAt: string;
  tags: StrapiTag[] | null;
  summaryStatus: SummaryStatus;
  summaryTitle: string | null;
  summaryDescription: string | null;
  summaryOverview: string | null;
  summaryGeneratedAt: string | null;
  aiModel: string | null;
  transcriptSegments: unknown | null;
  keyTakeaways: StrapiTakeaway[] | null;
  sections: StrapiSection[] | null;
  actionSteps: StrapiActionStep[] | null;
  // 1:1 relation to Transcript (source of truth for caption data).
  // Null on pre-migration rows; populated on all freshly-generated videos.
  transcript: StrapiTranscript | null;
};

export type PaginatedVideos = {
  videos: StrapiVideo[];
  page: number;
  pageCount: number;
  total: number;
};

// =============================================================================
// Feed / search
// =============================================================================

export type FeedQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  tag?: string; // slug
};

function feedQueryParams({ page = 1, pageSize = 20, q, tag }: FeedQuery): URLSearchParams {
  const params = new URLSearchParams();
  // Keep the feed payload light. No component populate on the list view —
  // summary fields are only needed on the detail page.
  params.set('populate[tags]', 'true');
  params.set('sort', 'createdAt:desc');
  params.set('pagination[page]', String(page));
  params.set('pagination[pageSize]', String(pageSize));
  params.set('pagination[withCount]', 'true');

  const trimmed = q?.trim();
  if (trimmed) {
    params.set('filters[$or][0][videoTitle][$containsi]', trimmed);
    params.set('filters[$or][1][videoAuthor][$containsi]', trimmed);
    params.set('filters[$or][2][caption][$containsi]', trimmed);
    params.set('filters[$or][3][summaryTitle][$containsi]', trimmed);
  }

  if (tag) {
    params.set('filters[tags][slug][$eq]', tag);
  }

  return params;
}

export async function fetchFeedService(query: FeedQuery): Promise<PaginatedVideos> {
  const params = feedQueryParams(query);
  const res = await fetch(`${STRAPI_URL}/api/videos?${params.toString()}`, {
    headers: strapiHeaders(),
  });
  if (!res.ok) {
    await handleFetchError(res, 'fetchFeedService');
    return { videos: [], page: query.page ?? 1, pageCount: 0, total: 0 };
  }
  const json = (await res.json()) as {
    data?: StrapiVideo[];
    meta?: { pagination?: { page: number; pageCount: number; total: number } };
  };
  return {
    videos: json.data ?? [],
    page: json.meta?.pagination?.page ?? 1,
    pageCount: json.meta?.pagination?.pageCount ?? 0,
    total: json.meta?.pagination?.total ?? 0,
  };
}

// =============================================================================
// Single-video lookups
// =============================================================================

// Populate strategy for the detail page — everything, including the heavy
// components that the summary view needs.
function detailQueryParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set('populate[tags]', 'true');
  params.set('populate[keyTakeaways]', 'true');
  params.set('populate[sections]', 'true');
  params.set('populate[actionSteps]', 'true');
  params.set('populate[transcript]', 'true');
  return params;
}

export async function fetchVideoByDocumentIdService(
  documentId: string,
): Promise<StrapiVideo | null> {
  const res = await fetch(
    `${STRAPI_URL}/api/videos/${documentId}?${detailQueryParams().toString()}`,
    { headers: strapiHeaders() },
  );
  if (!res.ok) {
    await handleFetchError(res, 'fetchVideoByDocumentIdService');
    return null;
  }
  const json = (await res.json()) as { data?: StrapiVideo };
  return json.data ?? null;
}

export async function fetchVideoByVideoIdService(
  videoId: string,
): Promise<StrapiVideo | null> {
  const params = detailQueryParams();
  params.set('filters[youtubeVideoId][$eq]', videoId);
  params.set('pagination[pageSize]', '1');

  const res = await fetch(`${STRAPI_URL}/api/videos?${params.toString()}`, {
    headers: strapiHeaders(),
  });
  if (!res.ok) {
    await handleFetchError(res, 'fetchVideoByVideoIdService');
    return null;
  }
  const json = (await res.json()) as { data?: StrapiVideo[] };
  return json.data?.[0] ?? null;
}

// =============================================================================
// Create a video (with tag upsert)
// =============================================================================

export type CreateVideoServiceInput = {
  videoId: string;
  url: string;
  caption?: string;
  videoTitle?: string;
  videoAuthor?: string;
  videoThumbnailUrl?: string;
  tagNames: string[];
};

export type CreateVideoServiceResult =
  | { success: true; video: StrapiVideo }
  | { success: false; kind: 'exists'; video: StrapiVideo }
  | { success: false; kind: 'error'; error: string };

export async function createVideoService(
  input: CreateVideoServiceInput,
): Promise<CreateVideoServiceResult> {
  // Pre-check dedupe so we can return 'exists' without parsing Strapi
  // error strings. Server middleware catches races as a second line of
  // defense.
  const existing = await fetchVideoByVideoIdService(input.videoId);
  if (existing) return { success: false, kind: 'exists', video: existing };

  const tagDocumentIds: string[] = [];
  for (const raw of input.tagNames) {
    const existingTag = await findTagByNameService(raw);
    if (existingTag) {
      tagDocumentIds.push(existingTag.documentId);
      continue;
    }
    const created = await createTagService(raw);
    if (created) tagDocumentIds.push(created.documentId);
  }

  const body = {
    data: {
      youtubeVideoId: input.videoId,
      url: input.url,
      caption: input.caption,
      videoTitle: input.videoTitle,
      videoAuthor: input.videoAuthor,
      videoThumbnailUrl: input.videoThumbnailUrl,
      tags: tagDocumentIds,
      summaryStatus: 'pending' as SummaryStatus,
    },
  };

  const res = await fetch(`${STRAPI_URL}/api/videos`, {
    method: 'POST',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await handleFetchError(res, 'createVideoService');
    const err = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    return {
      success: false,
      kind: 'error',
      error: err.error?.message ?? `Strapi error ${res.status}`,
    };
  }
  const json = (await res.json()) as { data: StrapiVideo };
  return { success: true, video: json.data };
}

// =============================================================================
// Update a video (used by the summary-generation pipeline to land AI output)
// =============================================================================

export type UpdateVideoSummaryInput = {
  documentId: string;
  summaryTitle: string;
  summaryDescription: string;
  summaryOverview: string;
  aiModel: string;
  transcriptSegments?: unknown;
  keyTakeaways: Array<{ text: string }>;
  sections: Array<{ timeSec?: number; heading: string; body: string }>;
  actionSteps: Array<{ title: string; body: string }>;
};

export async function updateVideoSummaryService(
  input: UpdateVideoSummaryInput,
): Promise<{ success: true; video: StrapiVideo } | { success: false; error: string }> {
  const { documentId, ...rest } = input;
  const body = {
    data: {
      ...rest,
      summaryStatus: 'generated' as SummaryStatus,
      summaryGeneratedAt: new Date().toISOString(),
    },
  };

  const res = await fetch(`${STRAPI_URL}/api/videos/${documentId}`, {
    method: 'PUT',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await handleFetchError(res, 'updateVideoSummaryService');
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { success: false, error: err.error?.message ?? `Strapi error ${res.status}` };
  }
  const json = (await res.json()) as { data: StrapiVideo };
  return { success: true, video: json.data };
}

export async function markSummaryFailedService(documentId: string): Promise<void> {
  await fetch(`${STRAPI_URL}/api/videos/${documentId}`, {
    method: 'PUT',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { summaryStatus: 'failed' } }),
  }).catch(() => {
    // Best-effort — the chat UI will show the error via its own retry path.
  });
}

// Update the free-form markdown notes on a Video row. The user's personal
// thoughts / annotations layered on top of the AI summary — persisted so
// they survive regenerations and show in the Strapi admin for inspection.
export async function updateVideoNotesService(input: {
  documentId: string;
  notes: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const res = await fetch(`${STRAPI_URL}/api/videos/${input.documentId}`, {
    method: 'PUT',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { notes: input.notes } }),
  });
  if (!res.ok) {
    await handleFetchError(res, 'updateVideoNotesService');
    return { success: false, error: `Strapi error ${res.status}` };
  }
  return { success: true };
}

// Manually set the timeSec of a single section on a Video row. Strapi's
// repeatable-component semantics mean we have to PUT the whole sections
// array back with the one field updated. Keeps heading/body untouched.
export async function updateSectionTimecodeService(input: {
  documentId: string;
  sectionId: number;
  timeSec: number;
}): Promise<{ success: true } | { success: false; error: string }> {
  // Fetch current sections so we can resend the array with one edit.
  const res = await fetch(
    `${STRAPI_URL}/api/videos/${input.documentId}?${detailQueryParams().toString()}`,
    { headers: strapiHeaders() },
  );
  if (!res.ok) {
    await handleFetchError(res, 'updateSectionTimecodeService.fetch');
    return { success: false, error: `Strapi read error ${res.status}` };
  }
  const json = (await res.json()) as { data?: StrapiVideo };
  const video = json.data;
  if (!video) return { success: false, error: 'Video not found' };

  const currentSections = video.sections ?? [];
  let matched = false;
  const nextSections = currentSections.map((s) => {
    if (s.id !== input.sectionId) return { heading: s.heading, body: s.body, timeSec: s.timeSec };
    matched = true;
    return { heading: s.heading, body: s.body, timeSec: input.timeSec };
  });
  if (!matched) return { success: false, error: 'Section not found on this video' };

  const putRes = await fetch(`${STRAPI_URL}/api/videos/${input.documentId}`, {
    method: 'PUT',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { sections: nextSections } }),
  });
  if (!putRes.ok) {
    await handleFetchError(putRes, 'updateSectionTimecodeService.put');
    return { success: false, error: `Strapi write error ${putRes.status}` };
  }
  return { success: true };
}

// Flip a completed (or failed) summary back to 'pending' so the generation
// pipeline treats it as fresh work. Intentionally does NOT clear the old
// summary fields — if regeneration fails, the previous content is still on
// the row and can be recovered by clearing the pending flag.
export async function markSummaryPendingService(
  documentId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const res = await fetch(`${STRAPI_URL}/api/videos/${documentId}`, {
    method: 'PUT',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { summaryStatus: 'pending' } }),
  });
  if (!res.ok) {
    await handleFetchError(res, 'markSummaryPendingService');
    return { success: false, error: `Strapi error ${res.status}` };
  }
  return { success: true };
}

// =============================================================================
// Transcript (cached YouTube caption source)
//
// Transcripts live on their own collection keyed by youtubeVideoId. The
// generation pipeline looks one up before hitting YouTube; if found, it
// reuses the cached segments. If the AI generation crashes downstream,
// the Transcript remains saved — next retry skips the YouTube fetch.
// =============================================================================

export async function fetchTranscriptByVideoIdService(
  videoId: string,
): Promise<StrapiTranscript | null> {
  const params = new URLSearchParams();
  params.set('filters[youtubeVideoId][$eq]', videoId);
  params.set('pagination[pageSize]', '1');

  const res = await fetch(`${STRAPI_URL}/api/transcripts?${params.toString()}`, {
    headers: strapiHeaders(),
  });
  if (!res.ok) {
    await handleFetchError(res, 'fetchTranscriptByVideoIdService');
    return null;
  }
  const json = (await res.json()) as { data?: StrapiTranscript[] };
  return json.data?.[0] ?? null;
}

export type CreateTranscriptServiceInput = {
  youtubeVideoId: string;
  title?: string;
  author?: string;
  thumbnailUrl?: string;
  language?: string;
  durationSec?: number | null;
  rawSegments: StrapiTranscriptSegment[];
  rawText: string;
};

export async function createTranscriptService(
  input: CreateTranscriptServiceInput,
): Promise<{ success: true; transcript: StrapiTranscript } | { success: false; error: string }> {
  const body = {
    data: {
      ...input,
      fetchedAt: new Date().toISOString(),
    },
  };
  const res = await fetch(`${STRAPI_URL}/api/transcripts`, {
    method: 'POST',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await handleFetchError(res, 'createTranscriptService');
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { success: false, error: err.error?.message ?? `Strapi error ${res.status}` };
  }
  const json = (await res.json()) as { data: StrapiTranscript };
  return { success: true, transcript: json.data };
}

// Attach a Transcript to a Video via the 1:1 relation. Used after the
// Transcript row is created so subsequent reads of the Video populate it.
export async function linkVideoToTranscriptService(
  videoDocumentId: string,
  transcriptDocumentId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const res = await fetch(`${STRAPI_URL}/api/videos/${videoDocumentId}`, {
    method: 'PUT',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { transcript: transcriptDocumentId } }),
  });
  if (!res.ok) {
    await handleFetchError(res, 'linkVideoToTranscriptService');
    return { success: false, error: `Strapi error ${res.status}` };
  }
  return { success: true };
}

// =============================================================================
// Tags
// =============================================================================

export async function findTagByNameService(rawName: string): Promise<StrapiTag | null> {
  const name = rawName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name) return null;
  const params = new URLSearchParams();
  params.set('filters[name][$eq]', name);
  params.set('pagination[pageSize]', '1');

  const res = await fetch(`${STRAPI_URL}/api/tags?${params.toString()}`, {
    headers: strapiHeaders(),
  });
  if (!res.ok) {
    await handleFetchError(res, 'findTagByNameService');
    return null;
  }
  const json = (await res.json()) as { data?: StrapiTag[] };
  return json.data?.[0] ?? null;
}

export async function searchTagsService(query: string, limit = 8): Promise<StrapiTag[]> {
  const q = query.trim().toLowerCase();
  const params = new URLSearchParams();
  if (q) params.set('filters[name][$containsi]', q);
  params.set('sort', 'name:asc');
  params.set('pagination[pageSize]', String(limit));

  const res = await fetch(`${STRAPI_URL}/api/tags?${params.toString()}`, {
    headers: strapiHeaders(),
  });
  if (!res.ok) {
    await handleFetchError(res, 'searchTagsService');
    return [];
  }
  const json = (await res.json()) as { data?: StrapiTag[] };
  return json.data ?? [];
}

async function createTagService(name: string): Promise<StrapiTag | null> {
  const res = await fetch(`${STRAPI_URL}/api/tags`, {
    method: 'POST',
    headers: strapiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { name } }),
  });
  if (!res.ok) {
    await handleFetchError(res, 'createTagService');
    return null;
  }
  const json = (await res.json()) as { data: StrapiTag };
  return json.data;
}

// =============================================================================
// Asset URL helper
// =============================================================================

export const strapiAssetUrl = (path: string | null | undefined) => {
  if (!path) return null;
  if (path.startsWith('data:') || path.startsWith('http') || path.startsWith('//')) {
    return path;
  }
  return `${STRAPI_URL}${path}`;
};
