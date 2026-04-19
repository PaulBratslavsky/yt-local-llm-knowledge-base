import { useEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { useRouter } from '@tanstack/react-router';
import { updateSectionTimecode } from '#/data/server-functions/videos';

// The YouTube IFrame API streams `infoDelivery` messages with currentTime
// once we subscribe via `{event: 'listening'}`. We parse them in a window
// listener and keep the latest value in state — no extra script load.
// Only active while the popover is open to avoid leaking listeners.
type YTListeningMessage = {
  event?: string;
  info?: { currentTime?: number; playerState?: number };
};

function parseTimecodeInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // mm:ss or m:ss
  const two = s.match(/^(\d{1,2}):(\d{2})$/);
  if (two) {
    const m = Number(two[1]);
    const sec = Number(two[2]);
    if (sec >= 60) return null;
    return m * 60 + sec;
  }
  // h:mm:ss or hh:mm:ss
  const three = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (three) {
    const h = Number(three[1]);
    const m = Number(three[2]);
    const sec = Number(three[3]);
    if (m >= 60 || sec >= 60) return null;
    return h * 3600 + m * 60 + sec;
  }
  // Bare seconds
  const bare = s.match(/^(\d+)$/);
  if (bare) return Number(bare[1]);
  return null;
}

function formatTc(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function SectionTimecodeEditor({
  documentId,
  sectionId,
  timeSec,
  iframeRef,
  onSeek,
}: Readonly<{
  documentId: string;
  sectionId: number;
  timeSec: number;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onSeek: (sec: number) => void;
}>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(formatTc(timeSec));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [livePlayerSec, setLivePlayerSec] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setInput(formatTc(timeSec));
    setError(null);
    // Subscribe to the iframe's info stream so we can offer "use current
    // video time". Nothing happens if the iframe isn't ready yet — user
    // can still type manually.
    const iframe = iframeRef.current;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(
        JSON.stringify({ event: 'listening', id: 'yt-section-editor' }),
        'https://www.youtube.com',
      );
    }
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      if (!event.origin.includes('youtube.com')) return;
      try {
        const msg = JSON.parse(event.data) as YTListeningMessage;
        if (msg.event === 'infoDelivery' && typeof msg.info?.currentTime === 'number') {
          setLivePlayerSec(msg.info.currentTime);
        }
      } catch {
        // not-JSON messages: ignore
      }
    };
    window.addEventListener('message', onMessage);
    // Focus the input when opening so keyboard flow is clean.
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(t);
    };
  }, [open, iframeRef, timeSec]);

  const handleSave = async () => {
    const parsed = parseTimecodeInput(input);
    if (parsed == null) {
      setError('Use format mm:ss or h:mm:ss');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await updateSectionTimecode({
        data: { documentId, sectionId, timeSec: parsed },
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setOpen(false);
      await router.invalidate();
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    }
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            // Modifier-less click = seek (existing behavior). Long-press /
            // shift-click opens the editor. Actually simpler: plain click
            // still seeks, click the small pencil button next to it to edit.
            e.preventDefault();
            onSeek(timeSec);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
          title="Click to seek · right-click to edit timecode"
          className="inline-flex h-7 flex-none items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-subtle)] px-3 text-xs font-semibold text-[var(--ink)] transition hover:bg-[var(--ink)] hover:text-[var(--cream)]"
          aria-label={`Jump to ${formatTc(timeSec)} · right-click to edit`}
        >
          {formatTc(timeSec)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 w-72 rounded-xl border border-[var(--line)] bg-[var(--card)] p-4 shadow-xl"
          onOpenAutoFocus={(e) => {
            // We handle focus ourselves via the timeout in useEffect to
            // avoid Radix focusing the first button instead of the input.
            e.preventDefault();
          }}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
            Edit timecode
          </p>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="mm:ss or h:mm:ss"
            className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--line-strong)]"
          />
          {error && (
            <p className="mt-1.5 text-xs text-destructive">{error}</p>
          )}
          {livePlayerSec != null && (
            <button
              type="button"
              onClick={() => {
                setInput(formatTc(livePlayerSec));
                setError(null);
                inputRef.current?.focus();
              }}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--ink-soft)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink)]"
            >
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path fill="currentColor" d="M4 2v12l9-6z" />
              </svg>
              Use current video time ({formatTc(livePlayerSec)})
            </button>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded-md bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--cream)] hover:bg-[var(--ink-soft)] disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
