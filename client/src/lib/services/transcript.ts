// Transcript utilities used by the summary + chat pipelines.
//
// YouTube auto-captions are a noisy source: filler words, stage directions,
// caption-level duplication, and no real timestamps in the `fullTranscript`
// string we get from the upstream service. This module handles:
//   1. cleanTranscript      — strip the obvious noise, give back more usable tokens
//   2. chunkTranscript      — split cleaned text into ~60s windows with estimated
//                             timestamps (assumed ~150 wpm since we lack true timing)
//   3. buildBM25Index       — compute BM25 scoring tables over those chunks
//   4. searchBM25           — retrieve the top-k chunks for a query
//
// Everything lives in pure JS so the index can be cheaply rebuilt on demand
// and persisted as plain JSON in Strapi (`transcriptSegments`).

// -----------------------------------------------------------------------------
// 1. Clean
// -----------------------------------------------------------------------------

// Common filler/hedge words that add noise without meaning. Order doesn't
// matter, but longer phrases must be attempted before their prefixes.
const FILLER_PATTERNS: Array<[RegExp, string]> = [
  // Stage directions / caption artifacts: [Music], (applause), >> SPEAKER:
  [/\[[^\]]*\]/g, ' '],
  [/\([^)]*(music|applause|laughter|crosstalk|inaudible)[^)]*\)/gi, ' '],
  [/^>>\s*[A-Z][A-Z ]+:/gm, ' '],

  // Standalone filler phrases (word-bounded, case-insensitive)
  [/\b(?:you know|i mean|kind of|sort of|like I said|to be honest|at the end of the day)\b/gi, ' '],

  // Single-word fillers — only when surrounded by word boundaries so we don't
  // chew into real content (e.g. "so" as a conjunction gets a pass most of
  // the time; we only strip duplicates below).
  [/\b(?:um+|uh+|er+|erm+|hmm+|mm+)\b/gi, ' '],

  // Collapse repeated words ("the the thing", "I I I think") to one
  [/\b(\w+)(?:\s+\1\b){1,}/gi, '$1'],

  // Collapse runs of whitespace
  [/\s+/g, ' '],
];

export function cleanTranscript(raw: string): string {
  let text = raw;
  for (const [pattern, replacement] of FILLER_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.trim();
}

// -----------------------------------------------------------------------------
// 1b. Clean + preserve timing
// -----------------------------------------------------------------------------
//
// youtubei.js returns caption segments with millisecond-precise start times.
// Our old path joined them into a single string and then estimated per-word
// timestamps by linear interpolation against video duration — drift could be
// ±30s+ on long videos with music intros or pauses. This path preserves the
// original segment timing: we clean each segment individually and keep a
// parallel array of ms-start-times per surviving word. Downstream chunkers
// use that to assign real timeSec values to chunks instead of estimates.

export type TimedTextSegment = {
  text: string;
  startMs: number;
  endMs?: number;
};

export type PreparedTranscript = {
  /** Cleaned transcript text — segments joined with single spaces. */
  cleanedText: string;
  /** For each word in `cleanedText` (when split on /\s+/), the start time in
   *  milliseconds of the source caption segment. Length === word count. */
  wordStartMs: number[];
};

export function prepareSegmentedTranscript(
  segments: TimedTextSegment[],
): PreparedTranscript {
  const wordStartMs: number[] = [];
  const pieces: string[] = [];
  for (const seg of segments) {
    const cleaned = cleanTranscript(seg.text);
    if (!cleaned) continue;
    const words = cleaned.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      wordStartMs.push(seg.startMs);
    }
    pieces.push(cleaned);
  }
  // Each piece was already trimmed + whitespace-collapsed; joining with ' '
  // preserves word boundaries and order — invariant: wordStartMs.length ===
  // cleanedText.split(/\s+/).filter(Boolean).length.
  return {
    cleanedText: pieces.join(' '),
    wordStartMs,
  };
}

// -----------------------------------------------------------------------------
// Inline timecode helpers
// -----------------------------------------------------------------------------
//
// The model can't guess real timestamps from text alone. When we hand it a
// cleaned transcript or a retrieval chunk, we inject `[mm:ss]` markers at
// segment boundaries so the model can copy the correct number into its
// output instead of estimating from position. BM25 tokenization strips
// these markers (see `tokenize`) so they don't pollute retrieval scoring.

function formatMmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// Annotate a span of words with inline `[mm:ss]` markers. Emits a marker
// whenever the elapsed time since the last marker exceeds `minGapSec`, or
// at the very start. With `minGapSec=15` you typically get one anchor every
// ~15–30 seconds — fine-grained enough for the model to pick a nearby one
// for citation, sparse enough that it doesn't bloat the prompt.
function annotateSpan(
  words: string[],
  wordStartMs: number[],
  startIdx: number,
  endIdx: number,
  minGapSec: number,
): string {
  const parts: string[] = [];
  let lastMarkerMs = -Infinity;
  const gapMs = minGapSec * 1000;
  for (let i = startIdx; i < endIdx; i++) {
    const ms = wordStartMs[i];
    if (typeof ms === 'number' && ms - lastMarkerMs >= gapMs) {
      parts.push(`[${formatMmss(ms / 1000)}]`);
      lastMarkerMs = ms;
    }
    parts.push(words[i]);
  }
  return parts.join(' ');
}

// Full-transcript annotation for the single-pass summary prompt. Default
// `minGapSec=30` → roughly one time anchor per 30s of video. Sections the
// model generates can point at these real anchors instead of estimating.
export function annotateWithTimecodes(
  prepared: PreparedTranscript,
  minGapSec = 30,
): string {
  const words = prepared.cleanedText.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return annotateSpan(words, prepared.wordStartMs, 0, words.length, minGapSec);
}

// -----------------------------------------------------------------------------
// 2. Chunk
// -----------------------------------------------------------------------------

// Fallback speaking rate used when we can't determine the real video
// duration. ~150 wpm is the rough average for English YouTube content —
// podcasts often run hotter (170-190), tutorials slower (120-140). When
// the pipeline *can* fetch the actual duration, we compute a per-video
// wpm (= words / durationSec * 60) so each chunk's timeSec maps to a real
// moment in the video, not an estimate.
const FALLBACK_WPM = 150;

// Retrieval and summarization want different chunk sizes. Retrieval (BM25)
// is best with small windows so term frequency stays informative and the
// top-k ranking is precise. Map-reduce summarization wants larger windows
// so each partial summary has enough context to produce coherent bullets
// without fragmenting the narrative across chunk boundaries. Industry
// guidance: 150–300 tokens for retrieval, 1,500–3,000 tokens for summary.
const RETRIEVAL_CHUNK_WORDS = 150;
const RETRIEVAL_CHUNK_OVERLAP = 20;
// Summary chunks tuned for throughput on local 8B. Larger windows (~3,300
// tokens) mean fewer chunks → fewer orchestration round-trips for the same
// total tokens processed. Overlap dropped to ~2% — industry guidance says
// 10-20% but for summarization the model easily handles sharp boundaries,
// and lower overlap = less duplicate inference.
const SUMMARY_CHUNK_WORDS = 2500;
const SUMMARY_CHUNK_OVERLAP = 50;

export type TranscriptChunk = {
  id: number;
  text: string;
  startWord: number;
  timeSec: number;
};

// Compute per-video words-per-minute. If we know the real video duration
// we can map word index → real seconds with linear interpolation across
// the whole video (close enough — most speech has near-constant cadence
// over long stretches). Without duration we fall back to a global average.
function effectiveWpm(wordCount: number, durationSec: number | null | undefined): number {
  if (!durationSec || durationSec <= 0 || wordCount <= 0) return FALLBACK_WPM;
  const wpm = (wordCount / durationSec) * 60;
  // Guard against absurd values if the scrape picked up something weird.
  if (wpm < 40 || wpm > 300) return FALLBACK_WPM;
  return wpm;
}

