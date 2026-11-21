<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  BookOpen,
  X,
  RefreshCw,
  Download,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Package,
  Loader2,
  Github
} from 'lucide-vue-next'
import {
  checkLatestRelease,
  getAppRuntimeInfo,
  GITHUB_REPO_URL,
  installAutoUpdate,
  openExternalUrl,
  USED_LIBRARIES,
  type AppRuntimeInfo,
  type UpdateCheckResult
} from '@/services/platform'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const appInfo = ref<AppRuntimeInfo | null>(null)
const updateResult = ref<UpdateCheckResult | null>(null)
const isCheckingUpdate = ref(false)
const updateError = ref('')
const isInstallingUpdate = ref(false)
const installStatusMsg = ref('')

const frontendLibs = computed(() => USED_LIBRARIES.filter((lib) => lib.category === 'frontend'))
const runtimeLibs = computed(() => USED_LIBRARIES.filter((lib) => lib.category === 'runtime'))

async function ensureAppInfo(): Promise<AppRuntimeInfo> {
  if (!appInfo.value) {
    appInfo.value = await getAppRuntimeInfo()
  }
  return appInfo.value
}

async function handleCheckUpdate() {
  if (isCheckingUpdate.value) return
  isCheckingUpdate.value = true
  updateError.value = ''
  installStatusMsg.value = ''
  try {
    const info = await ensureAppInfo()
    updateResult.value = await checkLatestRelease(info)
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : String(err)
  } finally {
    isCheckingUpdate.value = false
  }
}

