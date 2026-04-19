import { chat } from '@tanstack/ai';
import { createOllamaChat } from '@tanstack/ai-ollama';
import { z } from 'zod';
import {
  createTranscriptService,
  fetchTranscriptByVideoIdService,
  fetchVideoByVideoIdService,
  linkVideoToTranscriptService,
  markSummaryFailedService,
  updateVideoSummaryService,
  type StrapiTranscript,
  type StrapiVideo,
} from '#/lib/services/videos';
import {
  buildBM25Index,
  chunkForRetrieval,
  chunkForSummary,
  cleanTranscript,
  estimateTokens,
  findEvidenceForQuote,
  isStoredIndex,
  makeSectionContextualizer,
  prepareSegmentedTranscript,
  searchBM25,
  searchBM25MultiQuery,
  type PreparedTranscript,
  type StoredTranscriptIndex,
  type TimedTextSegment,
  type TranscriptChunk,
} from '#/lib/services/transcript';
import { withRetry } from '#/lib/retry';
import { fetchYouTubeTranscript } from '#/lib/services/youtube-transcript';
import {
  MAP_CONCURRENCY,
  OLLAMA_HOST,
  OLLAMA_MODEL as SUMMARY_MODEL,
  OLLAMA_CHAT_MODEL as CHAT_MODEL,
  TRANSCRIPT_PROXY_URL,
} from '#/lib/env';

// TanStack AI Ollama adapters. Two separate adapters because SUMMARY_MODEL
// and CHAT_MODEL can differ (you might want a bigger model for summaries
// and a faster one for chat). Each one keeps its own HTTP client.
const ollamaAdapter = createOllamaChat(SUMMARY_MODEL, OLLAMA_HOST);
const ollamaAdapterChat = createOllamaChat(CHAT_MODEL, OLLAMA_HOST);

type ServiceResult<T> = { success: true; data: T } | { success: false; error: string };

// Server-side progress logging. Lands in the terminal running `yarn dev`.
// Keep output single-line + structured so it greps well and you can see a
// whole generation run at a glance without toggling log levels.
function logPhase(
  videoId: string,
  phase: string,
  extra?: Record<string, unknown>,
) {
  const ts = new Date().toISOString().slice(11, 23);
  const body = extra ? ` ${JSON.stringify(extra)}` : '';
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [summary ${videoId}] ${phase}${body}`);
}

function ms(start: number): string {
  return `${Math.round(performance.now() - start)}ms`;
}

// -----------------------------------------------------------------------------
// Transcript fetch (self-contained — uses youtubei.js directly against
// YouTube's public caption tracks; no external service dependency).
// -----------------------------------------------------------------------------

type TranscriptData = {
  transcript: string;
  upstreamTitle?: string;
  language: string;
  videoId: string;
  // Real video duration in seconds as returned by youtubei.js. `null` on
  // the rare case it couldn't be resolved — chunkers then fall back to the
  // 150-wpm estimate.
  durationSec: number | null;
  // Caption segments with millisecond-precise start times. Preserved so
  // chunkers can assign real `timeSec` values instead of linear-interp
  // estimates. `null` means we never got them (old pipeline path).
  segments: TimedTextSegment[] | null;
  // Derived in-memory from `segments` in the orchestrator. Not persisted.
  // When present, downstream chunkers use it to pull exact timecodes per
  // word; when absent they fall back to linear-interp math.
  prepared?: PreparedTranscript | null;
};

async function fetchTranscript(videoId: string): Promise<ServiceResult<TranscriptData>> {
  const started = performance.now();
  logPhase(videoId, 'transcript → fetching', {
    source: 'youtubei.js',
    proxy: TRANSCRIPT_PROXY_URL ? 'on' : 'off',
  });

  try {
    const result = await withRetry(
      () => fetchYouTubeTranscript(videoId, { proxyUrl: TRANSCRIPT_PROXY_URL }),
      {
        attempts: 3,
        onRetry: (err, attempt, delayMs) => {
          const cause = err instanceof Error ? err.message : 'network error';
          logPhase(videoId, `transcript ↻ retry ${attempt}/2 in ${delayMs}ms`, {
            cause,
          });
        },
      },
    );
    logPhase(videoId, 'transcript ✓ fetched', {
      chars: result.fullTranscript.length,
      segments: result.segments.length,
      durationSec: result.durationSec,
      took: ms(started),
    });
    return {
      success: true,
      data: {
        transcript: result.fullTranscript,
        upstreamTitle: result.title,
        language: 'en',
        videoId,
        durationSec: result.durationSec,
        // Map youtubei.js segment shape → our in-pipeline shape so
        // transcript.ts doesn't import from the YouTube-specific module.
        segments: result.segments.map((s) => ({
          text: s.text,
          startMs: s.start,
          endMs: s.end,
        })),
      },
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : 'unknown error';
    logPhase(videoId, 'transcript ✗ failed', { cause, took: ms(started) });
    return {
      success: false,
      error: `Couldn't fetch transcript: ${cause}`,
    };
  }
}

// Build a `TranscriptData` from a persisted Strapi Transcript row. No
// network call — this is the fast-path for every regeneration after the
// initial share (once a Transcript is saved, we never hit YouTube again
// unless forceRefetch is passed).
async function loadTranscriptFromStrapi(
  videoId: string,
  row: StrapiTranscript,
): Promise<ServiceResult<TranscriptData>> {
  const segments: TimedTextSegment[] = (row.rawSegments ?? []).map((s) => ({
    text: s.text,
    startMs: s.startMs,
    endMs: s.endMs,
  }));
  logPhase(videoId, 'transcript ✓ loaded from Strapi', {
    segments: segments.length,
    durationSec: row.durationSec,
    transcriptDocumentId: row.documentId,
  });
  const transcript = row.rawText ?? segments.map((s) => s.text).join(' ');
  return {
    success: true,
    data: {
      transcript,
      upstreamTitle: row.title ?? undefined,
      language: row.language ?? 'en',
      videoId,
      durationSec: row.durationSec ?? null,
      segments,
    },
  };
}