function chunkBy(
  input: string | PreparedTranscript,
  chunkWords: number,
  overlapWords: number,
  durationSec?: number | null,
): TranscriptChunk[] {
  const cleanedText = typeof input === 'string' ? input : input.cleanedText;
  const wordStartMs = typeof input === 'string' ? null : input.wordStartMs;
  const words = cleanedText.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Linear-interp fallback wpm, used only when we don't have real per-word
  // timings (e.g. a cleaned-string input without segments).
  const wpm = effectiveWpm(words.length, durationSec);

  const chunks: TranscriptChunk[] = [];
  let id = 0;
  let i = 0;
  // Inline marker density. Retrieval chunks are ~150 words ≈ 60s, so a 15s
  // gap gives 3-4 anchors per chunk — enough for fine citation, not enough
  // to bloat the index size. For the larger summary chunks the same 15s
  // gap scales naturally (more words → more anchors).
  const INLINE_MARKER_MIN_GAP_SEC = 15;
  while (i < words.length) {
    const end = Math.min(i + chunkWords, words.length);
    const timeSec =
      wordStartMs && typeof wordStartMs[i] === 'number'
        ? Math.round(wordStartMs[i] / 1000)
        : Math.round((i / wpm) * 60);
    // When we have real timings, embed `[mm:ss]` markers at segment
    // transitions inside the chunk — gives the model real anchors to
    // copy into its citations. Without timings, fall back to plain text.
    const text = wordStartMs
      ? annotateSpan(words, wordStartMs, i, end, INLINE_MARKER_MIN_GAP_SEC)
      : words.slice(i, end).join(' ');
    chunks.push({ id: id++, text, startWord: i, timeSec });
    if (end === words.length) break;
    i = end - overlapWords;
  }
  return chunks;
}

// Small windows for BM25 retrieval. Pass a PreparedTranscript for real
// segment-based timestamps, or a cleaned string for linear estimation.
export function chunkForRetrieval(
  input: string | PreparedTranscript,
  durationSec?: number | null,
): TranscriptChunk[] {
  return chunkBy(input, RETRIEVAL_CHUNK_WORDS, RETRIEVAL_CHUNK_OVERLAP, durationSec);
}

// Large windows for map-reduce summarization.
export function chunkForSummary(
  input: string | PreparedTranscript,
  durationSec?: number | null,
): TranscriptChunk[] {
  return chunkBy(input, SUMMARY_CHUNK_WORDS, SUMMARY_CHUNK_OVERLAP, durationSec);
}

// -----------------------------------------------------------------------------
// 3. BM25 index
// -----------------------------------------------------------------------------
//
// Classic Okapi BM25. Parameters k1 and b follow the common defaults that
// lucene/elasticsearch use. Tokenization is lowercased word-boundary splits
// with a small English stopword filter — good enough for transcript search
// without bringing in a stemmer dependency.

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'as',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'them',
  'his',
  'her',
  'their',
  'our',
  'my',
  'your',
  'so',
  'if',
  'then',
  'than',
  'there',
  'here',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'not',
  'no',
  'yes',
  'too',
  'very',
  'just',
  'about',
  'from',
  'up',
  'down',
  'out',
  'off',
  'over',
  'again',
  'further',
  'once',
]);

function tokenize(input: string): string[] {
  // Strip `[mm:ss]` / `[h:mm:ss]` markers before tokenizing. These exist
  // for the model's citation grounding (see annotateSpan) but would pollute
  // BM25 scoring if indexed as numeric tokens.
  return input
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'-]*/g)
    ?.filter((t) => t.length > 1 && !STOPWORDS.has(t)) ?? [];
}

export type BM25Index = {
  // Serialized per-document term frequencies. Parallel to `chunks`.
  tf: Array<Record<string, number>>;
  // Inverse document frequency per term.
  idf: Record<string, number>;
  // Document lengths in tokens (parallel to `chunks`), plus the average.
  lengths: number[];
  avgLength: number;
  // Snapshot of the chunks at indexing time. Kept alongside the scoring
  // tables so the serialized blob is self-contained — one JSON field in
  // Strapi holds everything retrieval needs.
  chunks: TranscriptChunk[];
};

// Contextual Retrieval (Anthropic, 2024): each chunk is tokenized together
// with a short context anchor that situates it within the document. The
// anchor only affects scoring — the original chunk text is what gets shown
// to the model at chat time. Callers that skip the contextualizer get
// plain BM25 over chunk.text.
export type Contextualizer = (chunk: TranscriptChunk) => string;

export function buildBM25Index(
  chunks: TranscriptChunk[],
  contextualize?: Contextualizer,
): BM25Index {
  const tf: Array<Record<string, number>> = [];
  const df: Record<string, number> = {};
  const lengths: number[] = [];

  for (const chunk of chunks) {
    const textForIndex = contextualize ? contextualize(chunk) : chunk.text;
    const terms = tokenize(textForIndex);
    lengths.push(terms.length);
    const localTf: Record<string, number> = {};
    const seen = new Set<string>();
    for (const term of terms) {
      localTf[term] = (localTf[term] ?? 0) + 1;
      if (!seen.has(term)) {
        df[term] = (df[term] ?? 0) + 1;
        seen.add(term);
      }
    }
    tf.push(localTf);
  }

  const N = chunks.length;
  const idf: Record<string, number> = {};
  for (const [term, frequency] of Object.entries(df)) {
    // BM25 IDF with the +1 smoothing (guaranteed non-negative for terms
    // that appear in more than half the corpus).
    idf[term] = Math.log(1 + (N - frequency + 0.5) / (frequency + 0.5));
  }

  const avgLength =
    lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;

  return { tf, idf, lengths, avgLength, chunks };
}

