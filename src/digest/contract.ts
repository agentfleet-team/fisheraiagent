import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ID_FORMATS } from '../ids.js';
import { PROFILES } from './profile.js';

// EpisodeRequest and EpisodeScript, field for field as RFC-002 fixes them.

const videoId = z.string().regex(ID_FORMATS.video);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`).getTime();
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
  });
const slot = z.number().int().min(1).max(99);

const block = z
  .object({ start: z.number().min(0), end: z.number().min(0), text: z.string() })
  .refine((b) => b.end >= b.start);

const source = z.object({
  slot,
  title: z.string().min(1),
  channel: z.string().min(1),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u)),
  published: isoDate.optional(),
  transcript: z.object({
    video_id: videoId,
    language: z.string().min(1),
    blocks: z.array(block).min(1),
  }),
});

export const MAX_SOURCES = 5;

const episodeRequest = z.object({
  profile: z.string().refine((p) => Object.hasOwn(PROFILES, p)),
  date: isoDate,
  sources: z.array(source).min(1).max(MAX_SOURCES),
  missing_slots: z.array(slot).default([]),
});

const unique = (values: unknown[]): boolean => new Set(values).size === values.length;

export type EpisodeSource = z.infer<typeof source>;
export type EpisodeRequest = z.infer<typeof episodeRequest>;

// undefined means the body is not a valid EpisodeRequest. Sources come back
// sorted by slot: the profile writes one segment per source in slot order.
export function parseEpisodeRequest(body: unknown): EpisodeRequest | undefined {
  const parsed = episodeRequest.safeParse(body);
  if (!parsed.success) return undefined;
  const { data } = parsed;
  // Slots are unique across sources and missing_slots; each source has its own video.
  if (!unique([...data.sources.map((s) => s.slot), ...data.missing_slots])) return undefined;
  if (!unique(data.sources.map((s) => s.transcript.video_id))) return undefined;
  return {
    ...data,
    sources: [...data.sources].sort((a, b) => a.slot - b.slot),
    missing_slots: [...data.missing_slots].sort((a, b) => a - b),
  };
}

// Hash of the parsed request: the same request body in any key order or with
// unknown extra keys hashes the same.
export function requestHash(request: EpisodeRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export interface SectionRef {
  video_id: string;
  start: number;
}

export type EpisodeSection =
  | { id: 'opening'; kind: 'opening'; text: string }
  | { id: string; kind: 'segment'; slot: number; video_id: string; text: string; refs: SectionRef[] }
  | { id: 'closing'; kind: 'closing'; text: string };

export interface SavedScript {
  file_id: string;
  name: string;
}

export interface EpisodeScript {
  profile: string;
  title: string;
  sections: EpisodeSection[];
  char_count: number;
  markdown: string;
  saved?: SavedScript;
}

// The shape the model must return; check.ts turns it into an EpisodeScript.
export const modelOutput = z.object({
  title: z.string().min(1),
  sections: z.array(
    z.object({
      kind: z.enum(['opening', 'segment', 'closing']),
      slot: z.number().int().optional(),
      text: z.string().min(1),
      refs: z
        .array(z.object({ video_id: z.string(), start: z.number().min(0) }))
        .optional(),
    }),
  ),
});

export type ModelOutput = z.infer<typeof modelOutput>;