// -----------------------------------------------------------------------------
// YouTube oEmbed (no API key)
// -----------------------------------------------------------------------------

type OEmbedResponse = {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
};

export type VideoMeta = {
  title?: string;
  author?: string;
  thumbnailUrl?: string;
};

export async function fetchYouTubeMeta(videoId: string): Promise<VideoMeta> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const json = (await res.json()) as OEmbedResponse;
    return {
      title: json.title,
      author: json.author_name,
      thumbnailUrl: json.thumbnail_url,
    };
  } catch {
    return {};
  }
}

// (Duration now comes from `fetchYouTubeTranscript` via `info.basic_info.duration`
// — no separate HTML scrape needed.)

// -----------------------------------------------------------------------------
// AI summary generation
// -----------------------------------------------------------------------------

const SummarySchema = z.object({
  title: z
    .string()
    .describe('Short punchy title for the summary. MAX 200 characters. Not a sentence.'),
  description: z
    .string()
    .describe(
      'One-sentence subtitle describing what the viewer will learn. MAX 500 characters.',
    ),
  overview: z
    .string()
    .describe(
      'Markdown TL;DR — one or two paragraphs. Do NOT duplicate the key takeaways or sections here.',
    ),
  keyTakeaways: z
    .array(z.object({ text: z.string() }))
    .describe(
      '3 to 7 punchy bullets, ONE SHORT SENTENCE EACH (MAX 280 characters, hard limit). No markdown. Each bullet is a single idea, not a paragraph.',
    ),
  sections: z
    .array(
      z.object({
        heading: z
          .string()
          .describe('Short section heading. MAX 200 characters.'),
        body: z
          .string()
          .describe(
            'Markdown body of the section. MAX 2000 characters. Focus on what was said in this section. Do NOT emit timecodes — they are added deterministically after generation.',
          ),
      }),
    )
    .min(2)
    .max(15)
    .describe(
      'Sections capturing narrative beats of the video, IN CHRONOLOGICAL ORDER from the start to the end of the video. The FIRST section must cover opening content (near 0:00); the LAST section must cover content near the end of the video\'s duration. Sections in between space evenly across the timeline. Target ~1 section per 10 minutes of duration. Break multi-part topics into SEPARATE sections, one per part (e.g., "Three Stages: Discovery, Authentication, Communication" = THREE sections, not one section with three bullets). Prefer shorter, more granular sections over one long one. Minimum 2, maximum 15.',
    ),
  actionSteps: z
    .array(
      z.object({
        title: z
          .string()
          .describe('Verb-led short title. MAX 120 characters.'),
        body: z.string().describe('Step detail. MAX 600 characters.'),
      }),
    )
    .describe('2 to 5 concrete steps the reader can follow this week.'),
});

export type GeneratedSummary = z.infer<typeof SummarySchema>;

// Strapi component/field limits. Must match:
//   - Video schema:                summaryTitle 200, summaryDescription 500
//   - components/content/*.json:   takeaway.text 280, section.heading 200,
//                                  section.body 2000, action-step.title 120,
//                                  action-step.body 600
// The Zod schema *describes* these limits so the model usually respects
// them, but local models drift. We clamp on the client before saving so a
// single long takeaway doesn't fail the entire generation run — Strapi
// returns 400 on any violation and rejects the whole document.
const LIMITS = {
  summaryTitle: 200,
  summaryDescription: 500,
  takeawayText: 280,
  sectionHeading: 200,
  sectionBody: 2000,
  actionStepTitle: 120,
  actionStepBody: 600,
} as const;

// Truncate on a word boundary with an ellipsis if possible, hard-cut
// otherwise. Keeps the tail readable instead of chopping mid-word.
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max - 1); // leave room for "…"
  const lastSpace = window.lastIndexOf(' ');
  const boundary = lastSpace > max * 0.6 ? lastSpace : window.length;
  return `${window.slice(0, boundary).trimEnd()}…`;
}

function sanitizeSummary(
  videoId: string,
  raw: GeneratedSummary,
): GeneratedSummary {
  const overflows: string[] = [];
  const note = (field: string, was: number, max: number) => {
    overflows.push(`${field} ${was}→${max}`);
  };

  const title = raw.title.length > LIMITS.summaryTitle
    ? (note('title', raw.title.length, LIMITS.summaryTitle),
      clamp(raw.title, LIMITS.summaryTitle))
    : raw.title;
  const description = raw.description.length > LIMITS.summaryDescription
    ? (note('description', raw.description.length, LIMITS.summaryDescription),
      clamp(raw.description, LIMITS.summaryDescription))
    : raw.description;

  const keyTakeaways = raw.keyTakeaways.map((t, i) => {
    if (t.text.length <= LIMITS.takeawayText) return t;
    note(`keyTakeaways[${i}]`, t.text.length, LIMITS.takeawayText);
    return { text: clamp(t.text, LIMITS.takeawayText) };
  });

  const sections = raw.sections.map((s, i) => {
    const heading = s.heading.length > LIMITS.sectionHeading
      ? (note(`sections[${i}].heading`, s.heading.length, LIMITS.sectionHeading),
        clamp(s.heading, LIMITS.sectionHeading))
      : s.heading;
    const body = s.body.length > LIMITS.sectionBody
      ? (note(`sections[${i}].body`, s.body.length, LIMITS.sectionBody),
        clamp(s.body, LIMITS.sectionBody))
      : s.body;
    return { ...s, heading, body };
  });

  const actionSteps = raw.actionSteps.map((a, i) => {
    const t = a.title.length > LIMITS.actionStepTitle
      ? (note(`actionSteps[${i}].title`, a.title.length, LIMITS.actionStepTitle),
        clamp(a.title, LIMITS.actionStepTitle))
      : a.title;
    const b = a.body.length > LIMITS.actionStepBody
      ? (note(`actionSteps[${i}].body`, a.body.length, LIMITS.actionStepBody),
        clamp(a.body, LIMITS.actionStepBody))
      : a.body;
    return { title: t, body: b };
  });

  if (overflows.length > 0) {
    logPhase(videoId, 'ai ↳ clamped over-length fields before save', {
      overflows,
    });
  }

  return {
    ...raw,
    title,
    description,
    keyTakeaways,
    sections,
    actionSteps,
  };
}

