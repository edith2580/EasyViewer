import type { PlatformCapabilities } from '@/types'
import { isDesktopApp, isTauriEnv, platformStorage } from '@/services/storage/platformAdapter'
import {
  isSupportedBookFileName,
  MAX_LOCAL_BOOK_BYTES,
  platformDialog,
  type PickBookFilesResult,
  type PlatformDialogPort,
  type SelectedBookFile
} from '@/services/platform/dialogService'
import { platformPath, type PlatformPathPort } from '@/services/platform/pathService'
import {
  platformDragDrop,
  type DroppedBookInput,
  type PlatformDragDropPort
} from '@/services/platform/dragDropService'
import {
  platformCredential,
  type PlatformCredentialPort,
  type SetCredentialOptions
} from '@/services/platform/credentialService'
import {
  checkLatestRelease,
  compareSemver,
  getAppRuntimeInfo,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  installAutoUpdate,
  openExternalUrl,
  USED_LIBRARIES,
  type AppRuntimeInfo,
  type InstallMode,
  type ReleaseAssetInfo,
  type RuntimeOs,
  type UpdateCheckResult,
  type UsedLibraryItem
} from '@/services/platform/appInfoService'

export async function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  const desktop = await isDesktopApp()
  const tauri = isTauriEnv()
  return {
    canPickStorageDir: desktop,
    canOpenStorageDir: desktop,
    canDeleteLocalFile: desktop,
    supportsNativeDragDrop: desktop || tauri,
    hasSecureCredentialStore: tauri
  }
}

export {
  checkLatestRelease,
  compareSemver,
  getAppRuntimeInfo,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  installAutoUpdate,
  isDesktopApp,
  isSupportedBookFileName,
  isTauriEnv,
  MAX_LOCAL_BOOK_BYTES,
  openExternalUrl,
  platformCredential,
  platformDialog,
  platformDragDrop,
  platformPath,
  platformStorage,
  USED_LIBRARIES,
  type AppRuntimeInfo,
  type DroppedBookInput,
  type InstallMode,
  type PickBookFilesResult,
  type PlatformCredentialPort,
  type PlatformDialogPort,
  type PlatformDragDropPort,
  type PlatformPathPort,
  type ReleaseAssetInfo,
  type RuntimeOs,
  type SelectedBookFile,
  type SetCredentialOptions,
  type UpdateCheckResult,
  type UsedLibraryItem
}
