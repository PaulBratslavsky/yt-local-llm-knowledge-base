import { describe, it, expect } from 'vitest';
import {
  annotateWithTimecodes,
  buildBM25Index,
  chunkForRetrieval,
  chunkForSummary,
  cleanTranscript,
  estimateTokens,
  extractCitationsWithEvidence,
  findEvidenceForQuote,
  groundSectionsToTranscript,
  isStoredIndex,
  makeSectionContextualizer,
  prepareSegmentedTranscript,
  searchBM25,
  searchBM25MultiQuery,
  verifyTimecodesInText,
  type TimedTextSegment,
} from './transcript';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Small realistic-feeling transcript segments with ms timestamps. Covers
// common patterns the pipeline must handle: natural prose, filler words,
// caption artifacts, and topic transitions at known timestamps.
function makeSegments(): TimedTextSegment[] {
  return [
    { text: 'Hey and welcome to another community call today.', startMs: 0, endMs: 3000 },
    { text: 'Um we are going to talk about, uh, several things.', startMs: 3000, endMs: 6000 },
    { text: '[Music]', startMs: 6000, endMs: 8000 },
    { text: 'First I want to introduce the MCP server we are building.', startMs: 8000, endMs: 12000 },
    { text: 'The MCP server integrates with LLM workflows natively.', startMs: 12000, endMs: 16000 },
    { text: 'It exposes admin API tokens and media library tools.', startMs: 16000, endMs: 20000 },
    { text: 'Next we have Flowjen, a workflow automation tool.', startMs: 60000, endMs: 64000 },
    { text: 'Flowjen lets you drag and drop automation nodes.', startMs: 64000, endMs: 68000 },
    { text: 'Now Boas will present BetterOAuth authentication plugin.', startMs: 120000, endMs: 124000 },
    { text: 'BetterOAuth replaces users and permissions with two-factor support.', startMs: 124000, endMs: 128000 },
  ];
}

// ---------------------------------------------------------------------------
// cleanTranscript
// ---------------------------------------------------------------------------