export function searchBM25(
  index: BM25Index,
  query: string,
  topK: number,
): TranscriptChunk[] {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];

  const scores: number[] = new Array(index.chunks.length).fill(0);
  for (const term of queryTerms) {
    const idf = index.idf[term];
    if (!idf) continue;
    for (let i = 0; i < index.chunks.length; i++) {
      const f = index.tf[i][term];
      if (!f) continue;
      const dl = index.lengths[i];
      const norm = 1 - BM25_B + (BM25_B * dl) / (index.avgLength || 1);
      scores[i] += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm));
    }
  }

  return scores
    .map((score, i) => ({ score, chunk: index.chunks[i] }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.chunk);
}

// Reciprocal Rank Fusion constant. 60 is the canonical value from Cormack
// et al. (2009) — dampens the contribution of very-top ranks so no single
// query can dominate the fused list, while still keeping near-top hits
// meaningful.
const RRF_K = 60;

// Run BM25 once per query and fuse the rankings via reciprocal rank fusion.
// Used for query rewriting — the model expands the user question into
// several phrasings, each retrieves its own top-N, then we blend them so
// chunks that match multiple phrasings rise to the top. Handles score-scale
// differences across queries cleanly, since RRF is rank-based not
// score-based.
export function searchBM25MultiQuery(
  index: BM25Index,
  queries: string[],
  topK: number,
): TranscriptChunk[] {
  const nonEmpty = queries.map((q) => q.trim()).filter((q) => q.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return searchBM25(index, nonEmpty[0], topK);

  // Retrieve a wider pool per query than we return — gives RRF enough
  // ranks from each phrasing to find consensus.
  const pool = Math.max(topK * 3, 30);
  const fused = new Map<number, { chunk: TranscriptChunk; score: number }>();
  for (const q of nonEmpty) {
    const ranked = searchBM25(index, q, pool);
    ranked.forEach((chunk, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const entry = fused.get(chunk.id);
      if (entry) entry.score += contribution;
      else fused.set(chunk.id, { chunk, score: contribution });
    });
  }
  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((e) => e.chunk);
}

// -----------------------------------------------------------------------------
// Serialization — `transcriptSegments` JSON field on the Video row holds
// everything retrieval needs. Keep the shape explicit so older rows without
// an index can be detected + rebuilt on demand.
// -----------------------------------------------------------------------------

export type StoredTranscriptIndex = {
  version: 1;
  bm25: BM25Index;
  // Raw caption segments cached from the first youtubei.js fetch.
  // Present for all newly-generated videos; absent on pre-cache rows
  // (in which case the regen flow falls back to re-fetching).
  rawSegments?: TimedTextSegment[];
  // Video duration in seconds as reported by youtubei.js at cache time.
  // Derivable from rawSegments as a fallback, but keeping it explicit
  // avoids one edge case: very short trailing segments.
  durationSec?: number | null;
};

export function isStoredIndex(value: unknown): value is StoredTranscriptIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StoredTranscriptIndex>;
  return v.version === 1 && !!v.bm25 && Array.isArray(v.bm25.chunks);
}

// Rough token count — 1 token ≈ 4 chars for English. Good enough for the
// "should we map-reduce?" decision without pulling in a tokenizer.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// -----------------------------------------------------------------------------
// Section-based contextualizer for Contextual Retrieval.
//
// The AI summary pipeline already produces timestamped `sections[]` — each
// one a paraphrased heading + body describing a narrative beat of the video.
// Those are semantically rich anchors the original transcript doesn't have.
// For every retrieval chunk we prepend the nearest section's heading and a
// clipped slice of its body; BM25 indexes that blended string. Result: a
// query like "is the author optimistic?" can now match "Optimistic outlook
// on the industry" in a section heading even when the transcript word never
// appears, because the chunk's indexed text contains the paraphrase.
// -----------------------------------------------------------------------------