// Single-pass budget. If the cleaned transcript fits within this many tokens
// Lowered from 25K → 15K: at 25K, 100-minute videos (~22K tokens) squeezed
// into single-pass with <10K headroom for system prompt + structured output
// against num_ctx=32768, producing shallow sections. At 15K the cutover sits
// around ~60 minutes, which map-reduce handles with more coherent per-section
// attention.
const SINGLE_PASS_TOKEN_BUDGET = 15_000;

const SUMMARY_SYSTEM = [
  'You summarize YouTube videos for a personal knowledge base, producing structured notes someone can act on instead of rewatching.',
  'Be specific and evidence-oriented. Avoid marketing fluff, generic advice, and sentence-length filler.',
  '',
  'IMPORTANT — Do NOT emit timecodes. Leave `section.timeSec` unset (omit the field). Do not write `[mm:ss]` or `(mm:ss)` anywhere in section headings or bodies. Timecodes are recovered deterministically after your output via a transcript-match pass — if you try to produce them yourself they will be discarded.',
  '',
  'SECTION COVERAGE — sections must span the video from start to finish:',
  ' • First section = content near the start of the video.',
  ' • Last section = content near the end of the video.',
  ' • Intermediate sections space evenly along the timeline.',
  ' • Break multi-stage/multi-step topics into SEPARATE sections (one per step), not one section with nested bullets.',
  '',
  'Focus on: accurate heading that captures the section topic, and body prose that describes what was said (using the speaker\'s own terminology where possible — do not invent product, plugin, or person names).',
  '',
  'Action steps must be concrete and doable this week, not abstract.',
  'CRITICAL — Do NOT invent implementation details in action steps. Only reference tools, languages, libraries, products, or configurations the speaker explicitly named in the transcript. If the video only mentions a concept vaguely (e.g., "you could build an extension"), the action step should be phrased as research/exploration ("Research how X works as described by the speaker"), NOT as specific implementation ("Build a TypeScript module that hooks into Y"). Confabulated specifics make the action steps look authoritative when they are actually guesses — that undermines trust.',
].join('\n');

async function generateSummarySinglePass(
  transcript: TranscriptData,
  meta: VideoMeta,
): Promise<ServiceResult<GeneratedSummary>> {
  const displayTitle = meta.title ?? transcript.upstreamTitle;
  const started = performance.now();
  setGenerationStep(transcript.videoId, 'ai', 'single-pass');
  logPhase(transcript.videoId, 'ai → single-pass summary', {
    model: SUMMARY_MODEL,
    transcriptChars: transcript.transcript.length,
    estTokens: estimateTokens(transcript.transcript),
  });

  try {
    // TanStack AI: `chat({ outputSchema })` activates Ollama's native JSON
    // mode via the adapter, returns the parsed zod-validated object.
    //
    // Note: we DELIBERATELY pass the plain cleaned transcript here, not
    // an `annotateWithTimecodes`-annotated version. The system prompt
    // tells the model not to emit timecodes (they're recovered
    // deterministically via BM25 after generation), so injecting
    // `[mm:ss]` markers into the prompt just inflates token count for
    // zero benefit. Net effect: noticeably faster inference on long
    // transcripts.
    const userPrompt = [
      displayTitle ? `Video title: ${displayTitle}` : null,
      meta.author ? `Channel: ${meta.author}` : null,
      transcript.durationSec
        ? `Video duration: ${formatTimecode(transcript.durationSec)}. Target ~1 section per 10 minutes of video, and make sure to cover content from the LAST portion of the video, not just the opening.`
        : null,
      '',
      'Transcript:',
      transcript.transcript,
    ]
      .filter(Boolean)
      .join('\n');

    // TanStack AI: `chat({ outputSchema })` activates Ollama's native
    // JSON-mode (format: <jsonSchema>) via the adapter and returns the
    // parsed, zod-validated object directly. Same constraint-decoding
    // reliability as our previous @ai-sdk/openai + /v1 path, one fewer
    // hop (native Ollama client vs OpenAI-compat shim).
    //
    // systemPrompts workaround: @tanstack/ai-ollama@0.6.6 silently drops
    // the `systemPrompts` option — we prepend a system-role message
    // instead, which the adapter passes through to Ollama as expected.
    const object = (await withRetry(
      () =>
        chat({
          adapter: ollamaAdapter,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: userPrompt },
          ] as never,
          outputSchema: SummarySchema,
          // Low temp for summarization: cuts confabulated specifics in
          // action steps / section bodies. Ollama default is 1.0, which
          // is great for chat but invites creative drift in structured
          // tasks where we want grounded prose.
          temperature: 0.3,
        }),
      {
        attempts: 2,
        onRetry: (err, attempt, delayMs) => {
          logPhase(transcript.videoId, `ai ↻ single-pass retry ${attempt}/1 in ${delayMs}ms`, {
            cause: err instanceof Error ? err.message : 'unknown',
          });
        },
      },
    )) as GeneratedSummary;
    logPhase(transcript.videoId, 'ai ✓ single-pass summary', {
      took: ms(started),
      sections: object.sections?.length ?? 0,
      takeaways: object.keyTakeaways?.length ?? 0,
      actionSteps: object.actionSteps?.length ?? 0,
    });
    return { success: true, data: object as GeneratedSummary };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI generation failed';
    logPhase(transcript.videoId, 'ai ✗ single-pass failed', {
      error: message,
      took: ms(started),
    });
    return { success: false, error: message };
  }
}

