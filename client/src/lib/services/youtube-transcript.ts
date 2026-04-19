// Self-contained YouTube transcript fetcher. Extracted from
// `strapi-plugin-ai-sdk-yt-transcripts` (v1.0.3) so the app doesn't
// depend on an externally-hosted transcript service — clone + run =
// works, no dead API key.
//
// Strategy (what youtubei.js actually does under the hood):
//   1. Ask the Innertube player config for the video's caption tracks.
//   2. Pick an English track, preferring human-made over auto (asr).
//   3. Fetch the caption track's timedtext XML directly.
//   4. Parse the XML into segments with millisecond start/end/duration.
//      YouTube serves two XML shapes (`<p>` and `<text>`); we handle both.
//
// This sidesteps the BotGuard / PO token requirements that the regular
// `info.getTranscript()` path now imposes — grabbing caption URLs from
// basic info still works anonymously for most public videos.
//
// Proxy support kept from the plugin because YouTube occasionally serves a
// "sign in to confirm you're not a bot" wall to bare server IPs. Set
// `TRANSCRIPT_PROXY_URL` to route through a residential proxy if you hit
// that. Defaults off.

import { Innertube } from 'youtubei.js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export type TranscriptSegment = {
  // Transcript line as rendered on screen.
  text: string;
  // Start offset in milliseconds.
  start: number;
  // End offset in milliseconds.
  end: number;
  // Segment length in milliseconds.
  duration: number;
};

export type TranscriptResult = {
  videoId: string;
  title?: string;
  // Seconds. `null` when youtubei.js couldn't resolve it (rare).
  durationSec: number | null;
  // All segments joined with a single space — what the summarizer chews.
  fullTranscript: string;
  // Segments retained for features that want per-line timing later (chat
  // citations mapped to real seconds, clip-making, etc.).
  segments: TranscriptSegment[];
};

export type FetchOptions = {
  // Optional proxy URL (e.g. `http://user:pass@proxy:port`). Set via env.
  proxyUrl?: string;
};

// ---------------------------------------------------------------------------
// Proxy-aware fetch — required for both the Innertube client and the
// subsequent timedtext XML download to route through the same exit IP.
// ---------------------------------------------------------------------------

function isRequestLike(input: unknown): input is Request {
  return (
    typeof input === 'object' &&
    input !== null &&
    'url' in input &&
    typeof (input as Request).url === 'string' &&
    'method' in input
  );
}

