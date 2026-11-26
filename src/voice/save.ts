import type { Tenant } from '../tenants.js';
import type { Mark, SavedEpisode } from './contract.js';

// The Drive surface the save node needs. A real adapter lands with
// allen-ai-os#1879; until then the service runs with no Drive wired and the
// save node does nothing.
export interface VoiceDrive {
  findFileByName(folderId: string, name: string): Promise<{ id: string; name: string } | null>;
  createFile(
    folderId: string,
    name: string,
    content: Buffer | string,
    mimeType: string,
  ): Promise<{ id: string; name: string }>;
}

export const audioFileName = (date: string): string => `${date}-episode.mp3`;
export const marksFileName = (date: string): string => `${date}-marks.json`;

async function findOrCreate(
  drive: VoiceDrive,
  folderId: string,
  name: string,
  content: Buffer | string,
  mimeType: string,
): Promise<string> {
  const existing = await drive.findFileByName(folderId, name);
  if (existing !== null) return existing.id;
  return (await drive.createFile(folderId, name, content, mimeType)).id;
}

// undefined means "nothing to save to": no Drive wired, or the tenant has no
// google-drive destination. An existing file of a name is returned as is,
// never rewritten (the file name is the idempotency key).
export async function saveEpisode(
  drive: VoiceDrive | undefined,
  tenant: Tenant | undefined,
  date: string,
  audio: Buffer,
  marks: Mark[],
  durationS: number,
): Promise<SavedEpisode | undefined> {
  const destination = tenant?.destination;
  if (drive === undefined || destination === undefined || destination.type !== 'google-drive') return undefined;
  const audioName = audioFileName(date);
  const marksName = marksFileName(date);
  const marksJson = `${JSON.stringify({ date, duration_s: durationS, marks }, null, 2)}\n`;
  const audioId = await findOrCreate(drive, destination.folder_id, audioName, audio, 'audio/mpeg');
  const marksId = await findOrCreate(drive, destination.folder_id, marksName, marksJson, 'application/json');
  return { audio_file_id: audioId, marks_file_id: marksId, names: [audioName, marksName] };
}