// Map-reduce summary for long transcripts:
//   MAP  → each chunk gets a plain-text bulleted notes pass with rough
//          timecodes at the front (cheap, runs in sequence to avoid KV
//          thrash on a single local model).
//   REDUCE → concat all partial notes, run structured `generateObject` once
//          against that much smaller document to produce the final schema.
// Map-step concurrency. Pair this with `OLLAMA_NUM_PARALLEL` on the Ollama
// server (≥ MAP_CONCURRENCY) — Ollama serves one request per slot, so extra
// parallelism here just queues if the server isn't sized for it.
//
// Default is 1 (safe on any laptop). Bump to 2-4 when you have RAM
// headroom: each extra slot adds ~3GB for KV cache on an 8B model at
// num_ctx=32768. On a 24GB M4 with Chrome/editor/etc. open, 2 can push
// you into swap and end up slower. On a 48GB+ Mac, 2-3 is safe.
// (Resolved + clamped to [1,4] in `#/lib/env`.)

async function generateSummaryMapReduce(
  transcript: TranscriptData,
  meta: VideoMeta,
): Promise<ServiceResult<GeneratedSummary>> {
  const runStart = performance.now();
  // Prefer segment-aware chunking so the map step's per-window timecodes
  // — echoed back by the reduce step into section `timeSec` values — are
  // real caption offsets, not linear-interp estimates.
  const chunks = chunkForSummary(
    transcript.prepared ?? transcript.transcript,
    transcript.durationSec,
  );
  logPhase(transcript.videoId, 'ai → map-reduce summary', {
    model: SUMMARY_MODEL,
    chunks: chunks.length,
    transcriptChars: transcript.transcript.length,
    concurrency: MAP_CONCURRENCY,
  });

  // Worker-pool pattern: keep MAP_CONCURRENCY map calls in-flight at any
  // time. Results are written by index into `partialNotes` so the reduce
  // step always sees windows in chronological order regardless of finish
  // order. If any chunk fails after retries, the promise rejects and the
  // outer try/catch aborts the run — other in-flight chunks continue but
  // their output is discarded.
  const partialNotes: string[] = new Array(chunks.length);

  // Track aggregate progress across parallel workers. The UI label shows
  // "map X/N done · K running" instead of a single chunk index — honest
  // about parallelism, and the count actually advances even when only
  // completions matter to the viewer.
  let completedCount = 0;
  let inFlightCount = 0;
  const updateAggregateLabel = () => {
    const runningHint =
      inFlightCount > 0 ? ` · ${inFlightCount} running` : '';
    setGenerationStep(
      transcript.videoId,
      'ai',
      `map ${completedCount}/${chunks.length} done${runningHint}`,
    );
  };

  const processChunk = async (i: number): Promise<void> => {
    const chunk = chunks[i];
    const mapStart = performance.now();
    inFlightCount += 1;
    updateAggregateLabel();
    logPhase(transcript.videoId, `ai → map chunk ${i + 1}/${chunks.length}`, {
      startSec: chunk.timeSec,
      chars: chunk.text.length,
    });

    const mapSystem = [
      'You read one window of a YouTube transcript and produce concise bullet notes on what was said.',
      'Keep bullets factual, evidence-led, and specific — no marketing fluff.',
      'Do not emit timecodes. Do not speculate beyond the window. Ignore anything not actually said.',
    ].join('\n');
    const cleanChunkText = chunk.text.replace(
      /\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g,
      '',
    );
    const mapUser = ['Transcript window:', cleanChunkText].join('\n');

    const text = (await withRetry(
      () =>
        chat({
          adapter: ollamaAdapter,
          messages: [
            { role: 'system', content: mapSystem },
            { role: 'user', content: mapUser },
          ] as never,
          stream: false,
        }),
      {
        attempts: 2,
        onRetry: (err, attempt, delayMs) => {
          logPhase(
            transcript.videoId,
            `ai ↻ map chunk ${i + 1}/${chunks.length} retry ${attempt}/1 in ${delayMs}ms`,
            { cause: err instanceof Error ? err.message : 'unknown' },
          );
        },
      },
    )) as string;
    partialNotes[i] = `## Window ${i + 1} — starts at ~${formatTimecode(chunk.timeSec)}\n${text.trim()}`;
    completedCount += 1;
    inFlightCount -= 1;
    updateAggregateLabel();
    logPhase(transcript.videoId, `ai ✓ map chunk ${i + 1}/${chunks.length}`, {
      took: ms(mapStart),
      outChars: text.length,
      progress: `${completedCount}/${chunks.length}`,
    });
  };

  // Shared cursor across worker promises. `cursor++` is atomic in JS's
  // single-threaded event loop — no locking needed.
  let cursor = 0;
  const workers = Array.from({ length: MAP_CONCURRENCY }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= chunks.length) return;
      await processChunk(i);
    }
  });
  try {
    await Promise.all(workers);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'map step failed';
    logPhase(transcript.videoId, 'ai ✗ map step failed', {
      error: message,
    });
    return { success: false, error: `Map step failed: ${message}` };
  }

  const reduceStart = performance.now();
  setGenerationStep(transcript.videoId, 'ai', 'synthesize final summary');
  logPhase(transcript.videoId, 'ai → reduce (synthesize final schema)', {
    partialNotesChars: partialNotes.join('\n\n').length,
  });

  const displayTitle = meta.title ?? transcript.upstreamTitle;
  try {
    const reduceUser = [
      displayTitle ? `Video title: ${displayTitle}` : null,
      meta.author ? `Channel: ${meta.author}` : null,
      transcript.durationSec
        ? `Video duration: ${formatTimecode(transcript.durationSec)}.`
        : null,
      '',
      `You are summarizing a ${transcript.durationSec ? formatTimecode(transcript.durationSec) + '-long ' : ''}video from per-window bullet notes (each window covers a distinct portion of the video).`,
      `CRITICAL: Your sections MUST cover the ENTIRE video — including the FINAL windows, not just the opening topics. If you see ${partialNotes.length} windows of notes, produce sections that collectively reference all of them. A 90-minute video typically needs 8-10 sections, a 60-minute video 5-7. Do not stop at half the video.`,
      'Synthesize these notes into the final structured summary. Ignore any timecodes in the notes — they are added deterministically after your output.',
      '',
      'Window notes:',
      partialNotes.join('\n\n'),
    ]
      .filter(Boolean)
      .join('\n');

    const object = (await withRetry(
      () =>
        chat({
          adapter: ollamaAdapter,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: reduceUser },
          ] as never,
          outputSchema: SummarySchema,
          // Same low-temp rationale as the single-pass call: structured
          // output + grounding-over-creativity.
          temperature: 0.3,
        }),
      {
        attempts: 2,
        onRetry: (err, attempt, delayMs) => {
          logPhase(transcript.videoId, `ai ↻ reduce retry ${attempt}/1 in ${delayMs}ms`, {
            cause: err instanceof Error ? err.message : 'unknown',
          });
        },
      },
    )) as GeneratedSummary;

    logPhase(transcript.videoId, 'ai ✓ reduce synthesized', {
      took: ms(reduceStart),
      totalTook: ms(runStart),
      sections: object.sections?.length ?? 0,
      takeaways: object.keyTakeaways?.length ?? 0,
      actionSteps: object.actionSteps?.length ?? 0,
    });
    return { success: true, data: object };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'reduce step failed';
    logPhase(transcript.videoId, 'ai ✗ reduce failed', {
      error: message,
      took: ms(reduceStart),
    });
    return { success: false, error: `Reduce step failed: ${message}` };
  }
}

