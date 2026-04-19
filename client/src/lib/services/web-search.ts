// Zero-config web search for the chat tool.
//
// Uses DuckDuckGo's HTML endpoint (no API key required). Not production-
// grade — DDG can rate-limit heavy use and the HTML can shift over time —
// but perfect for a local-first single-user app proving out tool use.
//
// If you want better results later, swap the `ddgSearch` call for a
// Tavily / Brave / SerpAPI client keyed on env vars.

import { withRetry } from '#/lib/retry';

export type WebSearchResult = {
  title: string;
  snippet: string;
  url: string;
};

// Strip HTML tags and decode a small set of entities. Simpler than a full
// HTML parser — DDG's result text is plain-text + basic markup.
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// DDG's HTML result links are wrapped in a `/l/?uddg=<urlencoded>` redirect.
// We unwrap to the real URL for display.
function unwrapDdgUrl(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

async function ddgSearch(
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      // A plain desktop UA avoids DDG's stripped-down "consent-wall" response.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error(`DDG search failed: ${res.status}`);
  }
  const html = await res.text();

  // Each result block on DDG HTML has roughly:
  //   <a class="result__a" href="...">TITLE</a>
  //   <a class="result__snippet" href="...">SNIPPET</a>
  // We pair them positionally. The regex is non-greedy for robustness.
  const results: WebSearchResult[] = [];
  const blockRegex =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const [, href, titleHtml, snippetHtml] = match;
    const title = stripTags(titleHtml);
    const snippet = stripTags(snippetHtml);
    if (!title || !snippet) continue;
    results.push({
      title,
      snippet,
      url: unwrapDdgUrl(href),
    });
  }
  return results;
}

export async function webSearch(
  query: string,
  maxResults = 5,
): Promise<WebSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    return await withRetry(() => ddgSearch(trimmed, maxResults), {
      attempts: 2,
    });
  } catch (err) {
    console.error(`[web-search] failed for "${trimmed}":`, err);
    return [];
  }
}
