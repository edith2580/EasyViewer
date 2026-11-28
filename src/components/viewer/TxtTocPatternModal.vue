<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { compileTxtTocRule, formatTxtTocRuleExample } from '@/engines/txt/txtEngine'
import { ArrowLeft, ListTree, Plus, Trash2, X } from 'lucide-vue-next'

defineProps<{
  open: boolean
  tocCount?: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'back'): void
}>()

const settingsStore = useSettingsStore()

const rulePrefix = ref('')
const ruleSuffix = ref('')
const ruleClosing = ref('')

const BRACKET_PAIRS: Record<string, string> = {
  '〈': '〉',
  '<': '>',
  '[': ']',
  '(': ')',
  '{': '}',
  '《': '》',
  '「': '」',
  '『': '』'
}

const DEFAULT_PATTERN_EXAMPLES = [
  '제1장 / 제1화 / 제1편',
  '76화',
  '#001 / #001화',
  'Chapter 1',
  '1. 제목',
  '### 제목',
  '〈 76. 제목 〉 / < 76화 제목 >'
]

function handlePrefixInput(e: Event) {
  const val = (e.target as HTMLInputElement).value
  rulePrefix.value = val
  const trimmed = val.trim()
  if (trimmed.length === 1 && BRACKET_PAIRS[trimmed] && !ruleClosing.value) {
    ruleClosing.value = BRACKET_PAIRS[trimmed]
  }
}

const canAddRule = computed(() =>
  Boolean(rulePrefix.value.trim() || ruleSuffix.value.length > 0 || ruleClosing.value.trim())
)

const draftPreview = computed(() => {
  if (!canAddRule.value) return null
  const draft = {
    id: 'preview',
    prefix: rulePrefix.value,
    suffix: ruleSuffix.value,
    closing: ruleClosing.value,
    enabled: true
  }
  const compiled = compileTxtTocRule(draft)
  return {
    example: formatTxtTocRuleExample(draft),
    regex: compiled ? compiled.source : ''
  }
})

function handleAddRule() {
  if (!canAddRule.value) return
  settingsStore.addTxtTocRule({
    prefix: rulePrefix.value,
    suffix: ruleSuffix.value,
    closing: ruleClosing.value
  })
  rulePrefix.value = ''
  ruleSuffix.value = ''
  ruleClosing.value = ''
}

const customTocRules = computed(() => settingsStore.settings.txtTocRules ?? [])