export type GenerationMode = 'auto' | 'single' | 'mapreduce';

async function generateSummaryWithAI(
  transcript: TranscriptData,
  meta: VideoMeta,
  mode: GenerationMode = 'auto',
): Promise<ServiceResult<GeneratedSummary>> {
  const tokens = estimateTokens(transcript.transcript);

  if (mode === 'single') {
    logPhase(transcript.videoId, 'ai ↳ mode=single (user override)', { estTokens: tokens });
    return generateSummarySinglePass(transcript, meta);
  }
  if (mode === 'mapreduce') {
    logPhase(transcript.videoId, 'ai ↳ mode=mapreduce (user override)', { estTokens: tokens });
    return generateSummaryMapReduce(transcript, meta);
  }

  if (tokens <= SINGLE_PASS_TOKEN_BUDGET) {
    return generateSummarySinglePass(transcript, meta);
  }
  logPhase(transcript.videoId, 'ai ↳ transcript over budget, switching to map-reduce', {
    estTokens: tokens,
    budget: SINGLE_PASS_TOKEN_BUDGET,
  });
  return generateSummaryMapReduce(transcript, meta);
}

// -----------------------------------------------------------------------------
// Orchestration: look up the Video row by videoId, fetch transcript, run AI,
// and UPDATE the Video row with the summary fields + transcript cache. The
// Video row must already exist (created by the share flow). Called from the
// detached background task in the share handler.
// -----------------------------------------------------------------------------

