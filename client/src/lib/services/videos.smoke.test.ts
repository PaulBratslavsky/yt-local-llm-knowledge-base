import { describe, it, expect, beforeAll } from 'vitest';

// Smoke test: hits a running local Strapi at STRAPI_URL and verifies the
// public role can create + list Video rows. Auto-skips if Strapi isn't
// reachable.
//
//   yarn --cwd server develop   # in one terminal
//   yarn --cwd client test      # in another
//
// These tests assume a fresh-ish DB — they create a video with a throwaway
// youtubeVideoId that won't collide with real content. They don't clean up
// after themselves (admin-only delete); re-running re-uses the same row.

const STRAPI_URL = process.env.STRAPI_URL ?? 'http://localhost:1337';
const TEST_VIDEO_ID = 'test-smoke-001';

async function isStrapiUp(): Promise<boolean> {
  try {
    const res = await fetch(`${STRAPI_URL}/api/videos?pagination[pageSize]=1`);
    return res.ok;
  } catch {
    return false;
  }
}

describe('videos service — smoke', () => {
  let strapiUp = false;

  beforeAll(async () => {
    strapiUp = await isStrapiUp();
    if (!strapiUp) {
      console.warn(
        `[smoke] Strapi not reachable at ${STRAPI_URL} — skipping. ` +
          `Start it with \`yarn --cwd server develop\`.`,
      );
    }
  });

  it('public role can list videos (find permission granted)', async () => {
    if (!strapiUp) return;
    const res = await fetch(`${STRAPI_URL}/api/videos?pagination[pageSize]=1`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: unknown[] };
    expect(Array.isArray(json.data)).toBe(true);
  });

  it('public role can create a video (create permission granted)', async () => {
    if (!strapiUp) return;
    // Try to create; if already exists from a prior run, the server
    // middleware throws "already exists" which we treat as success for this
    // test's purpose.
    const res = await fetch(`${STRAPI_URL}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          youtubeVideoId: TEST_VIDEO_ID,
          url: `https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`,
          videoTitle: 'Smoke test video',
          summaryStatus: 'pending',
        },
      }),
    });

    if (res.status === 400) {
      const body = (await res.json()) as { error?: { message?: string } };
      // Expected on re-runs — Rule 1 in server middleware.
      expect(body.error?.message ?? '').toMatch(/already exists/i);
    } else {
      expect(res.status).toBe(200);
    }
  });

  it('feed query returns the test video', async () => {
    if (!strapiUp) return;
    const params = new URLSearchParams();
    params.set('filters[youtubeVideoId][$eq]', TEST_VIDEO_ID);
    params.set('pagination[pageSize]', '1');
    const res = await fetch(`${STRAPI_URL}/api/videos?${params.toString()}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data?: Array<{ youtubeVideoId?: string }>;
    };
    expect(json.data?.[0]?.youtubeVideoId).toBe(TEST_VIDEO_ID);
  });

  it('public role can create a tag (create permission granted)', async () => {
    if (!strapiUp) return;
    const name = `smoke-${Date.now()}`;
    const res = await fetch(`${STRAPI_URL}/api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { name } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: { name?: string } };
    // Server middleware Rule 2 normalizes → lowercase + trimmed.
    expect(json.data?.name).toBe(name.toLowerCase());
  });
});