type SectionAnchor = { timeSec: number; heading: string; body: string };

// Trim the section body snippet fed into BM25 — a few hundred chars is
// enough to carry the paraphrased semantics; more just dilutes the signal.
const SECTION_BODY_CLIP_CHARS = 240;

function findNearestSection(
  timeSec: number,
  sections: SectionAnchor[],
): SectionAnchor | null {
  if (sections.length === 0) return null;
  // Sections generated by the AI sometimes lack a timeSec — fall back to
  // array order. For ones that have timestamps, pick the section whose
  // start is the greatest timeSec ≤ chunk.timeSec.
  const withTime = sections.filter((s) => typeof s.timeSec === 'number');
  if (withTime.length === 0) {
    // No timed sections — use sections in order, one per ~N chunks.
    // Cheap heuristic: use the first section as the anchor for everything.
    return sections[0];
  }
  let best: SectionAnchor | null = null;
  for (const s of withTime) {
    if (s.timeSec <= timeSec) {
      if (!best || s.timeSec > best.timeSec) best = s;
    }
  }
  // If the chunk starts before any section (rare — first few seconds), use
  // the earliest section as the anchor.
  return best ?? withTime[0];
}

// -----------------------------------------------------------------------------
// Ground AI-generated section timecodes to the real transcript.
//
// The model produces `sections[]` with its own `timeSec` estimates — but
// even with inline timecode markers in the prompt, it can still drift
// (pick the wrong marker, copy from a nearby chunk, anchor on a visual
// that doesn't match the heading). Since we already have a BM25 index
// of the real-timestamped chunks, we can re-anchor each section's
// timeSec to the chunk that actually matches its content.
//
// Strategy:
//   1. For each section, search BM25 with `heading + body` as the query.
//   2. Take the top-scoring chunk's real `timeSec`.
//   3. Only override the model's value when BM25 found a meaningful
//      match — otherwise trust the model and leave timeSec unchanged.
// -----------------------------------------------------------------------------

// Minimum BM25 score to trust for grounding. Below this, the match is
// weak enough that we should trust the model's original timeSec rather
// than flip it to a loosely-related chunk.
const GROUNDING_MIN_SCORE = 2.0;

// -----------------------------------------------------------------------------
// Public citation tool — the primitive industry production systems rely on.
// Given a claim or quote, returns the real-timestamped transcript chunk that
// best supports it. Used BOTH at generation time (deterministic section
// timecode recovery — the Le Borgne pattern) AND at chat time (post-process
// verification of the model's citations, plus on-demand evidence fetching).
// -----------------------------------------------------------------------------

export type TranscriptEvidence = {
  /** Real caption-segment start time in seconds. */
  timeSec: number;
  /** The transcript chunk's raw text — shows the user WHY we landed there. */
  snippet: string;
  /** BM25 relevance score. Higher = stronger match. */
  score: number;
};

export function findEvidenceForQuote(
  quote: string,
  index: BM25Index,
  minScore = 1.0,
): TranscriptEvidence | null {
  const hit = searchBM25Top1WithScore(index, quote);
  if (!hit || hit.score < minScore) return null;
  return {
    timeSec: hit.chunk.timeSec,
    snippet: hit.chunk.text,
    score: hit.score,
  };
}