export async function generateVideoSummary(
  videoId: string,
  options: { forceRefetch?: boolean; mode?: GenerationMode } = {},
): Promise<ServiceResult<StrapiVideo>> {
  const runStart = performance.now();
  logPhase(videoId, '▶ generation started', {
    forceRefetch: !!options.forceRefetch,
    mode: options.mode ?? 'auto',
  });

  const video = await fetchVideoByVideoIdService(videoId);
  if (!video) {
    logPhase(videoId, '✗ aborted — video row not found');
    return { success: false, error: 'Video row not found' };
  }
  if (video.summaryStatus === 'generated') {
    logPhase(videoId, '↳ already generated, skipping');
    return { success: true, data: video };
  }

  // Transcript source-of-truth lookup. Three cases:
  //
  //   1. Video already links to a Transcript row (the common regen case):
  //      use it directly, UI shows "using existing transcript".
  //   2. No link yet, but a Transcript row exists for this youtubeVideoId
  //      (e.g. previous run created the transcript but AI crashed before
  //      linking): reuse it, link the Video to it, UI shows "using existing
  //      transcript (found by id)".
  //   3. No Transcript anywhere: fetch from youtubei.js, CREATE the
  //      Transcript row FIRST, then link the Video. UI shows "creating
  //      transcript". This ordering matters: if AI generation later
  //      crashes, the Transcript survives so retry #1 or #2 kicks in.
  let transcriptRow: StrapiTranscript | null =
    !options.forceRefetch && video.transcript
      ? video.transcript
      : null;

  if (!transcriptRow && !options.forceRefetch) {
    const byId = await fetchTranscriptByVideoIdService(videoId);
    if (byId) {
      transcriptRow = byId;
      // Link the Video to the existing Transcript so future lookups
      // populate via the relation and skip the by-id query.
      await linkVideoToTranscriptService(video.documentId, byId.documentId);
      logPhase(videoId, 'transcript ↳ found existing row by youtubeVideoId', {
        documentId: byId.documentId,
      });
    }
  }

  const transcriptSource: 'relation' | 'by-id' | 'fetch' = transcriptRow
    ? video.transcript
      ? 'relation'
      : 'by-id'
    : 'fetch';

  logPhase(videoId, 'meta + transcript → fetching in parallel', {
    transcriptSource,
  });
  setGenerationStep(
    videoId,
    'transcript',
    transcriptRow ? 'using existing transcript' : 'creating transcript',
  );

  let transcriptResult: ServiceResult<TranscriptData>;
  const [fetched, meta] = await Promise.all([
    transcriptRow &&
    transcriptRow.rawSegments &&
    transcriptRow.rawSegments.length > 0
      ? loadTranscriptFromStrapi(videoId, transcriptRow)
      : fetchTranscript(videoId),
    fetchYouTubeMeta(videoId),
  ]);
  transcriptResult = fetched;

  logPhase(videoId, 'meta ✓ oembed', {
    title: meta.title ?? null,
    author: meta.author ?? null,
  });
  if (!transcriptResult.success) {
    await markSummaryFailedService(video.documentId);
    clearGenerationStep(videoId);
    logPhase(videoId, '✗ generation failed at transcript', {
      took: ms(runStart),
      error: transcriptResult.error,
    });
    return transcriptResult;
  }

  // Case 3 resolution: we just fetched from YouTube. Persist the Transcript
  // row NOW — before AI generation — so a crash mid-summary leaves the
  // transcript safely cached for next retry.
  if (!transcriptRow) {
    const created = await createTranscriptService({
      youtubeVideoId: videoId,
      title: transcriptResult.data.upstreamTitle ?? meta.title,
      author: meta.author,
      thumbnailUrl: meta.thumbnailUrl,
      language: transcriptResult.data.language,
      durationSec: transcriptResult.data.durationSec,
      rawSegments: (transcriptResult.data.segments ?? []).map((s) => ({
        text: s.text,
        startMs: s.startMs,
        endMs: s.endMs,
      })),
      rawText: transcriptResult.data.transcript,
    });
    if (created.success) {
      transcriptRow = created.transcript;
      await linkVideoToTranscriptService(video.documentId, created.transcript.documentId);
      logPhase(videoId, 'transcript ✓ created + linked', {
        documentId: created.transcript.documentId,
      });
    } else {
      // Non-fatal: we still have the transcript in memory for this run.
      // Next retry will re-fetch (or the Strapi race settled already).
      logPhase(videoId, 'transcript ✗ save failed (continuing with in-memory)', {
        error: created.error,
      });
    }
  }

  // Clean the transcript before any model sees it — strips fillers, stage
  // directions, and caption duplication. Typically 15-25% char reduction.
  //
  // When we have per-segment captions (the normal path), we clean segment-by-
  // segment so each surviving word keeps its real millisecond start time.
  // That lets the chunker assign exact timecodes instead of linear-interp
  // estimates. Fall back to string-only cleaning when segments are missing.
  const rawChars = transcriptResult.data.transcript.length;
  let prepared: PreparedTranscript | null = null;
  let cleaned: string;
  if (transcriptResult.data.segments && transcriptResult.data.segments.length > 0) {
    prepared = prepareSegmentedTranscript(transcriptResult.data.segments);
    cleaned = prepared.cleanedText;
  } else {
    cleaned = cleanTranscript(transcriptResult.data.transcript);
  }
  logPhase(videoId, 'transcript ✓ cleaned', {
    rawChars,
    cleanedChars: cleaned.length,
    reductionPct: Math.round(100 - (100 * cleaned.length) / Math.max(1, rawChars)),
    segmentAware: prepared !== null,
    wordCount: prepared ? prepared.wordStartMs.length : undefined,
  });
  const cleanedTranscript: TranscriptData = {
    ...transcriptResult.data,
    transcript: cleaned,
    prepared,
  };

  setGenerationStep(videoId, 'ai');
  const summary = await generateSummaryWithAI(cleanedTranscript, meta, options.mode ?? 'auto');
  if (!summary.success) {
    await markSummaryFailedService(video.documentId);
    clearGenerationStep(videoId);
    logPhase(videoId, '✗ generation failed at AI step', {
      took: ms(runStart),
      error: summary.error,
    });
    return summary;
  }

  // Clamp any fields the model overshot against Strapi's per-field limits.
  // A single over-length takeaway would otherwise fail the whole save.
  // Also feeds the (already-clamped) sections into the Contextual Retrieval
  // index-build below.
  const safe = sanitizeSummary(videoId, summary.data);

  // Build BM25 index from retrieval-sized chunks of the cleaned transcript.
  // Contextual Retrieval: each chunk is tokenized together with its nearest
  // summary section (heading + body snippet) so paraphrase-style queries
  // can match via the AI-generated anchor even when the raw transcript
  // doesn't contain the exact word. The stored chunks keep only the
  // original transcript text — display/prompt stays unchanged.
  const indexStart = performance.now();
  // Prefer the segment-aware `prepared` input so chunks get real caption
  // timestamps (exact seek targets in chat). Fall back to the cleaned
  // string (with linear-interp wpm math) when segments are missing.
  const retrievalChunks = chunkForRetrieval(
    prepared ?? cleaned,
    cleanedTranscript.durationSec,
  );
  // Section timestamps are recovered deterministically AFTER the BM25
  // index is built (see sectionGroundings below), so at this point the
  // sections have no timeSec to anchor on. We let the contextualizer
  // associate every section with timeSec=0; it still helps retrieval
  // by prepending heading/body text as context, just without the
  // timestamp-based nearest-section pick. This is fine — the contextual
  // text is what matters for BM25 scoring of chunks.
  const contextualize = makeSectionContextualizer(
    safe.sections.map((s) => ({
      timeSec: 0,
      heading: s.heading,
      body: s.body,
    })),
  );
  const bm25 = buildBM25Index(retrievalChunks, contextualize);
  // Cache the raw caption segments + duration alongside the BM25 index so
  // subsequent regenerations skip the youtubei.js fetch. The size bump is
  // ~10-30KB for a typical video — trivial next to the rest of the row.
  const transcriptSegments: StoredTranscriptIndex = {
    version: 1,
    bm25,
    rawSegments: cleanedTranscript.segments ?? undefined,
    durationSec: cleanedTranscript.durationSec,
  };
  logPhase(videoId, 'bm25 ✓ index built (contextual)', {
    chunks: retrievalChunks.length,
    terms: Object.keys(bm25.idf).length,
    anchoringSections: safe.sections.length,
    durationSec: cleanedTranscript.durationSec,
    lastChunkTimeSec:
      retrievalChunks.length > 0
        ? retrievalChunks[retrievalChunks.length - 1].timeSec
        : null,
    took: ms(indexStart),
  });

  // -------------------------------------------------------------------------
  // Deterministic section timecode recovery (the Le Borgne pattern).
  //
  // The model emitted no timecodes. For each section we search the BM25
  // chunk index with the section's heading + body as the query, and use
  // the best-matching chunk's REAL caption-start time as `timeSec`.
  //
  // This removes the whole class of "model picked the wrong [mm:ss] / made
  // up a number" bugs — the AI's only job is prose, timestamps are recovered
  // by deterministic lookup against the transcript.
  //
  // Sections where BM25 finds nothing above the minimum score get no
  // timeSec (undefined) — better to show "no timecode" than a confidently-
  // wrong one.
  // -------------------------------------------------------------------------
  const sectionGroundings: Array<{
    heading: string;
    timeSec: number | null;
    score: number | null;
    snippetPreview: string | null;
  }> = [];

  const finalSections = safe.sections.map((s) => {
    const query = `${s.heading}. ${s.body}`;
    const evidence = findEvidenceForQuote(query, bm25, 1.0);
    sectionGroundings.push({
      heading: s.heading.slice(0, 60),
      timeSec: evidence?.timeSec ?? null,
      score: evidence?.score ?? null,
      snippetPreview: evidence ? evidence.snippet.slice(0, 80) : null,
    });
    return {
      heading: s.heading,
      body: s.body,
      timeSec: evidence?.timeSec,
    };
  });

  logPhase(videoId, 'sections ✓ timecodes recovered deterministically', {
    total: safe.sections.length,
    grounded: sectionGroundings.filter((g) => g.timeSec !== null).length,
    ungrounded: sectionGroundings.filter((g) => g.timeSec === null).length,
    groundings: sectionGroundings,
  });

  setGenerationStep(videoId, 'saving');
  const saveStart = performance.now();
  logPhase(videoId, 'db → saving summary');
  const updated = await updateVideoSummaryService({
    documentId: video.documentId,
    summaryTitle: safe.title,
    summaryDescription: safe.description,
    summaryOverview: safe.overview,
    aiModel: SUMMARY_MODEL,
    transcriptSegments,
    keyTakeaways: safe.keyTakeaways,
    sections: finalSections,
    actionSteps: safe.actionSteps,
  });
  if (!updated.success) {
    clearGenerationStep(videoId);
    logPhase(videoId, '✗ db save failed', {
      error: updated.error,
      took: ms(saveStart),
    });
    return updated;
  }
  logPhase(videoId, 'db ✓ saved');
  clearGenerationStep(videoId);
  logPhase(videoId, '✓ generation complete', { took: ms(runStart) });
  return { success: true, data: updated.video };
}

