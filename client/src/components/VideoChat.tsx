import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Accordion } from 'radix-ui';
import { buildMarkdownComponents, stripInlineTimecodes } from './TimecodeMarkdown';
import { getChatResponseEvidence } from '#/data/server-functions/videos';
import type { EvidenceCitation } from '#/lib/services/transcript';

export type ToolCallRecord = {
  /** Stream-provided unique id for this tool call. */
  id: string;
  /** Tool name (e.g., "web_search"). */
  name: string;
  /** Final parsed input args (from TOOL_CALL_END). Null until the call completes. */
  input: unknown | null;
  /** Tool execution result, serialized. Null until complete. */
  result: string | null;
  /** Status: running while args are streaming, done after END. */
  status: 'running' | 'done';
};

type Message = {
  role: 'user' | 'assistant';
  content: string;
  evidence?: EvidenceCitation[];
  toolCalls?: ToolCallRecord[];
};

type Props = {
  videoId: string;
  onSeek: (seconds: number) => void;
  className?: string;
};

// Rewrite slash-prefixed commands into explicit natural-language
// instructions that reliably trigger the corresponding tool. Gemma's tool
// reliability is probabilistic; these wrappers make intent unambiguous.
function transformSlashCommand(input: string): string {
  const webMatch = input.match(/^\/web\s+(.+)$/i);
  if (webMatch) {
    const query = webMatch[1].trim();
    return `Use the web_search tool with the exact query "${query}", then summarize the top results in 2-3 short paragraphs. Cite each source URL inline. Do NOT answer from the transcript for this request — I explicitly want web search results.`;
  }
  return input;
}

const SUGGESTED_PROMPTS = [
  "What's the main argument?",
  'Give me the key claims, with timestamps',
  'What should I do after watching this?',
  'Summarize the part around 5 minutes in',
];

// Events the UI cares about from the SSE stream. Text deltas advance the
// assistant message's rendered content; tool events populate the
// expandable "tool call" accordion attached to that message.
type StreamEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_start'; id: string; name: string }
  | { kind: 'tool_end'; id: string; name: string; input: unknown; result: string | null };

