<script setup lang="ts">
import { ref, watch } from 'vue'
import type { BookmarkItem, SearchResultItem, TocItem } from '@/types'
import {
  ListTree,
  Bookmark,
  Search,
  Trash2,
  BookmarkPlus,
  Loader2,
  ChevronRight,
  X
} from 'lucide-vue-next'

export type DrawerTab = 'toc' | 'bookmarks' | 'search'

const props = defineProps<{
  open: boolean
  activeTab: DrawerTab
  toc: TocItem[]
  bookmarks: BookmarkItem[]
  searchResults: SearchResultItem[]
  isSearching: boolean
  currentChapter?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'update:activeTab', tab: DrawerTab): void
  (e: 'select-toc', item: TocItem): void
  (e: 'select-bookmark', item: BookmarkItem): void
  (e: 'add-bookmark'): void
  (e: 'remove-bookmark', bookmarkId: string): void
  (e: 'search', query: string): void
  (e: 'select-search', item: SearchResultItem, query: string): void
}>()

const searchQuery = ref('')

function handleSearchSubmit() {
  emit('search', searchQuery.value)
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen && props.activeTab === 'search') {
      setTimeout(() => {
        const el = document.getElementById('ev-unified-search-input')
        el?.focus()
      }, 60)
    }
  }
)

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex bg-black/40 backdrop-blur-[1px]"
    @click.self="emit('close')"
  >
    <aside
      class="w-full max-w-md h-full flex flex-col border-r shadow-2xl transition-all"
      :style="{
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)',
        color: 'var(--ev-text)'
      }"
    >
      <!-- Drawer Header & Tabs -->
      <div class="p-4 border-b flex items-center justify-between" :style="{ borderColor: 'var(--ev-border)' }">
        <div class="flex items-center gap-1 p-1 rounded-xl bg-black/5 dark:bg-white/5">
          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            :class="
              activeTab === 'toc'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'opacity-75 hover:opacity-100'
            "
            @click="emit('update:activeTab', 'toc')"
          >
            <ListTree class="w-3.5 h-3.5" />
            <span>목차 ({{ toc.length }})</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            :class="
              activeTab === 'bookmarks'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'opacity-75 hover:opacity-100'
            "
            @click="emit('update:activeTab', 'bookmarks')"
          >
            <Bookmark class="w-3.5 h-3.5" />
            <span>책갈피 ({{ bookmarks.length }})</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            :class="
              activeTab === 'search'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'opacity-75 hover:opacity-100'
            "
            @click="emit('update:activeTab', 'search')"
          >
            <Search class="w-3.5 h-3.5" />
            <span>통합 검색</span>
          </button>
        </div>

        <button
          type="button"
          class="p-1.5 rounded-lg opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10"
          @click="emit('close')"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- 1. TOC Tab -->
      <div v-if="activeTab === 'toc'" class="flex-1 overflow-y-auto p-3 space-y-1">
        <div
          v-if="toc.length === 0"
          class="h-60 flex flex-col items-center justify-center text-center px-6 opacity-60 text-sm"
        >
          <ListTree class="w-8 h-8 mb-2 opacity-50" />
          <p>표시할 목차 정보가 없습니다.</p>
        </div>

        <template v-for="item in toc" :key="item.id">
          <button
            type="button"
            class="w-full flex items-center justify-between text-left px-3 py-2.5 rounded-xl text-sm transition-colors hover:bg-indigo-500/10"
            :class="
              currentChapter === item.label
                ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-semibold'
                : ''
            "
            @click="emit('select-toc', item)"
          >
            <span class="truncate pr-2">{{ item.label }}</span>
            <ChevronRight class="w-4 h-4 shrink-0 opacity-40" />
          </button>

          <!-- Nested Subitems (EPUB hierarchical TOC) -->
          <div v-if="item.subitems && item.subitems.length > 0" class="pl-4 space-y-1">
            <button
              v-for="sub in item.subitems"
              :key="sub.id"
              type="button"
              class="w-full flex items-center justify-between text-left px-3 py-2 rounded-lg text-xs transition-colors hover:bg-indigo-500/10 opacity-85"
              @click="emit('select-toc', sub)"
            >
              <span class="truncate pr-2">· {{ sub.label }}</span>
              <ChevronRight class="w-3.5 h-3.5 shrink-0 opacity-40" />
            </button>
          </div>
        </template>
      </div>

      <!-- 2. Bookmarks Tab -->
      <div v-else-if="activeTab === 'bookmarks'" class="flex-1 flex flex-col overflow-hidden">
        <div class="p-3 border-b" :style="{ borderColor: 'var(--ev-border)' }">
          <button
            type="button"
            class="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold shadow-sm transition-colors"
            @click="emit('add-bookmark')"
          >
            <BookmarkPlus class="w-4 h-4" />
            <span>현재 읽는 위치 책갈피 추가</span>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-3 space-y-2">
          <div
            v-if="bookmarks.length === 0"
            class="h-60 flex flex-col items-center justify-center text-center px-6 opacity-60 text-sm"
          >
            <Bookmark class="w-8 h-8 mb-2 opacity-50" />
            <p>저장된 책갈피가 없습니다.<br />상단 버튼을 눌러 중요한 구절을 기록해 보세요.</p>
          </div>

          <div
            v-for="bm in bookmarks"
            :key="bm.id"
            class="group relative p-3.5 rounded-xl border transition-all hover:border-indigo-500/60 cursor-pointer"
            :style="{ borderColor: 'var(--ev-border)' }"
            @click="emit('select-bookmark', bm)"
          >
            <div class="flex items-center justify-between gap-2 mb-1">
              <span class="text-xs font-bold text-indigo-600 dark:text-indigo-400 truncate">
                {{ bm.title }}
              </span>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[11px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                  {{ bm.percentage.toFixed(1) }}%
                </span>
                <button
                  type="button"
                  class="p-1 rounded-md opacity-60 hover:opacity-100 hover:text-red-500"
                  title="책갈피 삭제"
                  @click.stop="emit('remove-bookmark', bm.id)"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <p class="text-xs opacity-80 line-clamp-2 leading-relaxed mb-1.5">
              {{ bm.excerpt }}
            </p>
            <span class="text-[11px] opacity-50">{{ formatDate(bm.createdAt) }}</span>
          </div>
        </div>
      </div>

      <!-- 3. Unified Search Tab (TXT & EPUB) -->
      <div v-else class="flex-1 flex flex-col overflow-hidden">
        <form
          class="p-3 border-b flex items-center gap-2"
          :style="{ borderColor: 'var(--ev-border)' }"
          @submit.prevent="handleSearchSubmit"
        >
          <div class="relative flex-1">
            <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
            <input
              id="ev-unified-search-input"
              v-model="searchQuery"
              type="text"
              placeholder="본문 키워드 입력 후 Enter..."
              class="w-full pl-9 pr-3 py-2 rounded-xl text-sm border bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
              :style="{ borderColor: 'var(--ev-border)' }"
            />
          </div>
          <button
            type="submit"
            :disabled="isSearching || !searchQuery.trim()"
            class="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold shrink-0 transition-colors"
          >
            검색
          </button>
        </form>

        <div class="flex-1 overflow-y-auto p-3 space-y-2">
          <div
            v-if="isSearching"
            class="h-52 flex flex-col items-center justify-center gap-2 opacity-75 text-sm"
          >
            <Loader2 class="w-6 h-6 animate-spin text-indigo-500" />
            <span>문서 전체에서 검색 중입니다...</span>
          </div>

          <div
            v-else-if="searchResults.length === 0"
            class="h-52 flex flex-col items-center justify-center text-center px-6 opacity-60 text-sm"
          >
            <Search class="w-8 h-8 mb-2 opacity-50" />
            <p>찾으실 단어나 문장을 입력해 주세요.<br />(TXT / EPUB 본문 통합 검색)</p>
          </div>

          <template v-else>
            <div class="px-1 py-1 text-xs font-semibold opacity-70">
              검색 결과 총 {{ searchResults.length }}건
            </div>
            <button
              v-for="hit in searchResults"
              :key="hit.id"
              type="button"
              class="w-full text-left p-3 rounded-xl border transition-all hover:border-indigo-500/60 hover:bg-indigo-500/5"
              :style="{ borderColor: 'var(--ev-border)' }"
              @click="emit('select-search', hit, searchQuery)"
            >
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="font-semibold text-indigo-600 dark:text-indigo-400 truncate">
                  {{ hit.chapterTitle || '본문' }}
                </span>
                <span v-if="typeof hit.percentage === 'number'" class="font-mono opacity-60">
                  {{ hit.percentage.toFixed(1) }}%
                </span>
              </div>
              <p class="text-xs leading-relaxed opacity-85 line-clamp-3">
                {{ hit.excerpt }}
              </p>
            </button>
          </template>
        </div>
      </div>
    </aside>
  </div>
</template>

