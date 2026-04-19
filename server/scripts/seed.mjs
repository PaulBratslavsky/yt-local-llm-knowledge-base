#!/usr/bin/env node
// Seed script — runs against a live Strapi (npm run develop) on localhost:1337.
// Idempotent: if a seed user already exists, the script skips them.
//
// Usage: node scripts/seed.mjs

const STRAPI = process.env.STRAPI_URL || 'http://localhost:1337';

const SEED_USERS = [
  {
    username: 'alice',
    email: 'alice@example.com',
    password: 'hunter2hunter2',
    heightCm: 165,
    bio: 'morning runs, evening yoga, slow living',
    posts: [
      { caption: 'Day 1 — keeping it honest. Slow walk, deep breaths.', waistCm: 70 },
      { caption: 'Two weeks in. Feeling lighter. The number is just a number.', waistCm: 68 },
      { caption: 'Bad week. Posting anyway because that\'s the deal.', waistCm: 72 },
    ],
  },
  {
    username: 'bob',
    email: 'bob@example.com',
    password: 'hunter2hunter2',
    heightCm: 180,
    bio: 'desk worker trying to move more',
    posts: [
      { caption: 'Starting line. No filters.', waistCm: 95 },
      { caption: 'Month one. Walking 8k a day.', waistCm: 92 },
    ],
  },
  {
    username: 'carol',
    email: 'carol@example.com',
    password: 'hunter2hunter2',
    heightCm: 170,
    bio: 'small steps. trying.',
    posts: [
      { caption: 'First check-in. Showing up is half of it.', waistCm: 105 },
      { caption: 'Walked the dog twice today. Win.', waistCm: 104 },
    ],
  },
];

async function http(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${STRAPI}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function loginOrRegister(user) {
  // Try login first (idempotency)
  try {
    const result = await http('POST', '/api/auth/local', {
      body: { identifier: user.email, password: user.password },
    });
    return { jwt: result.jwt, user: result.user, fresh: false };
  } catch (e) {
    // Not registered yet — register
  }
  const result = await http('POST', '/api/auth/local/register', {
    body: { username: user.username, email: user.email, password: user.password },
  });
  return { jwt: result.jwt, user: result.user, fresh: true };
}

async function getMyProfile(token) {
  const me = await http('GET', '/api/users/me?populate[profile][populate]=avatar', { token });
  return me.profile;
}

async function ensureProfile(token, user) {
  const profile = await getMyProfile(token);
  if (!profile) {
    throw new Error(`No profile found for ${user.username} — lifecycle hook may not be wired`);
  }
  // Update profile with height + bio if missing
  if (profile.heightCm !== user.heightCm || profile.bio !== user.bio) {
    await http('PUT', `/api/profiles/${profile.documentId}`, {
      token,
      body: { data: { heightCm: user.heightCm, bio: user.bio } },
    });
  }
  return profile;
}

async function postExists(token, caption) {
  const res = await http('GET', `/api/posts?filters[caption][$eq]=${encodeURIComponent(caption)}`, { token });
  return Array.isArray(res?.data) && res.data.length > 0;
}

async function createPost(token, post) {
  if (await postExists(token, post.caption)) return { skipped: true };
  const result = await http('POST', '/api/posts', {
    token,
    body: {
      data: {
        type: 'measurement',
        caption: post.caption,
        waistCm: post.waistCm,
      },
    },
  });
  return { skipped: false, result };
}

async function main() {
  console.log(`→ Seeding against ${STRAPI}`);
  for (const user of SEED_USERS) {
    console.log(`\n• ${user.username}`);
    const { jwt, fresh } = await loginOrRegister(user);
    console.log(`  ${fresh ? 'registered' : 'logged in'}`);

    const profile = await ensureProfile(jwt, user);
    console.log(`  profile ${profile.documentId} (height=${user.heightCm}cm, bio set)`);

    for (const post of user.posts) {
      const { skipped } = await createPost(jwt, post);
      const whtr = (post.waistCm / user.heightCm).toFixed(2);
      const band = whtr >= 0.6 ? '🔴' : whtr >= 0.5 || whtr < 0.4 ? '🟡' : '🟢';
      console.log(`  ${skipped ? '↷' : '✓'} ${band} WHtR ${whtr} — "${post.caption.slice(0, 50)}${post.caption.length > 50 ? '…' : ''}"`);
    }
  }
  console.log('\n✓ Seed complete.');
}

main().catch((err) => {
  console.error(`\n✗ Seed failed: ${err.message}`);
  process.exit(1);
});