// Parse a `mm:ss`, `h:mm:ss`, or bare-seconds string into seconds.
// Mirrors parseTcToSeconds in TimecodeMarkdown — kept here to avoid a
// dependency from services → components.
function parseTcStringToSeconds(tc: string): number {
  const parts = tc.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

// (formatMmss is defined earlier in the file — reused here.)

// Scan a text for model-emitted `[mm:ss]` / `(mm:ss)` / bare mm:ss citations.
// For each, extract the surrounding context (~±200 chars) and verify the
// cited timecode matches where that content actually lives in the transcript.
// If the best chunk is >`toleranceSec` from the cited value AND the match
// confidence clears `minScore`, swap the citation for the correct one.
// Preserves wrapper style (brackets / parens / bare).
export function verifyTimecodesInText(
  text: string,
  index: BM25Index,
  opts: { toleranceSec?: number; minScore?: number } = {},
): {
  text: string;
  overrides: Array<{ from: string; to: string; context: string }>;
} {
  const tolerance = opts.toleranceSec ?? 30;
  const minScore = opts.minScore ?? 1.5;
  const overrides: Array<{ from: string; to: string; context: string }> = [];

  // Same three-alternative pattern as TimecodeMarkdown. Matches preserved
  // so we can swap only the number while keeping punctuation intact.
  const pattern = new RegExp(
    [
      '\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]',
      '\\((\\d{1,2}:\\d{2}(?::\\d{2})?)\\)',
      '\\b(\\d{1,2}:\\d{2}(?::\\d{2})?)\\b',
    ].join('|'),
    'g',
  );

  const corrected = text.replace(pattern, (match, bracketed, parens, bare, offset: number) => {
    const tc: string | undefined = bracketed ?? parens ?? bare;
    if (!tc) return match;
    const cited = parseTcStringToSeconds(tc);

    // Context window: ~200 chars before and after the citation, enough to
    // BM25-score reliably without running over neighboring sections.
    const before = text.slice(Math.max(0, offset - 200), offset);
    const after = text.slice(offset + match.length, offset + match.length + 200);
    const context = `${before} ${after}`.replace(/\s+/g, ' ').trim();
    if (context.length < 20) return match; // not enough content to verify

    const hit = findEvidenceForQuote(context, index, minScore);
    if (!hit) return match;

    if (Math.abs(hit.timeSec - cited) <= tolerance) return match;

    const newTc = formatMmss(hit.timeSec);
    overrides.push({ from: tc, to: newTc, context: context.slice(0, 80) });

    if (bracketed) return `[${newTc}]`;
    if (parens) return `(${newTc})`;
    return newTc;
  });

  return { text: corrected, overrides };
}

// Extract every timecode citation in a text along with the transcript chunk
// that grounds it — the data shape the chat UI accordion needs. For each
// citation we return:
//   - the citation as the model wrote it (timecode + wrapper style)
//   - the surrounding claim (≈200 chars context)
//   - the real transcript snippet that best matches that context
//   - drift flag (whether the cited timecode is far from the grounded one)
//
// The UI renders these below the chat response as expandable evidence
// panels: user sees what the model cited, can click to expand the actual
// transcript text, and can instantly spot drift.
export type EvidenceCitation = {
  /** The timecode as the model wrote it (e.g. "20:19"). */
  citedTimecode: string;
  /** Seconds value of the cited timecode. */
  citedTimeSec: number;
  /** The claim in the response text surrounding this citation. */
  claim: string;
  /** Best-matching transcript chunk's start time (seconds). Null if no match. */
  groundedTimeSec: number | null;
  /** The transcript chunk text we matched against. Null if no match. */
  groundedSnippet: string | null;
  /** BM25 relevance score. Null when no match. */
  score: number | null;
  /** True when citedTimeSec differs from groundedTimeSec by > toleranceSec. */
  drift: boolean;
};

export function extractCitationsWithEvidence(
  text: string,
  index: BM25Index,
  opts: { toleranceSec?: number; minScore?: number } = {},
): EvidenceCitation[] {
  const tolerance = opts.toleranceSec ?? 30;
  const minScore = opts.minScore ?? 1.0;
  const out: EvidenceCitation[] = [];
  const seen = new Set<string>(); // dedupe same citation used twice

  const pattern = new RegExp(
    [
      '\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]',
      '\\((\\d{1,2}:\\d{2}(?::\\d{2})?)\\)',
      '\\b(\\d{1,2}:\\d{2}(?::\\d{2})?)\\b',
    ].join('|'),
    'g',
  );

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const tc = match[1] ?? match[2] ?? match[3];
    if (!tc) continue;
    const citedTimeSec = parseTcStringToSeconds(tc);
    const offset = match.index;

    // Dedupe when the same timecode is referenced multiple places — first
    // occurrence wins for UI cleanliness.
    if (seen.has(tc)) continue;
    seen.add(tc);

    const before = text.slice(Math.max(0, offset - 200), offset);
    const after = text.slice(offset + match[0].length, offset + match[0].length + 200);
    const claim = `${before}${match[0]}${after}`.replace(/\s+/g, ' ').trim();
    const queryContext = `${before} ${after}`.replace(/\s+/g, ' ').trim();

    const evidence = queryContext.length >= 20
      ? findEvidenceForQuote(queryContext, index, minScore)
      : null;

    out.push({
      citedTimecode: tc,
      citedTimeSec,
      claim: claim.slice(0, 300),
      groundedTimeSec: evidence?.timeSec ?? null,
      groundedSnippet: evidence?.snippet ?? null,
      score: evidence?.score ?? null,
      drift: evidence
        ? Math.abs(evidence.timeSec - citedTimeSec) > tolerance
        : false,
    });
  }

  // Dedupe by grounded timeSec — two model citations that resolve to the
  // same moment in the transcript (within GROUND_DEDUPE_TOLERANCE seconds)
  // are effectively the same evidence and shouldn't be shown as separate
  // rows. E.g. model cites both [13:18] and [10:50] but BM25 resolves
  // [13:18] → 10:52; they're both pointing at ~10:50 in the actual video.
  // Keep the citation with the smallest drift (cited ≈ grounded = more
  // accurate original), drop the other.
  const GROUND_DEDUPE_TOLERANCE = 15;
  const merged: EvidenceCitation[] = [];
  for (const cite of out) {
    if (cite.groundedTimeSec === null) {
      merged.push(cite);
      continue;
    }
    const existingIdx = merged.findIndex(
      (m) =>
        m.groundedTimeSec !== null &&
        Math.abs(m.groundedTimeSec - (cite.groundedTimeSec as number)) <=
          GROUND_DEDUPE_TOLERANCE,
    );
    if (existingIdx === -1) {
      merged.push(cite);
      continue;
    }
    const existing = merged[existingIdx];
    const existingDrift = Math.abs(
      existing.citedTimeSec - (existing.groundedTimeSec as number),
    );
    const newDrift = Math.abs(
      cite.citedTimeSec - (cite.groundedTimeSec as number),
    );
    if (newDrift < existingDrift) {
      merged[existingIdx] = cite;
    }
    // else keep existing — it's the less-drifted original
  }

  return merged;
}