function getRuleRegexSource(rule: {
  id: string
  prefix: string
  suffix: string
  closing?: string
  enabled: boolean
}): string {
  const compiled = compileTxtTocRule({ ...rule, enabled: true })
  return compiled ? `/${compiled.source}/i` : ''
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
    :style="{
      paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)',
      paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)',
      paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 0.75rem)',
      paddingRight: 'calc(env(safe-area-inset-right, 0px) + 0.75rem)'
    }"
    @click.self="emit('close')"
  >
    <div
      class="w-full max-w-lg max-h-full flex flex-col rounded-2xl border shadow-2xl overflow-hidden"
      :style="{
        backgroundColor: 'var(--ev-surface)',
        borderColor: 'var(--ev-border)',
        color: 'var(--ev-text)'
      }"
    >
      <!-- Header -->
      <div
        class="px-4 py-3.5 border-b flex items-center justify-between gap-2 shrink-0"
        :style="{ borderColor: 'var(--ev-border)' }"
      >
        <div class="flex items-center gap-2 min-w-0">
          <button
            type="button"
            class="p-2 -ml-1 rounded-xl opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="보기 옵션으로 돌아가기"
            @click="emit('back')"
          >
            <ArrowLeft class="w-4 h-4" />
          </button>
          <div class="min-w-0">
            <h3 class="text-sm font-bold tracking-tight flex items-center gap-1.5">
              <ListTree class="w-4 h-4 text-indigo-500 shrink-0" />
              <span class="truncate">목차 패턴 관리 (TXT)</span>
            </h3>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <span
            v-if="typeof tocCount === 'number'"
            class="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
          >
            목차 {{ tocCount }}개
          </span>
          <button
            type="button"
            class="p-2 rounded-xl opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="닫기"
            @click="emit('close')"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
        <!-- 1. 신규 패턴 추가 -->
        <section class="rounded-xl border p-4 space-y-3" :style="{ borderColor: 'var(--ev-border)' }">
          <div>
            <h4 class="text-xs font-bold uppercase tracking-wider opacity-80">신규 패턴 추가</h4>
            <p class="text-xs opacity-65 mt-1 leading-relaxed">
              <strong>시작 문자</strong> + <strong>숫자</strong> + <strong>뒷 문자</strong> (+ 선택: 닫는 문자)를 입력하면 자동으로 정규식으로 변환됩니다.
            </p>
          </div>

          <form class="space-y-3" @submit.prevent="handleAddRule">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div>
                <label class="block text-[11px] font-semibold opacity-70 mb-1">시작 문자</label>
                <input
                  :value="rulePrefix"
                  type="text"
                  placeholder="예: 〈, <, #, 제, ["
                  class="w-full px-3 py-2.5 rounded-xl border text-sm bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  :style="{ borderColor: 'var(--ev-border)' }"
                  @input="handlePrefixInput"
                />
              </div>

              <div>
                <label class="block text-[11px] font-semibold opacity-70 mb-1">숫자 뒷 문자</label>
                <input
                  v-model="ruleSuffix"
                  type="text"
                  placeholder="예: 화, 장, 회, ., 공백"
                  class="w-full px-3 py-2.5 rounded-xl border text-sm bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  :style="{ borderColor: 'var(--ev-border)' }"
                />
              </div>

              <div>
                <label class="block text-[11px] font-semibold opacity-70 mb-1">닫는 문자 (선택)</label>
                <input
                  v-model="ruleClosing"
                  type="text"
                  placeholder="예: 〉, >, ]"
                  class="w-full px-3 py-2.5 rounded-xl border text-sm bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  :style="{ borderColor: 'var(--ev-border)' }"
                />
              </div>
            </div>

            <div
              v-if="draftPreview"
              class="px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 text-xs space-y-1"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="opacity-65">매칭 예시</span>
                <span class="font-bold text-indigo-600 dark:text-indigo-400 truncate">
                  {{ draftPreview.example }}
                </span>
              </div>
              <div class="font-mono text-[11px] opacity-55 break-all">
                /{{ draftPreview.regex }}/i
              </div>
            </div>

            <button
              type="submit"
              :disabled="!canAddRule"
              class="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-semibold transition-all flex items-center justify-center gap-1.5"
            >
              <Plus class="w-4 h-4" />
              <span>패턴 추가</span>
            </button>
          </form>
        </section>

        <!-- 2. 현재 등록된 패턴 목록 -->
        <section class="rounded-xl border p-4 space-y-3" :style="{ borderColor: 'var(--ev-border)' }">
          <div class="flex items-center justify-between gap-2">
            <h4 class="text-xs font-bold uppercase tracking-wider opacity-80">
              등록된 커스텀 패턴 ({{ customTocRules.length }})
            </h4>
          </div>

          <div
            v-if="customTocRules.length === 0"
            class="py-6 text-center text-xs opacity-60 rounded-xl bg-black/[0.03] dark:bg-white/[0.03]"
          >
            등록된 커스텀 목차 패턴이 없습니다.<br />
            위 입력란에서 원하는 패턴을 추가해 보세요.
          </div>

          <ul v-else class="space-y-2">
            <li
              v-for="rule in customTocRules"
              :key="rule.id"
              class="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border"
              :style="{ borderColor: 'var(--ev-border)' }"
            >
              <label class="flex items-start gap-2.5 min-w-0 cursor-pointer select-none flex-1">
                <input
                  type="checkbox"
                  class="mt-0.5 w-4 h-4 accent-indigo-600 shrink-0"
                  :checked="rule.enabled"
                  @change="settingsStore.toggleTxtTocRule(rule.id)"
                />
                <span class="min-w-0 flex-1">
                  <span
                    class="block text-sm font-semibold truncate"
                    :class="{ 'opacity-45 line-through': !rule.enabled }"
                  >
                    {{ formatTxtTocRuleExample(rule) }}
                  </span>
                  <span class="block text-[11px] font-mono opacity-55 truncate">
                    {{ getRuleRegexSource(rule) }}
                  </span>
                </span>
              </label>
              <button
                type="button"
                class="p-2 rounded-lg opacity-65 hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 shrink-0 transition-colors"
                title="패턴 삭제"
                @click="settingsStore.removeTxtTocRule(rule.id)"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </li>
          </ul>

          <!-- 기본 내장 패턴 안내 -->
          <div class="pt-3 border-t space-y-2" :style="{ borderColor: 'var(--ev-border)' }">
            <p class="text-[11px] font-semibold opacity-60">기본 내장 목차 패턴 (항상 적용)</p>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="ex in DEFAULT_PATTERN_EXAMPLES"
                :key="ex"
                class="text-[11px] px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/10 opacity-75"
              >
                {{ ex }}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
