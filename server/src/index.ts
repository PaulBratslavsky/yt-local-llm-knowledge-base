import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

type WithData = { data?: Record<string, unknown> };

// Normalize a user-supplied tag name so free-form input dedupes into one row.
function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export default {
  register({ strapi }: { strapi: Core.Strapi }) {
    strapi.documents.use(async (context, next) => {
      // Rule 1: video.create — require youtubeVideoId and enforce dedupe.
      // The client also pre-checks, but this is the authoritative gate.
      if (
        context.uid === 'api::video.video' &&
        context.action === 'create'
      ) {
        const data = (context.params as WithData).data ?? {};
        const videoId = data.youtubeVideoId as string | undefined;
        if (!videoId) {
          throw new errors.ApplicationError('youtubeVideoId is required');
        }

        const existing: any = await strapi
          .documents('api::video.video')
          .findFirst({ filters: { youtubeVideoId: { $eq: videoId } } });
        if (existing) {
          throw new errors.ApplicationError(
            `A video for this id already exists. documentId=${existing.documentId}`,
          );
        }
      }

      // Rule 1b: transcript.create — same dedupe on youtubeVideoId. The
      // schema has `unique: true` at the DB level, but this returns a
      // cleaner error and handles races in-flight.
      if (
        context.uid === 'api::transcript.transcript' &&
        context.action === 'create'
      ) {
        const data = (context.params as WithData).data ?? {};
        const videoId = data.youtubeVideoId as string | undefined;
        if (!videoId) {
          throw new errors.ApplicationError('youtubeVideoId is required on transcript');
        }
        const existing: any = await strapi
          .documents('api::transcript.transcript')
          .findFirst({ filters: { youtubeVideoId: { $eq: videoId } } });
        if (existing) {
          throw new errors.ApplicationError(
            `A transcript for this id already exists. documentId=${existing.documentId}`,
          );
        }
      }

      // Rule 2: tag.create — normalize name for consistent dedupe.
      if (
        context.uid === 'api::tag.tag' &&
        context.action === 'create'
      ) {
        const data = (context.params as WithData).data ?? {};
        const raw = data.name as string | undefined;
        if (typeof raw === 'string') {
          data.name = normalizeTagName(raw);
        }
        (context.params as WithData).data = data;
      }

      return next();
    });
  },

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // Local-first, single-user app — no auth. Public role gets full read +
    // create + update on every content type. Delete stays admin-only so we
    // don't accidentally nuke the knowledge base via the UI.
    //
    // `await`ed so Strapi logs the result during startup and so the grants
    // are in place before the server accepts requests. The previous fire-
    // and-forget pattern had a startup race: the web server could answer
    // "403" for a brief window after the app was "ready".
    const actions = [
      'api::video.video.find',
      'api::video.video.findOne',
      'api::video.video.create',
      'api::video.video.update',
      'api::tag.tag.find',
      'api::tag.tag.findOne',
      'api::tag.tag.create',
      'api::transcript.transcript.find',
      'api::transcript.transcript.findOne',
      'api::transcript.transcript.create',
      'api::transcript.transcript.update',
    ];

    try {
      const publicRole: any = await strapi
        .db.query('plugin::users-permissions.role')
        .findOne({ where: { type: 'public' } });

      if (!publicRole) {
        strapi.log.warn('[bootstrap] public role not found — skipping grants');
        return;
      }

      let granted = 0;
      let existing = 0;
      for (const action of actions) {
        const hit = await strapi
          .db.query('plugin::users-permissions.permission')
          .findOne({ where: { action, role: publicRole.id } });
        if (hit) {
          existing += 1;
          continue;
        }
        await strapi
          .db.query('plugin::users-permissions.permission')
          .create({ data: { action, role: publicRole.id } });
        granted += 1;
      }

      strapi.log.info(
        `[bootstrap] public permissions: granted=${granted}, already-present=${existing}, total=${actions.length}`,
      );
    } catch (err) {
      strapi.log.error('[bootstrap] public permission grant failed:', err);
    }
  },
};
