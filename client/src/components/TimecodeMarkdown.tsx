import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Minimal shape of an evidence citation — duplicated here to avoid a
// dependency from components/ → services/. Matches the subset of
// EvidenceCitation we need to enrich inline chips with hover tooltips.
export type ChipEvidence = {
  /** Seconds value of the cited timecode (model-emitted). */
  citedTimeSec: number;
  /** Best-matching transcript chunk start, if BM25 found one. */
  groundedTimeSec: number | null;
  /** The transcript excerpt text — used as the chip's hover tooltip. */
  groundedSnippet: string | null;
};

// Match a chip's seconds value to the closest evidence entry (within 30s).
// Returns the snippet for tooltip if found. We match against BOTH cited
// and grounded timeSec so a model-drifted citation still finds its source.
function findSnippetForSeconds(
  seconds: number,
  evidence: ChipEvidence[] | undefined,
): string | null {
  if (!evidence || evidence.length === 0) return null;
  const TOLERANCE = 30;
  let best: ChipEvidence | null = null;
  let bestDist = Infinity;
  for (const ev of evidence) {
    const candidates: number[] = [ev.citedTimeSec];
    if (ev.groundedTimeSec !== null) candidates.push(ev.groundedTimeSec);
    for (const ts of candidates) {
      const dist = Math.abs(ts - seconds);
      if (dist < bestDist && dist <= TOLERANCE) {
        best = ev;
        bestDist = dist;
      }
    }
  }
  return best?.groundedSnippet ?? null;
}

// Matches any of the timecode shapes that show up in AI output and
// CONSUMES the surrounding `[...]` or `(...)` wrappers so they don't
// leak through as literal text next to the chip. Three alternatives:
//
//   [12:34] / [12:34-12:59] / [1:02:03]   → groups 1 + 2
//   (12:34) / (12:34-12:59)               → groups 3 + 4
//   bare 12:34 / 12:34-12:59 at \b edge   → groups 5 + 6
//
// The range separator is any dash variant (hyphen / en-dash / em-dash).
// Hour form `h:mm:ss` matches inside any wrapper via the `(?::\d{2})?`
// suffix on each timecode.
const TIMECODE_PATTERN = new RegExp(
  [
    // Bracketed
    '\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)(?:\\s*[-–—]\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?))?\\]',
    // Parenthesized
    '\\((\\d{1,2}:\\d{2}(?::\\d{2})?)(?:\\s*[-–—]\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?))?\\)',
    // Bare (word-boundary anchored)
    '\\b(\\d{1,2}:\\d{2}(?::\\d{2})?)(?:\\s*[-–—]\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?))?\\b',
  ].join('|'),
  'g',
);