// -----------------------------------------------------------------------------
// In-memory progress tracker — the UI polls this via a server function to
// render a "what is it doing right now?" indicator while the background job
// runs. Not persisted; on server restart the page falls back to the DB
// status (pending/failed/generated) as the source of truth.
// -----------------------------------------------------------------------------

export type GenerationStep = 'transcript' | 'ai' | 'saving';

// `detail` is an optional free-form sub-label (e.g. "map chunk 10/16",
// "reduce", "single-pass"). The UI uses it to show per-chunk progress
// during map-reduce so a long run doesn't look like it's wedged on a
// single unchanging step.
type GenerationProgress = {
  step: GenerationStep;
  detail: string | null;
  at: number;
  detailAt: number;
};

const generationProgress = new Map<string, GenerationProgress>();

function setGenerationStep(
  videoId: string,
  step: GenerationStep,
  detail: string | null = null,
) {
  const now = Date.now();
  const existing = generationProgress.get(videoId);
  // Preserve the step's start-time when only the detail changes, so the
  // UI's "elapsed" counter keeps ticking across sub-steps rather than
  // resetting on every chunk boundary.
  const stepStartedAt = existing && existing.step === step ? existing.at : now;
  generationProgress.set(videoId, {
    step,
    detail,
    at: stepStartedAt,
    detailAt: now,
  });
}

function clearGenerationStep(videoId: string) {
  generationProgress.delete(videoId);
}

export function readGenerationStep(
  videoId: string,
): {
  step: GenerationStep;
  detail: string | null;
  elapsedMs: number;
  detailElapsedMs: number;
} | null {
  const entry = generationProgress.get(videoId);
  if (!entry) return null;
  const now = Date.now();
  return {
    step: entry.step,
    detail: entry.detail,
    elapsedMs: now - entry.at,
    detailElapsedMs: now - entry.detailAt,
  };
}

// -----------------------------------------------------------------------------
// Chat-with-video — non-streaming. Includes the full transcript plus the
// timestamped sections as anchors the model can cite with `[mm:ss]`.
// -----------------------------------------------------------------------------

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

