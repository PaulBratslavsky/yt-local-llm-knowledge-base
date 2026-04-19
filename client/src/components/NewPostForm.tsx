import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useRouter } from '@tanstack/react-router';
import { Button } from '#/components/ui/button';
import { Label } from '#/components/ui/label';
import { Textarea } from '#/components/ui/textarea';
import { FieldText } from '#/components/forms/FieldText';
import { GenerationModeSelect } from '#/components/GenerationModeSelect';
import { shareVideo } from '#/data/server-functions/videos';
import {
  ShareVideoFormSchema,
  type GenerationMode,
  type ShareVideoFormValues,
} from '#/lib/validations/post';

// Share-a-video form. Paste a YouTube URL, add an optional caption + tags.
// The server function extracts the video id, fetches oEmbed metadata,
// creates the Video row, and kicks off AI summary generation in the
// background. We redirect to /learn/$videoId on success; the learn page
// polls for the summary to finish.
export function NewPostForm() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: {
      url: '',
      caption: '',
      tags: '',
      mode: 'auto' as GenerationMode,
    } satisfies ShareVideoFormValues,
    validators: { onChange: ShareVideoFormSchema as never },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const parsed = ShareVideoFormSchema.safeParse(value);
      if (!parsed.success) {
        setServerError('Fix the highlighted fields and try again');
        return;
      }

      const result = await shareVideo({
        data: {
          url: parsed.data.url,
          caption: parsed.data.caption || undefined,
          tags: parsed.data.tags || undefined,
          mode: parsed.data.mode,
        },
      });

      if (result.status === 'error') {
        setServerError(result.error);
        return;
      }

      await router.invalidate();
      router.navigate({
        to: '/learn/$videoId',
        params: { videoId: result.video.youtubeVideoId },
      });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="grid gap-5"
    >
      <form.Field name="url">
        {(field) => (
          <FieldText
            field={field}
            label="YouTube URL"
            placeholder="https://www.youtube.com/watch?v=…"
            disabled={form.state.isSubmitting}
          />
        )}
      </form.Field>

      <div>
        <Label htmlFor="caption" className="mb-1.5 block text-sm font-medium">
          Why share this? <span className="text-[var(--ink-muted)]">(optional)</span>
        </Label>
        <form.Field name="caption">
          {(field) => (
            <Textarea
              id="caption"
              placeholder="What did you learn, or why is it worth watching?"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              disabled={form.state.isSubmitting}
              rows={3}
              className="resize-none"
            />
          )}
        </form.Field>
      </div>

      <form.Field name="tags">
        {(field) => (
          <FieldText
            field={field}
            label="Tags (comma-separated)"
            placeholder="ai, productivity, python"
            disabled={form.state.isSubmitting}
          />
        )}
      </form.Field>

      <form.Field name="mode">
        {(field) => (
          <GenerationModeSelect
            value={field.state.value as GenerationMode}
            onChange={(next) => field.handleChange(next)}
            disabled={form.state.isSubmitting}
          />
        )}
      </form.Field>

      {serverError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {serverError}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="submit"
          size="pill"
          disabled={form.state.isSubmitting || !form.state.canSubmit}
        >
          {form.state.isSubmitting ? 'Sharing…' : 'Share video'}
        </Button>
      </div>
    </form>
  );
}
