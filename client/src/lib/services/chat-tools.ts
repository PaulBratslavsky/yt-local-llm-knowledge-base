import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { webSearch } from '#/lib/services/web-search';

// Web search tool the chat model can call when the video's transcript
// doesn't answer a question. Kept simple — one query at a time, top
// results inlined as a compact Markdown list the model can cite.
//
// Called via TanStack AI's agent loop: the model emits a tool call, the
// adapter auto-executes `execute()` server-side, the result is fed back
// into the context, and the model resumes its response. No client-side
// plumbing needed (SSE events still just carry text deltas as far as
// the client UI cares).

const WebSearchInputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe(
      'The search query. Be specific — include the topic plus any relevant context. Use normal natural-language phrasing, not keyword fragments.',
    ),
});

const WebSearchOutputSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      snippet: z.string(),
      url: z.string(),
    }),
  ),
});

export const webSearchTool = toolDefinition({
  name: 'web_search',
  description: [
    'Search the public web for additional context when the video transcript does not answer the user\'s question.',
    'Use this sparingly — only when the video genuinely lacks the needed information (e.g., the user asks about something not covered, or wants recent/external info).',
    'Do NOT use for content that is in the transcript — ground those answers in the retrieved passages you already have.',
    'When you use search results, cite them inline with the page URL so the user can verify.',
  ].join(' '),
  inputSchema: WebSearchInputSchema,
  outputSchema: WebSearchOutputSchema,
}).server(async ({ query }) => {
  const results = await webSearch(query, 5);
  console.log(
    `[${new Date().toISOString().slice(11, 23)}] [tool web_search] "${query}" → ${results.length} results`,
  );
  return { results };
});