function formatTimecode(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// How many retrieved chunks to include in the chat prompt. 8 * ~150 words
// ≈ 1,200 words of retrieved content, plus the always-included sections /
// takeaways — stays well under the model's context even for the smallest
// local quant.
const CHAT_TOP_K = 8;

// How many alternative phrasings of the user's query to ask for. The
// original is always included, so total query count = REWRITE_COUNT + 1.
// Too few misses paraphrase gaps; too many increases rewrite latency and
// dilutes ranking. 3-5 is the industry sweet spot.
const REWRITE_COUNT = 4;

function formatChunksForPrompt(chunks: TranscriptChunk[]): string {
  return chunks
    .map((c) => `[${formatTimecode(c.timeSec)}] ${c.text}`)
    .join('\n\n');
}

// Find the most recent user question in the conversation. BM25 queries use
// the latest user message, not the full history, so a long back-and-forth
// doesn't dilute the term signal with assistant chatter.
function extractLatestUserQuery(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

// Ask the local model to expand the user's question into several alternative
// phrasings that capture the same intent with different vocabulary. The
// original is always included — rewrites augment, never replace. Failures
// fall back to the original query alone so retrieval still happens.
async function rewriteQuery(
  videoId: string,
  original: string,
): Promise<string[]> {
  const trimmed = original.trim();
  if (trimmed.length === 0) return [];
  // Skip rewriting for very short or very long queries — the marginal value
  // is low and the latency is non-trivial.
  if (trimmed.length < 4 || trimmed.length > 400) return [trimmed];

  const started = performance.now();
  const rewriteSystem = [
    'You rewrite search queries. Given a user question about a YouTube video, output several alternative phrasings that capture the same intent using different vocabulary (synonyms, paraphrases, related terms).',
    'Output ONE phrasing per line. No numbering, no bullets, no quotes, no explanation.',
    `Produce exactly ${REWRITE_COUNT} alternative phrasings. Keep each under 15 words.`,
  ].join('\n');
  try {
    const text = (await withRetry(
      () =>
        chat({
          adapter: ollamaAdapterChat,
          messages: [
            { role: 'system', content: rewriteSystem },
            { role: 'user', content: `Original question: ${trimmed}\n\nAlternative phrasings:` },
          ] as never,
          stream: false,
        }),
      { attempts: 2 },
    )) as string;
    const rewrites = text
      .split('\n')
      .map((l) => l.replace(/^[-•\d.)\s"'`]+/, '').replace(/["'`]+$/, '').trim())
      .filter((l) => l.length > 0 && l.length < 200 && l.toLowerCase() !== trimmed.toLowerCase());
    const deduped = Array.from(new Set(rewrites)).slice(0, REWRITE_COUNT);
    const queries = [trimmed, ...deduped];
    logPhase(videoId, 'chat ✓ query rewritten', {
      original: trimmed,
      rewrites: deduped,
      took: ms(started),
    });
    return queries;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'rewrite failed';
    logPhase(videoId, 'chat ✗ query rewrite failed (falling back)', {
      error: message,
      took: ms(started),
    });
    return [trimmed];
  }
}

async function retrieveChunks(
  video: StrapiVideo,
  query: string,
): Promise<TranscriptChunk[]> {
  if (!isStoredIndex(video.transcriptSegments)) return [];
  const queries = await rewriteQuery(video.youtubeVideoId, query);
  if (queries.length <= 1) {
    return searchBM25(video.transcriptSegments.bm25, queries[0] ?? query, CHAT_TOP_K);
  }
  return searchBM25MultiQuery(video.transcriptSegments.bm25, queries, CHAT_TOP_K);
}

export function buildChatSystemPrompt(
  video: StrapiVideo,
  retrieved: TranscriptChunk[],
): string {
  const sectionsBlock =
    video.sections && video.sections.length > 0
      ? video.sections
          .map((s) => {
            const tc =
              typeof s.timeSec === 'number' ? `[${formatTimecode(s.timeSec)}] ` : '';
            return `${tc}${s.heading}\n${s.body}`;
          })
          .join('\n\n')
      : '(no sections available)';

  const takeawaysBlock =
    video.keyTakeaways && video.keyTakeaways.length > 0
      ? video.keyTakeaways.map((t) => `• ${t.text}`).join('\n')
      : '(no takeaways available)';

  const retrievedBlock =
    retrieved.length > 0
      ? formatChunksForPrompt(retrieved)
      : '(no transcript chunks matched the query — answer from sections/takeaways or say you don’t know)';

  const meta = [
    video.videoTitle ? `Video title: ${video.videoTitle}` : null,
    video.videoAuthor ? `Channel: ${video.videoAuthor}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    'You answer questions about a single YouTube video. You will NOT be shown the full transcript — only the top passages retrieved for this specific question, plus the AI-generated sections and takeaways as semantic anchors.',
    'Ground every claim in the retrieved passages or sections. If nothing in the provided material answers the question, say so plainly — do not invent.',
    'When citing, use `[mm:ss]` (or `[h:mm:ss]`) timecode notation. Prefer timecodes from the retrieved passages (they are grounded); fall back to section timecodes when appropriate.',
    'Keep answers concise (2–4 short paragraphs). No preambles like "Great question!". Use markdown for structure (bold, lists) when it actually helps clarity.',
    '',
    'You have ONE external tool available: `web_search(query)` — use it ONLY when the retrieved passages genuinely do not answer the user\'s question (e.g., they ask about something outside the video, or want current/external information). When you do use it, cite the source URL inline. Never call `web_search` for information that IS in the retrieved passages.',
    '',
    meta,
    '',
    '---- Sections (timestamped anchors) ----',
    sectionsBlock,
    '',
    '---- Key takeaways ----',
    takeawaysBlock,
    '',
    '---- Retrieved transcript passages (top matches for the user question) ----',
    retrievedBlock,
  ].join('\n');
}

export async function askAboutVideoService(
  video: StrapiVideo,
  messages: ChatMessage[],
): Promise<ServiceResult<string>> {
  try {
    const query = extractLatestUserQuery(messages);
    const retrieved = await retrieveChunks(video, query);
    const system = buildChatSystemPrompt(video, retrieved);
    const text = (await withRetry(
      () =>
        chat({
          adapter: ollamaAdapterChat,
          messages: [
            { role: 'system', content: system },
            ...messages,
          ] as never,
          stream: false,
        }),
      { attempts: 3 },
    )) as string;
    return { success: true, data: text };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chat generation failed';
    return { success: false, error: message };
  }
}

// Exposed for the streaming endpoint (`api.chat.tsx`) so it can reuse the
// same retrieval path and prompt shape without duplicating the logic.
export async function prepareChatPrompt(
  video: StrapiVideo,
  messages: ChatMessage[],
): Promise<{ system: string; retrievedCount: number }> {
  const query = extractLatestUserQuery(messages);
  const retrieved = await retrieveChunks(video, query);
  return {
    system: buildChatSystemPrompt(video, retrieved),
    retrievedCount: retrieved.length,
  };
}
