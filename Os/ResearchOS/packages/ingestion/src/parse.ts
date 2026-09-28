/**
 * Turning fetched bytes into a document we can cite.
 *
 * The output is text plus *offsets*, and the offsets are the reason this is
 * more than a `strip-tags` call. Evidence points at a chunk, a chunk points at a
 * character range, and a citation locator is derived from the section that range
 * falls in. Lose the offsets and a quote can no longer be checked against its
 * source — which is the one thing this system must never allow.
 *
 * HTML is handled without a DOM library on purpose: pulling in a parser would
 * add a large dependency to a layer that must stay cheap, and the job here is
 * narrow — drop what is not prose, keep what is, and remember where it was.
 */
import { normalizeWhitespace } from "@research-os/shared";

export interface DocumentSection {
  readonly heading: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface ParsedDocument {
  readonly title: string;
  readonly text: string;
  readonly sections: DocumentSection[];
  readonly language: string | null;
  /** Metadata recovered from the markup, used to enrich the source record. */
  readonly metadata: {
    readonly authors: string[];
    readonly publishedAt: string | null;
    readonly description: string | null;
    readonly doi: string | null;
  };
}

/**
 * Sentinels marking where a heading sat, carried through tag stripping and
 * removed at the end. They are control characters precisely because no real
 * document contains them — and any that the input does contain are stripped
 * first, so content can never forge a section boundary.
 */
const HEADING_OPEN = String.fromCharCode(1);
const HEADING_CLOSE = String.fromCharCode(2);
const HEADING_MARKER = new RegExp(`${HEADING_OPEN}([^${HEADING_CLOSE}]*)${HEADING_CLOSE}`, "g");

/** Elements whose content is never prose. Removed with their contents. */
const NON_PROSE = /<(script|style|noscript|template|svg|head|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_BOUNDARY = /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|td)\s*>/gi;
const LINE_BREAK = /<(br|hr)\s*\/?>/gi;
const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const TAG = /<[^>]+>/g;

/**
 * C0 controls other than tab and newline, which normalisation handles.
 *
 * Matching control characters is the entire purpose here, so the rule that
 * warns about them is inverted in this one place: these are stripped from input
 * precisely so that the heading sentinels above cannot be forged by a document.
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: "...", copy: "(c)", reg: "(r)",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  return match?.[1] ? decodeEntities(match[1]).trim() || null : null;
}

function metaContent(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const value = firstMatch(html, pattern);
    if (value) return value;
  }
  return null;
}

export function parseHtml(html: string, fallbackTitle = "Untitled"): ParsedDocument {
  const title =
    metaContent(html, "citation_title") ??
    metaContent(html, "og:title") ??
    firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ??
    fallbackTitle;

  // Authors can appear several times; all of them are collected rather than
  // just the first, because author overlap is how independence is judged later.
  const authors = new Set<string>();
  for (const pattern of [
    /<meta[^>]+name=["']citation_author["'][^>]*content=["']([^"']*)["']/gi,
    /<meta[^>]+name=["']author["'][^>]*content=["']([^"']*)["']/gi,
  ]) {
    for (const match of html.matchAll(pattern)) {
      const author = decodeEntities(match[1] ?? "").trim();
      if (author) authors.add(author);
    }
  }

  const body = html.replace(CONTROL_CHARS, " ").replace(COMMENTS, "").replace(NON_PROSE, " ");

  const withMarkers = body.replace(HEADING, (_match, _level, content: string) => {
    const heading = normalizeWhitespace(decodeEntities(content.replace(TAG, " ")));
    return heading ? `\n\n${HEADING_OPEN}${heading}${HEADING_CLOSE}\n\n` : "\n\n";
  });

  const text = normalizeWhitespace(
    decodeEntities(withMarkers.replace(BLOCK_BOUNDARY, "\n\n").replace(LINE_BREAK, "\n").replace(TAG, " ")),
  );

  const { cleanText, sections } = extractSections(text);

  return {
    title: title.slice(0, 1000),
    text: cleanText,
    sections,
    language: firstMatch(html, /<html[^>]+lang=["']([^"']+)["']/i)?.slice(0, 16) ?? null,
    metadata: {
      authors: [...authors],
      publishedAt: normaliseDate(metaContent(html, "citation_publication_date") ?? metaContent(html, "article:published_time")),
      description: metaContent(html, "description") ?? metaContent(html, "og:description"),
      doi: metaContent(html, "citation_doi"),
    },
  };
}

/**
 * Removes the sentinels, recording where each section starts and ends.
 *
 * A section runs from its heading to the next heading, so an offset can be
 * resolved to a human-meaningful locator later.
 */
function extractSections(marked: string): { cleanText: string; sections: DocumentSection[] } {
  const sections: DocumentSection[] = [];
  let cleanText = "";
  let cursor = 0;
  let pending: { heading: string; startOffset: number } | null = null;

  HEADING_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADING_MARKER.exec(marked)) !== null) {
    cleanText += marked.slice(cursor, match.index);
    if (pending) sections.push({ ...pending, endOffset: cleanText.length });
    const heading = match[1] ?? "";
    pending = { heading: heading.slice(0, 500), startOffset: cleanText.length };
    cleanText += heading;
    cursor = match.index + match[0].length;
  }
  cleanText += marked.slice(cursor);
  if (pending) sections.push({ ...pending, endOffset: cleanText.length });

  return { cleanText, sections };
}

/** Plain text needs no parsing, but still needs the same shape. */
export function parsePlainText(text: string, title = "Untitled"): ParsedDocument {
  return {
    title: title.slice(0, 1000),
    text: normalizeWhitespace(text.replace(CONTROL_CHARS, " ")),
    sections: [],
    language: null,
    metadata: { authors: [], publishedAt: null, description: null, doi: null },
  };
}

function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Picks a parser from the content type. */
export function parseByContentType(content: string, contentType: string, fallbackTitle?: string): ParsedDocument {
  if (/html|xml/i.test(contentType)) return parseHtml(content, fallbackTitle);
  if (/json/i.test(contentType)) {
    try {
      return parsePlainText(JSON.stringify(JSON.parse(content), null, 2), fallbackTitle);
    } catch {
      return parsePlainText(content, fallbackTitle);
    }
  }
  return parsePlainText(content, fallbackTitle);
}

/** The section an offset falls in, used to build a citation locator. */
export function locatorFor(sections: readonly DocumentSection[], offset: number): string | null {
  for (const section of sections) {
    if (offset >= section.startOffset && offset < section.endOffset) return section.heading;
  }
  return null;
}
