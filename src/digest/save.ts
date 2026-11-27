import type { Tenant } from '../tenants.js';
import type { SavedScript } from './contract.js';

// The Drive surface the save node needs. A real adapter lands with
// allen-ai-os#1879; until then the service runs with no Drive wired and the
// save node does nothing.
export interface DigestDrive {
  findFileByName(folderId: string, name: string): Promise<{ id: string; name: string } | null>;
  createFile(folderId: string, name: string, content: string, mimeType: string): Promise<{ id: string; name: string }>;
}

export const SCRIPT_MIME_TYPE = 'text/markdown';

export function scriptFileName(date: string): string {
  return `${date}-script.md`;
}

// undefined means "nothing to save to": no Drive wired, or the tenant has no
// google-drive destination. An existing file of the same name is returned as
// is; nothing is created or rewritten (the file name is the idempotency key).
export async function saveScript(
  drive: DigestDrive | undefined,
  tenant: Tenant | undefined,
  date: string,
  markdown: string,
): Promise<SavedScript | undefined> {
  const destination = tenant?.destination;
  if (drive === undefined || destination === undefined || destination.type !== 'google-drive') return undefined;
  const folderId = destination.folders?.digest ?? destination.folder_id;
  const name = scriptFileName(date);
  const existing = await drive.findFileByName(folderId, name);
  if (existing !== null) return { file_id: existing.id, name: existing.name };
  const created = await drive.createFile(folderId, name, markdown, SCRIPT_MIME_TYPE);
  return { file_id: created.id, name: created.name };
}