function parseTcToSeconds(tc: string): number {
  const parts = tc.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

// Replace every timecode match in a plain-text string with a clickable
// button. Non-timecode text is kept verbatim. Used recursively by
// `processChildren` so inline formatting (bold, italic, links) can still
// contain chips.
//
// `evidence` (optional) carries the grounded transcript excerpts for each
// citation. When provided, the chip's `title` attribute is set to the
// matching excerpt so hover reveals WHY this moment was cited — a
// lightweight alternative to expanding the Sources accordion row by row.
function renderWithTimecodes(
  text: string,
  onSeek: (sec: number) => void,
  evidence?: ChipEvidence[],
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(TIMECODE_PATTERN.source, 'g');
  let key = 0;

  while ((match = re.exec(text)) !== null) {
    const full = match[0];
    // One of the three alternatives fired. Groups are:
    //   1,2 = bracketed [start, end?]
    //   3,4 = parenthesized (start, end?)
    //   5,6 = bare start, end?
    const startTc = match[1] ?? match[3] ?? match[5];
    const endTc = match[2] ?? match[4] ?? match[6];
    if (!startTc) continue;
    const start = match.index;
    if (start > lastIndex) out.push(text.slice(lastIndex, start));

    const seconds = parseTcToSeconds(startTc);
    const label = endTc ? `${startTc}–${endTc}` : startTc;
    const snippet = findSnippetForSeconds(seconds, evidence);

    out.push(
      <button
        key={`tc-${key++}`}
        type="button"
        onClick={() => onSeek(seconds)}
        className="mx-0.5 inline-flex h-6 items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-2 align-baseline text-[0.7rem] font-semibold text-[var(--ink)] transition hover:bg-[var(--ink)] hover:text-[var(--cream)]"
        aria-label={
          snippet
            ? `Jump to ${label}. Context: ${snippet.slice(0, 120)}`
            : `Jump to ${label} in the video`
        }
        title={snippet ?? undefined}
      >
        <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
          <path fill="currentColor" d="M4 2v12l9-6z" />
        </svg>
        {label}
      </button>,
    );

    lastIndex = start + full.length;
  }

  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

// Recursively walk react-markdown children, replacing text leaves with
// timecode-transformed nodes. Clones wrapping elements so inline formatting
// (em/strong/code/etc.) containing a timecode still renders correctly.
export function processChildren(
  children: React.ReactNode,
  onSeek: (sec: number) => void,
  evidence?: ChipEvidence[],
): React.ReactNode {
  return React.Children.map(children, (child, i) => {
    if (typeof child === 'string') {
      return (
        <React.Fragment key={i}>
          {renderWithTimecodes(child, onSeek, evidence)}
        </React.Fragment>
      );
    }
    if (React.isValidElement(child)) {
      const el = child as React.ReactElement<{ children?: React.ReactNode }>;
      if (el.props.children !== undefined) {
        return React.cloneElement(
          el,
          undefined,
          processChildren(el.props.children, onSeek, evidence),
        );
      }
    }
    return child;
  });
}

// Build the react-markdown `components` override. Each HTML tag re-renders
// its children through `processChildren` so timecodes in any formatting
// context become clickable chips.
export function buildMarkdownComponents(
  onSeek: (sec: number) => void,
  evidence?: ChipEvidence[],
): Components {
  const wrap =
    <T extends keyof React.JSX.IntrinsicElements>(Tag: T) =>
    ({
      node: _n,
      children,
      ...props
    }: { node?: unknown; children?: React.ReactNode } & React.JSX.IntrinsicElements[T]) => {
      const Component = Tag as unknown as React.ElementType;
      return (
        <Component {...props}>{processChildren(children, onSeek, evidence)}</Component>
      );
    };

  return {
    p: wrap('p'),
    li: wrap('li'),
    strong: wrap('strong'),
    em: wrap('em'),
    h1: wrap('h1'),
    h2: wrap('h2'),
    h3: wrap('h3'),
    h4: wrap('h4'),
    h5: wrap('h5'),
    h6: wrap('h6'),
    blockquote: wrap('blockquote'),
    td: wrap('td'),
    th: wrap('th'),
    code: wrap('code'),
    a: ({ node: _n, children, href, ...props }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--accent)]"
        {...props}
      >
        {processChildren(children, onSeek, evidence)}
      </a>
    ),
  };
}

// Drop-in markdown renderer that turns timecodes into clickable chips.
// Use everywhere AI-generated prose is displayed. Optionally pass
// `evidence` to enrich each chip with a hover tooltip showing the
// grounded transcript excerpt — critical in chat responses where the
// reader wants to verify a citation without expanding a separate panel.
export function TimecodeMarkdown({
  children,
  onSeek,
  className,
  evidence,
}: Readonly<{
  children: string;
  onSeek: (sec: number) => void;
  className?: string;
  evidence?: ChipEvidence[];
}>) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={buildMarkdownComponents(onSeek, evidence)}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Remove AI-emitted inline timecodes from a markdown string. Used where
// the surrounding UI already shows a single authoritative timecode (e.g.
// a walkthrough section header), so inline ranges in the body would just
// duplicate — and since the model's body timecodes can drift from the
// section's start, they imply a precision we don't have.
//
// Strips:
//   [mm:ss] / [h:mm:ss]
//   (mm:ss) / (mm:ss-mm:ss) / (mm:ss, mm:ss)  — parenthesized groups that
//                                                 contain only timecodes
// Leaves:
//   bare `mm:ss` embedded in prose ("at 5:30") — too context-dependent to
//   match reliably and usually reads fine.
export function stripInlineTimecodes(text: string): string {
  return (
    text
      // `[mm:ss]` brackets
      .replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '')
      // Parenthesized groups of one-or-more timecodes (with ranges, commas,
      // surrounding whitespace). Requires the parens contain ONLY timecodes,
      // separators, and whitespace — so we don't eat "(he said at 5:30 something)".
      .replace(
        /\s*\(\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–—]\s*\d{1,2}:\d{2}(?::\d{2})?)?(?:\s*,\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–—]\s*\d{1,2}:\d{2}(?::\d{2})?)?)*\s*\)/g,
        '',
      )
      // Collapse any double spaces left behind; trim line ends.
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim()
  );
}
