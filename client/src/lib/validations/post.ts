import { z } from 'zod';

// =============================================================================
// Share-video form — client-side validation
// =============================================================================
//
// The user pastes a YouTube URL and (optionally) a caption and tag list.
// Server-side oEmbed fills in title/author/thumbnail before persisting.

export const GenerationModeSchema = z.enum(['auto', 'single', 'mapreduce']);
export type GenerationMode = z.infer<typeof GenerationModeSchema>;

export const ShareVideoFormSchema = z.object({
  url: z
    .string()
    .url('Enter a valid URL')
    .max(2000, 'URL is too long')
    .refine(
      (u) => extractYouTubeVideoId(u) != null,
      "Doesn't look like a YouTube URL",
    ),
  caption: z.string().max(500, 'Caption is too long').optional().default(''),
  tags: z
    .string()
    .max(240, 'Too many tags — keep it under 240 characters')
    .optional()
    .default(''),
  mode: GenerationModeSchema.optional().default('auto'),
});

export type ShareVideoFormValues = z.infer<typeof ShareVideoFormSchema>;

// =============================================================================
// Server-input schema — the normalized payload server functions accept
// =============================================================================

export const CreateVideoInputSchema = z.object({
  videoId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[\w-]+$/, 'Invalid YouTube video id'),
  url: z.string().url().max(2000),
  caption: z.string().max(500).optional(),
  tagNames: z.array(z.string().min(1).max(40)).max(8).optional().default([]),
});

export type CreateVideoInput = z.infer<typeof CreateVideoInputSchema>;

// =============================================================================
// URL helpers
// =============================================================================

// Accepts any common YouTube URL shape and pulls the video id, or returns
// null if the URL doesn't match. Covers: youtube.com/watch?v=ID, youtu.be/ID,
// youtube.com/embed/ID, youtube.com/shorts/ID, and mobile variants.
export function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Bare id pasted directly (rare but handle it).
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;

      const pathMatch = parsed.pathname.match(
        /^\/(embed|shorts|v)\/([\w-]{11})/,
      );
      if (pathMatch) return pathMatch[2];
    }
    return null;
  } catch {
    return null;
  }
}

// Normalize a comma-separated tag input into an array of lowercase-trimmed
// unique tag names. Drops empties. Caps at 8 to keep UIs sane.
export function parseTagInput(raw: string): string[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0 && s.length <= 40);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length === 8) break;
  }
  return out;
}

// =============================================================================
// Profile edit form — auth/display-name/bio only for this app
// =============================================================================

export const ProfileEditFormSchema = z
  .object({
    displayName: z.string().min(2, 'At least 2 characters').max(40, 'Too long'),
    bio: z.string().max(280, 'Bio is too long'),
  })
  .transform(({ displayName, bio }) => ({
    displayName: displayName.trim(),
    bio: bio.trim(),
  }));

export type ProfileEditFormValues = {
  displayName: string;
  bio: string;
};

export const ProfileUpdateInputSchema = z.object({
  documentId: z.string().min(1),
  displayName: z.string().min(2).max(40).optional(),
  bio: z.string().max(280).optional(),
});