function createProxyFetch(proxyUrl?: string): typeof fetch | undefined {
  if (!proxyUrl) return undefined;
  const proxyAgent = new ProxyAgent(proxyUrl);

  return (async (input: string | URL | Request, init?: RequestInit) => {
    let url: string;
    let method: string;
    let headers: Record<string, string> = {};
    let body: BodyInit | undefined | null;

    if (isRequestLike(input)) {
      url = input.url;
      method = init?.method ?? input.method ?? 'GET';
      if (input.headers && typeof input.headers.forEach === 'function') {
        input.headers.forEach((value, key) => {
          headers[key] = value;
        });
      }
      if (init?.headers) {
        const initHeaders =
          init.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : (init.headers as Record<string, string>);
        headers = { ...headers, ...initHeaders };
      }
      if (init?.body !== undefined) {
        body = init.body;
      } else if (method !== 'GET' && method !== 'HEAD' && input.body) {
        try {
          body = await input.clone().text();
        } catch {
          // Body not available — continue without it.
        }
      }
    } else {
      url = input instanceof URL ? input.toString() : input;
      method = init?.method ?? 'GET';
      if (init?.headers) {
        headers =
          init.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : (init.headers as Record<string, string>);
      }
      body = init?.body;
    }

    // `undici`'s Response is Fetch-compatible, but the return type of its
    // `fetch` is slightly different. Cast at the boundary — the shape is
    // identical for our consumers.
    return undiciFetch(url, {
      method,
      headers,
      body: body as undefined,
      dispatcher: proxyAgent,
    }) as unknown as Response;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Timedtext XML parsing. YouTube serves two shapes depending on the client
// that asked — we try `<p>` first (Android player format) because it's
// more common now; fall back to `<text>` otherwise.
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parsePTagFormat(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const re = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const [, startMs, durMs, rawText] = match;
    const text = decodeHtmlEntities(rawText ?? '');
    if (!text) continue;
    const start = parseInt(startMs, 10);
    const duration = parseInt(durMs, 10);
    segments.push({ text, start, end: start + duration, duration });
  }
  return segments;
}

function parseTextTagFormat(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const re = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const [, startS, durS, rawText] = match;
    const text = decodeHtmlEntities(rawText ?? '');
    if (!text) continue;
    const start = Math.round(parseFloat(startS) * 1000);
    const duration = Math.round(parseFloat(durS ?? '0') * 1000);
    segments.push({ text, start, end: start + duration, duration });
  }
  return segments;
}

function parseTimedTextXml(xml: string): TranscriptSegment[] {
  const pSegments = parsePTagFormat(xml);
  if (pSegments.length > 0) return pSegments;
  return parseTextTagFormat(xml);
}

async function fetchTimedTextXml(
  captionUrl: string,
  proxyFetch?: typeof fetch,
): Promise<string> {
  const fetchFn = proxyFetch ?? fetch;
  const res = await fetchFn(captionUrl, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      // A plain desktop UA avoids the stripped-down consent-wall HTML.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`timedtext fetch failed: ${res.status}`);
  const xml = await res.text();
  if (!xml) throw new Error('empty timedtext response');
  return xml;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function fetchYouTubeTranscript(
  videoId: string,
  options?: FetchOptions,
): Promise<TranscriptResult> {
  const proxyFetch = createProxyFetch(options?.proxyUrl);

  const client = await Innertube.create({
    generate_session_locally: true,
    lang: 'en',
    location: 'US',
    retrieve_player: true,
    fetch: proxyFetch,
  });

  const info = await client.getBasicInfo(videoId);
  const title = info.basic_info?.title ?? undefined;
  const durationSec =
    typeof info.basic_info?.duration === 'number' ? info.basic_info.duration : null;
  const captionTracks = info.captions?.caption_tracks;
  const playability = (info as unknown as { playability_status?: { status?: string; reason?: string } }).playability_status;

  if (!captionTracks || captionTracks.length === 0) {
    const status = playability?.status;
    const reason = playability?.reason;
    if (reason && /sign in/i.test(reason)) {
      throw new Error(
        'YouTube requires sign-in (IP likely blocked). Set TRANSCRIPT_PROXY_URL to a residential proxy.',
      );
    }
    if (status === 'LOGIN_REQUIRED') {
      throw new Error(
        'YouTube requires login (IP likely blocked). Set TRANSCRIPT_PROXY_URL to a residential proxy.',
      );
    }
    if (status === 'ERROR' || status === 'UNPLAYABLE') {
      throw new Error(
        `Video not playable (${status}). ${reason ?? 'Private, deleted, or region-locked.'}`,
      );
    }
    throw new Error(
      `No captions available. Playability: ${status ?? 'unknown'}. The video may not have captions enabled.`,
    );
  }

  // Prefer human-authored English captions over auto-generated (ASR).
  const track =
    captionTracks.find((t) => t.language_code === 'en' && t.kind !== 'asr') ??
    captionTracks.find((t) => t.language_code?.startsWith('en')) ??
    captionTracks[0];

  if (!track?.base_url) {
    throw new Error('No caption track URL found');
  }

  const xml = await fetchTimedTextXml(track.base_url, proxyFetch);
  const segments = parseTimedTextXml(xml);
  if (segments.length === 0) {
    throw new Error('Failed to parse any transcript segments from XML');
  }

  return {
    videoId,
    title,
    durationSec,
    fullTranscript: segments.map((s) => s.text).join(' '),
    segments,
  };
}