async function* streamChatResponse(
  videoId: string,
  messages: Message[],
): AsyncGenerator<StreamEvent, void, void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, messages }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`chat (${res.status}): ${text || 'request failed'}`);
  }
  if (!res.body) throw new Error('chat: empty response body');

  // TanStack AI emits Server-Sent Events in AG-UI format. Each event is a
  // line `data: <json>\n\n`. The stream ends with `data: [DONE]\n\n`. We
  // accumulate bytes into a buffer, split on blank-line delimiters, parse
  // each, and yield a typed event. Events we don't care about (run
  // start/end, text start/end, step events) are dropped at the parser
  // boundary — the consumer only sees text deltas and tool events.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const eventBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseEventBlock(eventBlock);
        if (event) yield event;
        idx = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    const event = parseSseEventBlock(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

// Parse one SSE event block → a typed StreamEvent, or null to skip.
// Handles text content, tool-call start, and tool-call end; silently
// drops other event types (TOOL_CALL_ARGS is intermediate — we only
// need the final `input` from TOOL_CALL_END).
function parseSseEventBlock(block: string): StreamEvent | null {
  const lines = block.split('\n');
  let payload = '';
  for (const line of lines) {
    if (line.startsWith('data:')) {
      payload += line.slice(5).trimStart();
    }
  }
  if (!payload || payload === '[DONE]') return null;
  try {
    const event = JSON.parse(payload) as {
      type?: string;
      delta?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      result?: string;
    };
    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT':
        return typeof event.delta === 'string' ? { kind: 'text', delta: event.delta } : null;
      case 'TOOL_CALL_START':
        return event.toolCallId && event.toolName
          ? { kind: 'tool_start', id: event.toolCallId, name: event.toolName }
          : null;
      case 'TOOL_CALL_END':
        return event.toolCallId && event.toolName
          ? {
              kind: 'tool_end',
              id: event.toolCallId,
              name: event.toolName,
              input: event.input ?? null,
              result: event.result ?? null,
            }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function VideoChat({ videoId, onSeek, className }: Readonly<Props>) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  };

  // Auto-grow the textarea up to a reasonable max. Keeps the input
  // single-line-ish until the user types a long question.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const sendPrompt = async (promptText: string) => {
    if (pending) return;
    const trimmed = promptText.trim();
    if (!trimmed) return;

    // Slash commands: deterministic triggers that rewrite the user's
    // message into an explicit tool-use prompt, bypassing the model's
    // sometimes-flaky decision to call a tool. `/web <query>` forces
    // the web_search tool. Extend the switch when we add more tools.
    const finalContent = transformSlashCommand(trimmed);

    const history: Message[] = [...messages, { role: 'user', content: finalContent }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setPending(true);
    setError(null);
    scrollToBottom();

    try {
      let accumulated = '';
      const toolCalls = new Map<string, ToolCallRecord>();

      const pushUpdate = () => {
        setMessages((prev) => {
          const next = prev.slice();
          next[next.length - 1] = {
            role: 'assistant',
            content: accumulated,
            toolCalls: toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined,
          };
          return next;
        });
      };

      for await (const event of streamChatResponse(videoId, history)) {
        if (event.kind === 'text') {
          accumulated += event.delta;
          pushUpdate();
          scrollToBottom();
        } else if (event.kind === 'tool_start') {
          toolCalls.set(event.id, {
            id: event.id,
            name: event.name,
            input: null,
            result: null,
            status: 'running',
          });
          pushUpdate();
          scrollToBottom();
        } else if (event.kind === 'tool_end') {
          const existing = toolCalls.get(event.id);
          toolCalls.set(event.id, {
            id: event.id,
            name: event.name,
            input: event.input,
            result: event.result,
            status: 'done',
          });
          void existing;
          pushUpdate();
        }
      }

      // After streaming completes, fetch the deterministic evidence for
      // every timecode the model cited. Each entry pairs the citation with
      // the real transcript chunk we matched to — rendered as expandable
      // accordion panels below the message so the user can verify.
      if (accumulated.trim().length > 0) {
        try {
          const evidence = await getChatResponseEvidence({
            data: { videoId, responseText: accumulated },
          });
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, evidence };
            }
            return next;
          });
        } catch {
          // Evidence is best-effort — the message already rendered.
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat failed';
      setMessages((prev) => prev.slice(0, -1));
      setError(message);
    } finally {
      setPending(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendPrompt(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter (and other modifier combos) inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void sendPrompt(input);
    }
  };

  return (
    <section className={`flex min-h-0 flex-col ${className ?? 'mb-12'}`}>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {messages.length === 0 && !pending ? (
          <EmptyState
            onPick={(p) => {
              setInput(p);
              textareaRef.current?.focus();
            }}
          />
        ) : (
          <div className="grid gap-6 py-2">
            {messages.map((msg, i) => (
              <MessageRow
                key={i}
                message={msg}
                onSeek={onSeek}
                streaming={
                  pending && i === messages.length - 1 && msg.role === 'assistant'
                }
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden="true"
            className="mt-0.5 flex-none"
          >
            <path
              fill="currentColor"
              d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm.5 9v1.5h-1V10.5h1zm0-6v5h-1v-5h1z"
            />
          </svg>
          <span>{error}</span>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="mt-3 flex items-end gap-2 rounded-2xl border border-[var(--line)] bg-[var(--card)] px-3 py-2.5 focus-within:border-[var(--line-strong)]"
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Ask about this video…  (/web <query> to force web search)"
          disabled={pending}
          className="min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent px-1 text-sm leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          aria-label="Send message"
          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[var(--ink)] text-[var(--cream)] transition hover:bg-[var(--ink-soft)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? (
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              className="animate-spin"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="20 30"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          )}
        </button>
      </form>

      <p className="mt-1.5 text-center text-[0.65rem] text-[var(--ink-muted)]">
        Enter to send · Shift+Enter for a new line
      </p>
    </section>
  );
}

function EmptyState({ onPick }: Readonly<{ onPick: (prompt: string) => void }>) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-subtle)]">
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-[var(--ink-muted)]"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <div className="max-w-xs">
        <p className="text-sm font-medium text-[var(--ink)]">Ask about this video</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
          Answers come from the transcript. Timestamps in responses seek the video.
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-wrap justify-center gap-1.5">
        {SUGGESTED_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[0.7rem] text-[var(--ink-soft)] transition hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  onSeek,
  streaming,
}: Readonly<{
  message: Message;
  onSeek: (sec: number) => void;
  streaming: boolean;
}>) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[var(--ink)] px-4 py-2.5 text-sm leading-relaxed text-[var(--cream)]">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div
        aria-hidden="true"
        className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[var(--ink)] text-[var(--cream)]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
        </svg>
      </div>
      <div className="chat-md min-w-0 flex-1 pt-0.5 text-sm leading-relaxed text-[var(--ink)]">
        {message.content.length === 0 && streaming ? (
          <span className="inline-flex items-center gap-2 text-[var(--ink-muted)]">
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--ink-muted)]" />
              <span
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--ink-muted)]"
                style={{ animationDelay: '150ms' }}
              />
              <span
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--ink-muted)]"
                style={{ animationDelay: '300ms' }}
              />
            </span>
          </span>
        ) : (
          <>
            {message.toolCalls && message.toolCalls.length > 0 && (
              <ToolCallsPanel toolCalls={message.toolCalls} />
            )}
            {/* Strip inline `[mm:ss]` / `(mm:ss)` timecodes from the
                chat body. The model often peppers them inline for
                "grounding," but the Sources accordion below already
                shows each citation with its transcript excerpt —
                inline chips are redundant visual noise. */}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={buildMarkdownComponents(onSeek)}
            >
              {stripInlineTimecodes(message.content)}
            </ReactMarkdown>
            {streaming && (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-[var(--ink-muted)] align-middle"
              />
            )}
            {!streaming && message.evidence && message.evidence.length > 0 && (
              <EvidencePanel evidence={message.evidence} onSeek={onSeek} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatMmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function EvidencePanel({
  evidence,
  onSeek,
}: Readonly<{
  evidence: EvidenceCitation[];
  onSeek: (sec: number) => void;
}>) {
  // Outer accordion collapses the whole Sources block into a single-row
  // summary ("Sources — N citations") until expanded. Matches Claude's
  // "References" disclosure pattern — keeps the chat scroll clean.
  return (
    <Accordion.Root type="single" collapsible className="mt-4">
      <Accordion.Item
        value="sources"
        className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-subtle)]"
      >
        <Accordion.Header className="flex">
          <Accordion.Trigger className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--ink-muted)] hover:bg-[var(--card)]">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true">
              <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm.5 9V7.5h-1V10.5h1zm0-5v1h-1v-1h1z" />
            </svg>
            Sources — {evidence.length} citation{evidence.length === 1 ? '' : 's'}
            <span className="ml-auto">
              <svg
                viewBox="0 0 16 16"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="transition-transform duration-200 [[data-state=open]_&]:rotate-180"
                aria-hidden="true"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content className="overflow-hidden">
          <div className="grid gap-1 border-t border-[var(--line)] p-2">
            <Accordion.Root type="multiple" className="grid gap-1">
              {evidence.map((ev, i) => {
          const hasGrounding = ev.groundedTimeSec !== null && ev.groundedSnippet;
          const seekSec = ev.groundedTimeSec ?? ev.citedTimeSec;
          return (
            <Accordion.Item
              key={`${ev.citedTimecode}-${i}`}
              value={`ev-${i}`}
              className="overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--card)]"
            >
              <Accordion.Header className="flex">
                <Accordion.Trigger className="flex w-full flex-col gap-1 px-3 py-2 text-left text-xs hover:bg-[var(--bg-subtle)]">
                  <div className="flex w-full items-center gap-2">
                    {/* Nested <button> inside the Accordion.Trigger button
                        is invalid HTML (hydration error). Render as a
                        role="button" span with click + keyboard handlers
                        and stopPropagation so clicking the chip seeks
                        without toggling the accordion. */}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSeek(seekSec);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onSeek(seekSec);
                        }
                      }}
                      className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-full bg-[var(--ink)] px-1.5 text-[0.65rem] font-semibold text-[var(--cream)]"
                    >
                      <svg viewBox="0 0 16 16" width="8" height="8" aria-hidden="true">
                        <path fill="currentColor" d="M4 2v12l9-6z" />
                      </svg>
                      {ev.citedTimecode}
                    </span>
                    {ev.drift && hasGrounding && (
                      <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[0.6rem] font-medium text-amber-600 dark:text-amber-400">
                        may drift · transcript match at {formatMmss(ev.groundedTimeSec as number)}
                      </span>
                    )}
                    {!hasGrounding && (
                      <span className="rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[0.6rem] text-[var(--ink-muted)]">
                        no strong match
                      </span>
                    )}
                    <span className="ml-auto text-[var(--ink-muted)]">
                      <svg
                        viewBox="0 0 16 16"
                        width="10"
                        height="10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="transition-transform duration-200 [[data-state=open]_&]:rotate-180"
                        aria-hidden="true"
                      >
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </span>
                  </div>
                  {hasGrounding && ev.groundedSnippet && (
                    // Preview of the grounded transcript snippet — shown on
                    // the collapsed header so users see WHAT was matched
                    // without having to expand every row. Clamped to 2
                    // lines; full text still visible when expanded.
                    <p className="line-clamp-2 pl-1 text-[0.7rem] leading-snug text-[var(--ink-soft)]">
                      {ev.groundedSnippet}
                    </p>
                  )}
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Content className="overflow-hidden text-xs data-[state=closed]:animate-none">
                <div className="border-t border-[var(--line)] px-3 py-2.5">
                  <p className="mb-1.5 text-[0.65rem] font-medium uppercase tracking-wide text-[var(--ink-muted)]">
                    Transcript around {hasGrounding ? formatMmss(ev.groundedTimeSec as number) : ev.citedTimecode}
                  </p>
                  <p className="whitespace-pre-wrap leading-relaxed text-[var(--ink-soft)]">
                    {hasGrounding ? ev.groundedSnippet : '(No matching transcript chunk found at this timecode.)'}
                  </p>
                </div>
              </Accordion.Content>
            </Accordion.Item>
          );
        })}
            </Accordion.Root>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}

