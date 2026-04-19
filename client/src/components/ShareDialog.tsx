import { useState } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog';
import { Button } from '#/components/ui/button';

type Props = {
  postDocumentId: string;
  shareText?: string;
  trigger: React.ReactNode;
};

// Third-party share intents. Each takes the URL and optional text, returns
// a URL that, when opened, prompts the target site's compose UI with the
// content prefilled. No API keys, no auth — these are just querystring tricks
// the big platforms have supported for years.
function buildShareLinks(url: string, text: string) {
  const enc = encodeURIComponent;
  return {
    x: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`,
    reddit: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(text)}`,
  };
}

export function ShareDialog({ postDocumentId, shareText, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Resolved at click-time so SSR doesn't see a hardcoded origin.
  const shareUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/post/${postDocumentId}`
      : `/post/${postDocumentId}`;
  const text = shareText || 'Check out this post';
  const links = buildShareLinks(shareUrl, text);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const handleNativeShare = async () => {
    if (typeof navigator === 'undefined' || !navigator.share) {
      void handleCopy();
      return;
    }
    try {
      await navigator.share({ title: 'Health', text, url: shareUrl });
      setOpen(false);
    } catch {
      // User cancelled — no action needed
    }
  };

  const canNativeShare =
    typeof navigator !== 'undefined' && 'share' in navigator;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this post</DialogTitle>
          <DialogDescription>
            Anyone with the link can view this post, even if they're not signed in.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2">
            <input
              readOnly
              value={shareUrl}
              className="flex-1 bg-transparent text-xs text-muted-foreground outline-none"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" size="sm" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <ShareTarget href={links.x} label="X" />
            <ShareTarget href={links.facebook} label="Facebook" />
            <ShareTarget href={links.linkedin} label="LinkedIn" />
            <ShareTarget href={links.reddit} label="Reddit" />
          </div>

          {canNativeShare && (
            <Button
              type="button"
              variant="outline"
              onClick={handleNativeShare}
              className="w-full"
            >
              More options…
            </Button>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareTarget({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-xs font-semibold text-[var(--sea-ink)] no-underline transition hover:-translate-y-0.5 hover:border-[var(--lagoon-deep)] hover:text-[var(--lagoon-deep)]"
    >
      {label}
    </a>
  );
}