describe('cleanTranscript', () => {
  it('strips bracketed stage directions', () => {
    expect(cleanTranscript('Hello [Music] world')).toBe('Hello world');
    expect(cleanTranscript('Talking [applause happens here] continue')).toBe(
      'Talking continue',
    );
  });

  it('strips parenthesized caption artifacts', () => {
    expect(cleanTranscript('talking (music playing) more talk')).toBe(
      'talking more talk',
    );
    expect(cleanTranscript('And then (laughter) we moved on')).toBe(
      'And then we moved on',
    );
  });

  it('strips filler words case-insensitively', () => {
    expect(cleanTranscript('Um I uh think this is hmm important')).toBe(
      'I think this is important',
    );
  });

  it('collapses repeated words', () => {
    expect(cleanTranscript('the the thing')).toBe('the thing');
    expect(cleanTranscript('I I I really really think')).toBe('I really think');
  });

  it('collapses runs of whitespace', () => {
    expect(cleanTranscript('hello    world\n\n\ttest')).toBe('hello world test');
  });

  it('leaves clean prose untouched except trimming', () => {
    const clean = 'Important content stays intact.';
    expect(cleanTranscript(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// prepareSegmentedTranscript
// ---------------------------------------------------------------------------

describe('prepareSegmentedTranscript', () => {
  it('produces cleanedText and wordStartMs with matching lengths', () => {
    const segs = makeSegments();
    const prepared = prepareSegmentedTranscript(segs);
    const words = prepared.cleanedText.split(/\s+/).filter(Boolean);
    expect(words.length).toBe(prepared.wordStartMs.length);
  });

  it('preserves segment start times per word', () => {
    const segs: TimedTextSegment[] = [
      { text: 'one two', startMs: 1000 },
      { text: 'three four', startMs: 5000 },
    ];
    const prepared = prepareSegmentedTranscript(segs);
    expect(prepared.wordStartMs[0]).toBe(1000);
    expect(prepared.wordStartMs[1]).toBe(1000);
    expect(prepared.wordStartMs[2]).toBe(5000);
    expect(prepared.wordStartMs[3]).toBe(5000);
  });

  it('skips empty segments (e.g. pure stage directions)', () => {
    const segs: TimedTextSegment[] = [
      { text: '[Music]', startMs: 0 },
      { text: 'real content', startMs: 3000 },
    ];
    const prepared = prepareSegmentedTranscript(segs);
    expect(prepared.wordStartMs).toEqual([3000, 3000]);
    expect(prepared.cleanedText).toBe('real content');
  });

  it('handles empty input', () => {
    const prepared = prepareSegmentedTranscript([]);
    expect(prepared.cleanedText).toBe('');
    expect(prepared.wordStartMs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// annotateWithTimecodes
// ---------------------------------------------------------------------------

describe('annotateWithTimecodes', () => {
  it('injects at least one marker at the start', () => {
    const segs = makeSegments();
    const prepared = prepareSegmentedTranscript(segs);
    const annotated = annotateWithTimecodes(prepared, 15);
    expect(annotated.startsWith('[')).toBe(true);
    // At minimum the first marker is at 0:00 (the first segment starts at 0ms).
    expect(annotated).toMatch(/^\[00:00\]/);
  });

  it('emits markers at roughly the requested gap', () => {
    const segs = makeSegments();
    const prepared = prepareSegmentedTranscript(segs);
    const annotated = annotateWithTimecodes(prepared, 30);
    const markers = annotated.match(/\[\d{1,2}:\d{2}\]/g) ?? [];
    // Fixture spans 0s..2m8s ≈ 128s. At 30s gap that's ~4-5 markers.
    expect(markers.length).toBeGreaterThanOrEqual(2);
    expect(markers.length).toBeLessThan(10);
  });

  it('handles empty prepared transcript', () => {
    expect(annotateWithTimecodes({ cleanedText: '', wordStartMs: [] }, 30)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// chunkForRetrieval / chunkForSummary
// ---------------------------------------------------------------------------

describe('chunker', () => {
  it('retrieval chunks are smaller than summary chunks', () => {
    // Use a long cleaned string to force multiple chunks.
    const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
    const retrieval = chunkForRetrieval(words);
    const summary = chunkForSummary(words);
    // First retrieval chunk has ≤150 words; first summary chunk has ≤2500
    // (SUMMARY_CHUNK_WORDS is sized for throughput on 8B local models).
    expect(retrieval[0].text.split(/\s+/).length).toBeLessThanOrEqual(150);
    expect(summary[0].text.split(/\s+/).length).toBeLessThanOrEqual(2500);
    expect(retrieval.length).toBeGreaterThan(summary.length);
  });

  it('uses real segment timestamps when given a PreparedTranscript', () => {
    const segs = makeSegments();
    const prepared = prepareSegmentedTranscript(segs);
    const chunks = chunkForRetrieval(prepared);
    // The very first chunk starts at word 0 → segment 0 → 0ms → timeSec 0.
    expect(chunks[0].timeSec).toBe(0);
  });

  it('falls back to linear-interp timestamps for a plain string input', () => {
    const words = Array.from({ length: 200 }, () => 'word').join(' ');
    const chunks = chunkForRetrieval(words);
    // Without segments, timeSec is derived from FALLBACK_WPM (150) * word index.
    expect(chunks[0].timeSec).toBe(0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('embeds inline [mm:ss] markers when segments are provided', () => {
    const segs = makeSegments();
    const prepared = prepareSegmentedTranscript(segs);
    const chunks = chunkForRetrieval(prepared);
    // First chunk should contain at least one inline marker like [00:00].
    expect(chunks[0].text).toMatch(/\[\d{1,2}:\d{2}\]/);
  });

  it('returns [] on empty input', () => {
    expect(chunkForRetrieval('')).toEqual([]);
    expect(chunkForSummary('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

describe('BM25', () => {
  const sampleChunks = [
    { id: 0, text: 'mcp server integrates with llm workflows', startWord: 0, timeSec: 10 },
    { id: 1, text: 'flowjen workflow automation drag drop', startWord: 150, timeSec: 60 },
    { id: 2, text: 'betteroauth authentication plugin factor', startWord: 300, timeSec: 120 },
  ];

  it('builds an index with tf, idf, lengths, avgLength parallel to chunks', () => {
    const index = buildBM25Index(sampleChunks);
    expect(index.chunks.length).toBe(3);
    expect(index.tf.length).toBe(3);
    expect(index.lengths.length).toBe(3);
    expect(Object.keys(index.idf).length).toBeGreaterThan(0);
    expect(index.avgLength).toBeGreaterThan(0);
  });

  it('ranks chunks by term relevance', () => {
    const index = buildBM25Index(sampleChunks);
    const hits = searchBM25(index, 'mcp server llm', 3);
    expect(hits[0].id).toBe(0);
  });

  it('returns empty array for query with no valid terms', () => {
    const index = buildBM25Index(sampleChunks);
    expect(searchBM25(index, '', 5)).toEqual([]);
    expect(searchBM25(index, 'the and of', 5)).toEqual([]); // all stopwords
  });

  it('respects topK', () => {
    const index = buildBM25Index(sampleChunks);
    const hits = searchBM25(index, 'mcp flowjen betteroauth', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('strips [mm:ss] markers from indexed text (no pollution in scoring)', () => {
    const withMarker = [
      { id: 0, text: '[00:00] mcp server integrates', startWord: 0, timeSec: 0 },
      { id: 1, text: '[01:00] flowjen automation', startWord: 150, timeSec: 60 },
    ];
    const index = buildBM25Index(withMarker);
    // Query for the timecode itself should match nothing — the tokenizer
    // stripped them before indexing.
    expect(searchBM25(index, '00:00', 5)).toEqual([]);
    // Query for real content still works.
    expect(searchBM25(index, 'mcp', 5).length).toBeGreaterThan(0);
  });

  it('uses contextualizer when building index but stores original chunk text', () => {
    const chunks = [{ id: 0, text: 'mcp', startWord: 0, timeSec: 10 }];
    const index = buildBM25Index(chunks, (c) => `Section: Architecture. ${c.text}`);
    // The stored chunk still has the original text (for prompt display).
    expect(index.chunks[0].text).toBe('mcp');
    // But BM25 scored against the contextualized text → "architecture" hits.
    expect(searchBM25(index, 'architecture', 5).length).toBeGreaterThan(0);
  });
});

describe('searchBM25MultiQuery (RRF fusion)', () => {
  const chunks = [
    { id: 0, text: 'apple banana cherry', startWord: 0, timeSec: 0 },
    { id: 1, text: 'durian elderberry fig', startWord: 10, timeSec: 30 },
    { id: 2, text: 'apple grape honeydew', startWord: 20, timeSec: 60 },
  ];

  it('falls back to single-query search when one query given', () => {
    const index = buildBM25Index(chunks);
    const multi = searchBM25MultiQuery(index, ['apple'], 5);
    const single = searchBM25(index, 'apple', 5);
    expect(multi.map((c) => c.id)).toEqual(single.map((c) => c.id));
  });

  it('fuses rankings across multiple queries', () => {
    const index = buildBM25Index(chunks);
    const result = searchBM25MultiQuery(index, ['apple', 'grape'], 5);
    // Chunk 2 has both "apple" and "grape" → should rank top.
    expect(result[0]?.id).toBe(2);
  });

  it('returns [] for empty query list', () => {
    const index = buildBM25Index(chunks);
    expect(searchBM25MultiQuery(index, [], 5)).toEqual([]);
    expect(searchBM25MultiQuery(index, ['', '  '], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Section contextualizer
// ---------------------------------------------------------------------------

describe('makeSectionContextualizer', () => {
  it('prepends nearest section heading + body snippet to chunk text', () => {
    const sections = [
      { timeSec: 0, heading: 'Intro', body: 'Welcome and setup.' },
      { timeSec: 60, heading: 'Main', body: 'The main argument.' },
    ];
    const ctx = makeSectionContextualizer(sections);
    // A chunk at 30s is closer to Intro (0s) than Main (60s).
    const indexed = ctx({ id: 0, text: 'some content', startWord: 0, timeSec: 30 });
    expect(indexed).toContain('Intro');
    expect(indexed).toContain('Welcome');
    expect(indexed).toContain('some content');
  });

  it('picks the section whose timeSec is ≤ chunk.timeSec and closest', () => {
    // Use distinct heading words to avoid false-positive substring matches
    // (the contextualizer wraps with "Section: ... Context: ...").
    const sections = [
      { timeSec: 0, heading: 'ALPHA-HEAD', body: 'alpha-body' },
      { timeSec: 100, heading: 'BETA-HEAD', body: 'beta-body' },
      { timeSec: 200, heading: 'GAMMA-HEAD', body: 'gamma-body' },
    ];
    const ctx = makeSectionContextualizer(sections);
    const indexed = ctx({ id: 0, text: 'x', startWord: 0, timeSec: 150 });
    expect(indexed).toContain('BETA-HEAD');
    expect(indexed).not.toContain('GAMMA-HEAD');
    expect(indexed).not.toContain('ALPHA-HEAD');
  });

  it('falls back to plain chunk text when sections array is empty', () => {
    const ctx = makeSectionContextualizer([]);
    const chunk = { id: 0, text: 'hello', startWord: 0, timeSec: 0 };
    expect(ctx(chunk)).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// findEvidenceForQuote
// ---------------------------------------------------------------------------

describe('findEvidenceForQuote', () => {
  it('returns the top-matching chunk with snippet and score', () => {
    const chunks = [
      { id: 0, text: 'mcp server llm workflows', startWord: 0, timeSec: 10 },
      { id: 1, text: 'flowjen automation drag drop', startWord: 100, timeSec: 60 },
    ];
    const index = buildBM25Index(chunks);
    const evidence = findEvidenceForQuote('mcp server architecture', index);
    expect(evidence).not.toBeNull();
    expect(evidence?.timeSec).toBe(10);
    expect(evidence?.snippet).toContain('mcp');
    expect(evidence?.score).toBeGreaterThan(0);
  });

  it('returns null when no chunk clears minScore', () => {
    const chunks = [
      { id: 0, text: 'apple banana', startWord: 0, timeSec: 0 },
    ];
    const index = buildBM25Index(chunks);
    expect(findEvidenceForQuote('unrelated xyz', index, 0.5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractCitationsWithEvidence
// ---------------------------------------------------------------------------

describe('extractCitationsWithEvidence', () => {
  // Realistic chunks for the dedup/drift tests below.
  const chunks = [
    { id: 0, text: 'they discuss mcp integration with ai workflows early on', startWord: 0, timeSec: 10 },
    { id: 1, text: 'flowjen presentation begins with drag and drop demo', startWord: 100, timeSec: 600 },
  ];
  const index = buildBM25Index(chunks);

  it('extracts bracketed, parenthesized, and bare citations', () => {
    // Use an index that DELIBERATELY won't ground anything in this test
    // text (unrelated vocabulary) so the grounded-timeSec dedup can't
    // merge the three citations. Each citation's groundedTimeSec stays
    // null, so all three are preserved in the output — which is what
    // this test verifies (pure extraction/pattern matching).
    const emptyIndex = buildBM25Index([
      { id: 0, text: 'xyz unrelated zzz', startWord: 0, timeSec: 0 },
    ]);
    const text = 'The MCP stuff is at [00:10] and flowjen demo at (10:00). Also mentioned 5:30.';
    const cites = extractCitationsWithEvidence(text, emptyIndex);
    const tcs = cites.map((c) => c.citedTimecode);
    expect(tcs).toContain('00:10');
    expect(tcs).toContain('10:00');
    expect(tcs).toContain('5:30');
  });

  it('dedupes the same timecode if cited multiple times', () => {
    const text = 'At [00:10] they said X. Later [00:10] they repeated it.';
    const cites = extractCitationsWithEvidence(text, index);
    expect(cites.filter((c) => c.citedTimecode === '00:10').length).toBe(1);
  });

  it('attaches grounded snippet when BM25 finds a match', () => {
    const text = 'The mcp workflows at [00:10]';
    const cites = extractCitationsWithEvidence(text, index);
    const hit = cites.find((c) => c.citedTimecode === '00:10');
    expect(hit?.groundedSnippet).toContain('mcp');
  });

  it('flags drift when cited timecode differs from grounded by > toleranceSec', () => {
    // Claim "flowjen demo" with a wrong timecode way off from the real 10:00.
    const text = 'The flowjen drag and drop demo at [00:05]';
    const cites = extractCitationsWithEvidence(text, index);
    const hit = cites.find((c) => c.citedTimecode === '00:05');
    expect(hit?.drift).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyTimecodesInText
// ---------------------------------------------------------------------------

describe('verifyTimecodesInText', () => {
  const chunks = [
    { id: 0, text: 'the mcp server integration discussion happens here', startWord: 0, timeSec: 10 },
    { id: 1, text: 'the flowjen drag and drop demo happens here', startWord: 100, timeSec: 600 },
  ];
  const index = buildBM25Index(chunks);

  it('leaves correct citations untouched', () => {
    const text = 'The mcp server is at [00:10]';
    const { text: corrected, overrides } = verifyTimecodesInText(text, index);
    expect(corrected).toBe(text);
    expect(overrides.length).toBe(0);
  });

  it('corrects drifted citations while preserving wrapper style', () => {
    const text = 'The flowjen drag and drop demo happens here at [00:05]';
    const { text: corrected, overrides } = verifyTimecodesInText(text, index, {
      toleranceSec: 30,
      minScore: 0.5,
    });
    expect(overrides.length).toBe(1);
    expect(corrected).toMatch(/\[10:00\]/); // bracket style preserved
  });
});

// ---------------------------------------------------------------------------
// groundSectionsToTranscript
// ---------------------------------------------------------------------------

describe('groundSectionsToTranscript', () => {
  const chunks = [
    { id: 0, text: 'mcp server llm integration tokens permissions', startWord: 0, timeSec: 10 },
    { id: 1, text: 'flowjen automation nodes drag and drop', startWord: 100, timeSec: 600 },
  ];
  const index = buildBM25Index(chunks);

  it('overrides a far-off section timeSec with the BM25 match', () => {
    const sections = [
      { heading: 'MCP Server', body: 'details about mcp llm integration', timeSec: 9999 },
    ];
    const grounded = groundSectionsToTranscript(sections, index);
    expect(grounded[0].timeSec).toBe(10);
    expect(grounded[0].grounded).toBe(true);
    expect(grounded[0].originalTimeSec).toBe(9999);
  });

  it('keeps section unchanged when no strong BM25 match', () => {
    const sections = [
      { heading: 'Unrelated', body: 'xyz abc nothing', timeSec: 42 },
    ];
    const grounded = groundSectionsToTranscript(sections, index);
    expect(grounded[0].timeSec).toBe(42);
    expect(grounded[0].grounded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

describe('isStoredIndex', () => {
  it('accepts valid shape', () => {
    expect(
      isStoredIndex({
        version: 1,
        bm25: { tf: [], idf: {}, lengths: [], avgLength: 0, chunks: [] },
      }),
    ).toBe(true);
  });

  it('rejects invalid shapes', () => {
    expect(isStoredIndex(null)).toBe(false);
    expect(isStoredIndex(undefined)).toBe(false);
    expect(isStoredIndex({})).toBe(false);
    expect(isStoredIndex({ version: 2, bm25: {} })).toBe(false);
    expect(isStoredIndex({ version: 1, bm25: null })).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('returns roughly chars / 4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});