// Inline panel rendered above the assistant's message body when a tool
// (e.g., web_search) was invoked. Each tool call is an accordion that
// expands to show the exact input args + the result the model received.
// Matches the Claude/ChatGPT pattern of surfacing agentic steps without
// cluttering the reading flow.
function ToolCallsPanel({ toolCalls }: Readonly<{ toolCalls: ToolCallRecord[] }>) {
  return (
    <div className="mb-3 grid gap-1.5">
      <Accordion.Root type="multiple" className="grid gap-1">
        {toolCalls.map((tc) => (
          <Accordion.Item
            key={tc.id}
            value={tc.id}
            className="overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--bg-subtle)]"
          >
            <Accordion.Header className="flex">
              <Accordion.Trigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--card)]">
                {tc.status === 'running' ? (
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--ink)]"
                  />
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    width="10"
                    height="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="flex-none text-[var(--ink)]"
                  >
                    <path d="M3 8l3.5 3.5L13 5" />
                  </svg>
                )}
                <span className="font-mono text-[0.7rem] font-semibold text-[var(--ink)]">
                  {tc.name}
                </span>
                {tc.status === 'running' ? (
                  <span className="text-[0.65rem] text-[var(--ink-muted)]">running…</span>
                ) : (
                  <span className="truncate text-[0.65rem] text-[var(--ink-muted)]">
                    {summarizeInput(tc.input)}
                  </span>
                )}
                <span className="ml-auto text-[var(--ink-muted)]">
                  <svg
                    viewBox="0 0 16 16"
                    width="10"
                    height="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="transition-transform duration-200 [[data-state=open]_&]:rotate-180"
                    aria-hidden="true"
                  >
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </span>
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className="overflow-hidden text-xs">
              <div className="border-t border-[var(--line)] px-3 py-2 text-[var(--ink-soft)]">
                <div className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                  Input
                </div>
                <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 font-mono text-[0.65rem]">
                  {safeStringify(tc.input)}
                </pre>
                {tc.result !== null && (
                  <>
                    <div className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                      Result
                    </div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 font-mono text-[0.65rem]">
                      {formatResult(tc.result)}
                    </pre>
                  </>
                )}
              </div>
            </Accordion.Content>
          </Accordion.Item>
        ))}
      </Accordion.Root>
    </div>
  );
}

// One-line preview of a tool call's input args, shown in the accordion
// header so users get a sense of what was called without expanding.
function summarizeInput(input: unknown): string {
  if (input == null) return '…';
  if (typeof input === 'string') return input.slice(0, 80);
  if (typeof input === 'object') {
    try {
      const flat = Object.entries(input as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' · ');
      return flat.slice(0, 80);
    } catch {
      return '[object]';
    }
  }
  return String(input).slice(0, 80);
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Tool results come serialized as JSON strings. Try to parse + pretty-print;
// fall back to raw string if it's not JSON.
function formatResult(result: string): string {
  try {
    const parsed = JSON.parse(result);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return result;
  }
}