async function handleApplyUpdate() {
  const result = updateResult.value
  const info = appInfo.value
  if (!result || !info || isInstallingUpdate.value) return

  // Desktop auto-update: download verified GitHub Release installer & launch
  if (result.canAutoUpdate && result.matchedAsset) {
    isInstallingUpdate.value = true
    updateError.value = ''
    installStatusMsg.value = `${result.matchedAsset.name} 다운로드 중...`
    try {
      await installAutoUpdate(result.matchedAsset)
      installStatusMsg.value =
        info.os === 'windows' && info.installMode === 'portable'
          ? '포터블 버전을 교체한 뒤 자동으로 다시 시작합니다...'
          : info.os === 'windows'
            ? '설치 프로그램을 실행했습니다. 잠시 후 앱이 종료되며 업데이트가 진행됩니다.'
            : '업데이트 패키지를 열었습니다. 안내에 따라 설치를 완료해 주세요.'
    } catch (err) {
      updateError.value = err instanceof Error ? err.message : String(err)
      installStatusMsg.value = ''
    } finally {
      isInstallingUpdate.value = false
    }
    return
  }

  // Android: open direct APK download link; iOS/Web: open GitHub Release page
  const targetUrl =
    info.os === 'android' && result.matchedAsset
      ? result.matchedAsset.downloadUrl
      : result.releaseUrl
  try {
    await openExternalUrl(targetUrl)
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleOpenGitHub() {
  try {
    await openExternalUrl(GITHUB_REPO_URL)
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleOpenReleasePage() {
  const url = updateResult.value?.releaseUrl || `${GITHUB_REPO_URL}/releases`
  try {
    await openExternalUrl(url)
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : String(err)
  }
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    await ensureAppInfo()
    if (!updateResult.value && !isCheckingUpdate.value) {
      void handleCheckUpdate()
    }
  }
)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-[2px]"
    @click.self="emit('close')"
  >
    <div
      class="w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden"
      :style="{
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)',
        color: 'var(--ev-text)'
      }"
    >
      <!-- Header -->
      <div
        class="px-5 py-4 border-b flex items-center justify-between shrink-0"
        :style="{ borderColor: 'var(--ev-border)' }"
      >
        <div class="flex items-center gap-3">
          <div
            class="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-sm shadow-indigo-500/20"
          >
            <BookOpen class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-extrabold tracking-tight flex items-center gap-2">
              <span>{{ appInfo?.name || 'EasyViewer' }}</span>
              <span
                class="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
              >
                v{{ appInfo?.version || '...' }}
              </span>
            </h2>
            <p class="text-[11px] opacity-65">
              {{ appInfo?.description || '심플한 Text · EPUB 범용 문서 뷰어' }}
            </p>
          </div>
        </div>

        <button
          type="button"
          class="p-1.5 rounded-lg opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          aria-label="닫기"
          @click="emit('close')"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <!-- 1. 앱 정보 -->
        <section class="rounded-xl border p-3.5 space-y-2" :style="{ borderColor: 'var(--ev-border)' }">
          <h3 class="text-xs font-bold opacity-80">앱 정보</h3>
          <div class="grid grid-cols-2 gap-y-1.5 text-xs">
            <span class="opacity-60">실행 환경</span>
            <span class="font-medium text-right">{{ appInfo?.osLabel || '-' }}</span>
            <span class="opacity-60">자동 업데이트</span>
            <span class="font-medium text-right">
              <template v-if="appInfo?.supportsAutoUpdate && appInfo?.installMode === 'portable'">
                지원됨 (포터블 자동 교체·재실행)
              </template>
              <template v-else-if="appInfo?.supportsAutoUpdate">
                지원됨 (설치기 자동 실행)
              </template>
              <template v-else>수동 다운로드 안내</template>
            </span>
          </div>
        </section>

        <!-- 2. 업데이트 정보 -->
        <section class="rounded-xl border p-3.5 space-y-3" :style="{ borderColor: 'var(--ev-border)' }">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs font-bold opacity-80 flex items-center gap-1.5">
              <Sparkles class="w-3.5 h-3.5 text-indigo-500" />
              <span>업데이트 정보</span>
            </h3>
            <button
              type="button"
              :disabled="isCheckingUpdate || isInstallingUpdate"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-semibold hover:border-indigo-500 disabled:opacity-50 transition-all"
              :style="{ borderColor: 'var(--ev-border)' }"
              @click="handleCheckUpdate"
            >
              <RefreshCw class="w-3 h-3 text-indigo-500" :class="{ 'animate-spin': isCheckingUpdate }" />
              <span>{{ isCheckingUpdate ? '확인 중...' : '업데이트 확인' }}</span>
            </button>
          </div>

          <div v-if="isCheckingUpdate && !updateResult" class="flex items-center gap-2 text-xs opacity-70 py-1">
            <Loader2 class="w-4 h-4 animate-spin text-indigo-500" />
            <span>GitHub 릴리즈에서 최신 버전을 확인하고 있습니다...</span>
          </div>

          <div
            v-else-if="updateError"
            class="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-xs"
          >
            <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
            <span class="break-all">{{ updateError }}</span>
          </div>

          <div v-else-if="updateResult" class="space-y-2.5">
            <div v-if="updateResult.hasUpdate" class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                  새 버전 사용 가능: v{{ updateResult.currentVersion }} → {{ updateResult.tagName }}
                </span>
                <span v-if="updateResult.publishedAt" class="text-[11px] opacity-60">
                  {{ formatDate(updateResult.publishedAt) }}
                </span>
              </div>

              <div
                v-if="updateResult.notes"
                class="max-h-28 overflow-y-auto rounded-lg p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap bg-black/5 dark:bg-white/5 opacity-85"
              >
                {{ updateResult.notes }}
              </div>

              <div v-if="installStatusMsg" class="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                {{ installStatusMsg }}
              </div>

              <div class="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  :disabled="isInstallingUpdate"
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold transition-all"
                  @click="handleApplyUpdate"
                >
                  <Loader2 v-if="isInstallingUpdate" class="w-3.5 h-3.5 animate-spin" />
                  <Download v-else class="w-3.5 h-3.5" />
                  <span v-if="isInstallingUpdate">다운로드 중...</span>
                  <span v-else-if="updateResult.canAutoUpdate">
                    지금 자동 업데이트
                    <template v-if="updateResult.matchedAsset?.size">
                      ({{ formatSize(updateResult.matchedAsset.size) }})
                    </template>
                  </span>
                  <span v-else-if="appInfo?.os === 'android' && updateResult.matchedAsset">
                    APK 다운로드 ({{ formatSize(updateResult.matchedAsset.size) }})
                  </span>
                  <span v-else>릴리즈 페이지에서 다운로드</span>
                </button>

                <button
                  type="button"
                  class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-all"
                  :style="{ borderColor: 'var(--ev-border)' }"
                  @click="handleOpenReleasePage"
                >
                  <span>릴리즈 노트</span>
                  <ExternalLink class="w-3 h-3 opacity-70" />
                </button>
              </div>
            </div>

            <div v-else class="flex items-center justify-between gap-2 text-xs">
              <div class="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold">
                <CheckCircle2 class="w-4 h-4 shrink-0" />
                <span>최신 버전을 사용 중입니다 ({{ updateResult.tagName }})</span>
              </div>
              <button
                type="button"
                class="inline-flex items-center gap-1 text-[11px] opacity-70 hover:opacity-100 underline"
                @click="handleOpenReleasePage"
              >
                <span>릴리즈 보기</span>
                <ExternalLink class="w-3 h-3" />
              </button>
            </div>
          </div>
        </section>

        <!-- 3. 사용한 라이브러리 목록 -->
        <section class="rounded-xl border p-3.5 space-y-3" :style="{ borderColor: 'var(--ev-border)' }">
          <h3 class="text-xs font-bold opacity-80 flex items-center gap-1.5">
            <Package class="w-3.5 h-3.5 text-indigo-500" />
            <span>사용한 오픈소스 라이브러리 ({{ USED_LIBRARIES.length }})</span>
          </h3>

          <div class="space-y-2.5 max-h-52 overflow-y-auto pr-1">
            <div>
              <p class="text-[11px] font-bold opacity-55 mb-1.5">Frontend</p>
              <ul class="space-y-1">
                <li
                  v-for="lib in frontendLibs"
                  :key="lib.name"
                  class="flex items-center justify-between gap-2 text-xs py-1 px-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04]"
                >
                  <div class="min-w-0">
                    <span class="font-semibold">{{ lib.name }}</span>
                    <span class="text-[11px] opacity-60 ml-1.5">{{ lib.purpose }}</span>
                  </div>
                  <span class="text-[11px] font-mono opacity-60 shrink-0">
                    {{ lib.version }} · {{ lib.license }}
                  </span>
                </li>
              </ul>
            </div>

            <div>
              <p class="text-[11px] font-bold opacity-55 mb-1.5">Native Runtime (Tauri / Rust)</p>
              <ul class="space-y-1">
                <li
                  v-for="lib in runtimeLibs"
                  :key="lib.name"
                  class="flex items-center justify-between gap-2 text-xs py-1 px-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04]"
                >
                  <div class="min-w-0">
                    <span class="font-semibold">{{ lib.name }}</span>
                    <span class="text-[11px] opacity-60 ml-1.5">{{ lib.purpose }}</span>
                  </div>
                  <span class="text-[11px] font-mono opacity-60 shrink-0">
                    {{ lib.version }} · {{ lib.license }}
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </div>

      <!-- Footer -->
      <div
        class="px-5 py-3.5 border-t flex items-center justify-between gap-2 shrink-0"
        :style="{ borderColor: 'var(--ev-border)' }"
      >
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:border-indigo-500 transition-all"
          :style="{ borderColor: 'var(--ev-border)' }"
          @click="handleOpenGitHub"
        >
          <Github class="w-4 h-4 text-indigo-500" />
          <span>GitHub 페이지 이동</span>
          <ExternalLink class="w-3 h-3 opacity-60" />
        </button>

        <button
          type="button"
          class="px-4 py-2 rounded-xl bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-xs font-semibold transition-all"
          @click="emit('close')"
        >
          닫기
        </button>
      </div>
    </div>
  </div>
</template>