export type GroundableSection = {
  heading: string;
  body: string;
  timeSec?: number;
};

export type GroundedSection<T extends GroundableSection> = T & {
  /** Whether timeSec was re-anchored by BM25 grounding. Useful for logs. */
  grounded?: boolean;
  /** Model's original timeSec before grounding, when it was overridden. */
  originalTimeSec?: number;
};

// BM25 top-1 that also returns the score — shared between `findEvidenceForQuote`
// (public citation tool) and `groundSectionsToTranscript` (generation-time
// grounding pass). Mirrors `searchBM25` but keeps score info.
function searchBM25Top1WithScore(
  index: BM25Index,
  query: string,
): { chunk: TranscriptChunk; score: number } | null {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return null;

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < index.chunks.length; i++) {
    let score = 0;
    for (const term of queryTerms) {
      const idf = index.idf[term];
      if (!idf) continue;
      const f = index.tf[i][term];
      if (!f) continue;
      const dl = index.lengths[i];
      const norm = 1 - BM25_B + (BM25_B * dl) / (index.avgLength || 1);
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm));
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;
  return { chunk: index.chunks[bestIdx], score: bestScore };
}

export function groundSectionsToTranscript<T extends GroundableSection>(
  sections: T[],
  index: BM25Index,
): GroundedSection<T>[] {
  return sections.map((s) => {
    const hit = searchBM25Top1WithScore(index, `${s.heading}. ${s.body}`);
    if (!hit || hit.score < GROUNDING_MIN_SCORE) {
      return s;
    }
    const originalTimeSec = s.timeSec;
    // Skip override if the model's estimate is already close to the BM25
    // match (within 15s) — both are fine in that case and preserving the
    // model's number keeps cross-reference with body citations stable.
    if (
      typeof originalTimeSec === 'number' &&
      Math.abs(originalTimeSec - hit.chunk.timeSec) <= 15
    ) {
      return s;
    }
    return {
      ...s,
      timeSec: hit.chunk.timeSec,
      grounded: true,
      originalTimeSec,
    };
  });
}

export function makeSectionContextualizer(
  sections: SectionAnchor[],
): Contextualizer {
  return (chunk) => {
    const anchor = findNearestSection(chunk.timeSec, sections);
    if (!anchor) return chunk.text;
    const clipped = anchor.body.length > SECTION_BODY_CLIP_CHARS
      ? `${anchor.body.slice(0, SECTION_BODY_CLIP_CHARS)}…`
      : anchor.body;
    // Prepend context as natural sentences so BM25 tokenizes it cleanly.
    return `Section: ${anchor.heading}. Context: ${clipped}. Transcript: ${chunk.text}`;
  };
}
