import type { ServiceConfig } from './config.js';
import { createDriveStore } from './drive.js';
import type { DriveStore, StoredFile } from './drive.js';

// The save nodes of the digest and voice tools look a file up by its name.
// DriveStore looks a file up by one appProperties value, so the adapter stores
// the file name under that key. Names such as 2026-11-28-script.md cannot
// equal a YouTube video id, so tool 1 files in the same folder never match.
export interface NamedFileDrive {
  findFileByName(folderId: string, name: string): Promise<StoredFile | null>;
  createFile(folderId: string, name: string, content: string | Buffer, mimeType: string): Promise<StoredFile>;
}

export function namedFileDrive(store: DriveStore): NamedFileDrive {
  return {
    findFileByName: (folderId, name) => store.findFileByVideoId(folderId, name),
    createFile: (folderId, name, content, mimeType) =>
      store.createFile(folderId, name, content, mimeType, { videoId: name }),
  };
}

type DriveConfig = Pick<ServiceConfig, 'googleCredentials' | 'googleCredentialsJson' | 'googleOauthJson'>;

// undefined when none of the three Google credential variables is set: the
// save node stays off and a job result has no `saved`.
export function saveDriveFromConfig(
  config: DriveConfig,
  makeStore: typeof createDriveStore = createDriveStore,
): NamedFileDrive | undefined {
  if (
    config.googleCredentials === undefined &&
    config.googleCredentialsJson === undefined &&
    config.googleOauthJson === undefined
  ) {
    return undefined;
  }
  return namedFileDrive(
    makeStore({
      credentialsPath: config.googleCredentials,
      credentialsJson: config.googleCredentialsJson,
      oauthJson: config.googleOauthJson,
    }),
  );
}
