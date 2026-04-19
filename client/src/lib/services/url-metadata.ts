// URL metadata fetching for "share a link" / image / video posts.
// Server-side only — uses Node fetch with no DOM. Parses OG tags via
// regex (no scraping library) which handles ~95% of real-world pages.
// For YouTube, hits the public oEmbed endpoint for title + thumbnail.

export type UrlMetadataKind = 'youtube' | 'image' | 'link';

export type UrlMetadata = {
  kind: UrlMetadataKind;
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  videoId?: string;
};

export type UrlMetadataResult =
  | { success: true; data: UrlMetadata }
  | { success: false; error: string };

// =============================================================================
// URL validation — block private IPs and non-http(s) schemes (anti-SSRF)
// =============================================================================

const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/;
const PRIVATE_HOSTS = new Set(['localhost', '0.0.0.0', '::', '::1']);

export function validatePublicUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host)) return null;
  if (PRIVATE_IPV4.test(host)) return null;
  // Block private IPv4 ranges that the regex above doesn't cover
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return null;
  return parsed;
}

// =============================================================================
// YouTube — id extraction + oEmbed
// =============================================================================

export function extractYoutubeVideoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    return url.pathname.slice(1).split('/')[0] || null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }
    if (url.pathname.startsWith('/embed/')) {
      return url.pathname.slice('/embed/'.length).split('/')[0] || null;
    }
    if (url.pathname.startsWith('/shorts/')) {
      return url.pathname.slice('/shorts/'.length).split('/')[0] || null;
    }
  }
  return null;
}

async function fetchYoutubeOembed(url: string): Promise<{ title?: string; thumbnailUrl?: string }> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return {};
    const json = (await res.json()) as { title?: string; thumbnail_url?: string };
    return { title: json.title, thumbnailUrl: json.thumbnail_url };
  } catch {
    return {};
  }
}

// =============================================================================
// Image detection
// =============================================================================

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg)(\?|#|$)/i;

export function looksLikeImage(url: URL): boolean {
  return IMAGE_EXTENSIONS.test(url.pathname);
}

async function isImageContentType(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    const ct = res.headers.get('content-type') ?? '';
    return ct.startsWith('image/');
  } catch {
    return false;
  }
}

// =============================================================================
// OG / HTML metadata parsing
// =============================================================================

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function metaContent(html: string, property: string): string | null {
  // Match <meta property="og:title" content="..."> with either order
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
    'i',
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
    'i',
  );
  const m = html.match(re1) ?? html.match(re2);
  return m ? decodeEntities(m[1]) : null;
}

function parseHtmlMetadata(html: string, baseUrl: string): {
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
} {
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const fallbackTitle = titleTag ? decodeEntities(titleTag[1].trim()) : undefined;

  const ogTitle = metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title');
  const ogDescription =
    metaContent(html, 'og:description') ??
    metaContent(html, 'twitter:description') ??
    metaContent(html, 'description');
  const ogImage = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image');
  const ogSiteName = metaContent(html, 'og:site_name');

  // Resolve relative image URL against the page URL
  let imageUrl: string | undefined;
  if (ogImage) {
    try {
      imageUrl = new URL(ogImage, baseUrl).toString();
    } catch {
      imageUrl = ogImage;
    }
  }

  return {
    title: ogTitle ?? fallbackTitle,
    description: ogDescription ?? undefined,
    imageUrl,
    siteName: ogSiteName ?? undefined,
  };
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HealthAppLinkBot/1.0)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null;
    // Cap at 512 KB to prevent memory blow-up on giant pages
    const text = await res.text();
    return text.slice(0, 512 * 1024);
  } catch {
    return null;
  }
}

// =============================================================================
// Public entry point
// =============================================================================

export async function fetchUrlMetadataService(rawUrl: string): Promise<UrlMetadataResult> {
  const url = validatePublicUrl(rawUrl);
  if (!url) {
    return { success: false, error: 'Invalid or non-public URL' };
  }

  const urlString = url.toString();

  // Branch 1: YouTube
  const videoId = extractYoutubeVideoId(url);
  if (videoId) {
    const oembed = await fetchYoutubeOembed(urlString);
    return {
      success: true,
      data: {
        kind: 'youtube',
        url: urlString,
        title: oembed.title,
        imageUrl: oembed.thumbnailUrl ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        siteName: 'YouTube',
        videoId,
      },
    };
  }

  // Branch 2: image (extension OR content-type sniff)
  if (looksLikeImage(url) || (await isImageContentType(urlString))) {
    return {
      success: true,
      data: {
        kind: 'image',
        url: urlString,
        imageUrl: urlString,
      },
    };
  }

  // Branch 3: link — fetch HTML, parse OG tags
  const html = await fetchHtml(urlString);
  if (!html) {
    return {
      success: true,
      data: { kind: 'link', url: urlString },
    };
  }

  const meta = parseHtmlMetadata(html, urlString);
  return {
    success: true,
    data: {
      kind: 'link',
      url: urlString,
      title: meta.title,
      description: meta.description,
      imageUrl: meta.imageUrl,
      siteName: meta.siteName ?? url.hostname.replace(/^www\./, ''),
    },
  };
}
