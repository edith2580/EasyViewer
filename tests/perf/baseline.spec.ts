import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createLargeMixedTxtContent } from '../fixtures/bookFixtures'

const SEEDED_BOOK_COUNT = 50
const WARMUP_RUNS = 2
const MEASURED_RUNS = 7

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
    : Math.round(sorted[mid] * 100) / 100
}

test('captures web DOM/layout performance baseline across core user journeys', async ({ page }) => {
  test.setTimeout(90000)
  const bigTxt = createLargeMixedTxtContent(1_050_000)
  const now = Date.now()
  const targetId = 'perf-big-txt'

  // Seed IndexedDB and localStorage once so cold DB open is warmed before measurement loop
  await page.goto('/')
  await page.evaluate(
    async ({ count, targetBookId, txtBody, ts }) => {
      const books = [
        {
          id: targetBookId,
          title: '성능 기준선 대용량 TXT',
          author: '벤치마크',
          format: 'txt',
          fileSize: txtBody.length,
          addedAt: ts,
          lastOpenedAt: ts + count
        },
        ...Array.from({ length: count - 1 }, (_, i) => ({
          id: `perf-book-${i}`,
          title: `성능 시드 도서 ${i + 1}`,
          author: `저자 ${i + 1}`,
          format: 'txt',
          fileSize: 1024 + i,
          addedAt: ts + i,
          lastOpenedAt: ts + i
        }))
      ]

      localStorage.setItem('easyviewer:samples_seeded_v1', JSON.stringify(true))
      localStorage.setItem('easyviewer:library_books_v1', JSON.stringify(books))

      const encoder = new TextEncoder()
      const buf = encoder.encode(txtBody).buffer
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('EasyViewerDB', 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('book_files')) db.createObjectStore('book_files')
          if (!db.objectStoreNames.contains('key_value')) db.createObjectStore('key_value')
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['book_files', 'key_value'], 'readwrite')
          tx.objectStore('book_files').put(buf, targetBookId)
          tx.objectStore('key_value').put(JSON.stringify(books), 'library_books_v1')
          tx.objectStore('key_value').put('true', 'samples_seeded_v1')
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
    },
    { count: SEEDED_BOOK_COUNT, targetBookId: targetId, txtBody: bigTxt, ts: now }
  )

  const totalIters = WARMUP_RUNS + MEASURED_RUNS
  const libSamples: number[] = []
  const txtOpenSamples: number[] = []
  const viewModeSamples: number[] = []
  const themeSamples: number[] = []

  for (let i = 0; i < totalIters; i++) {
    // 1. library_init_ms (full page load triggers Pinia initLibrary() across 50 seeded books)
    const tLib0 = performance.now()
    await page.goto(`/?run=${i}#/`)
    await page.locator('main .grid > div').nth(SEEDED_BOOK_COUNT - 1).waitFor({ state: 'visible' })
    const libMs = performance.now() - tLib0

    // 2. large_txt_open_ms
    const tOpen0 = performance.now()
    await page.locator('main h2', { hasText: '성능 기준선 대용량 TXT' }).first().click()
    await page.locator('#txt-para-0').waitFor({ state: 'visible' })
    const openMs = performance.now() - tOpen0

    // 3. view_mode_toggle_ms (scroll -> paginated -> scroll)
    await page.getByTitle('글꼴·테마·보기 방식 옵션').click()
    const tMode0 = performance.now()
    await page.getByRole('button', { name: '가로 페이지 넘김' }).click()
    await page.locator('footer').getByText('가로 페이지').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '세로 스크롤' }).click()
    await page.locator('footer').getByText('세로 스크롤').waitFor({ state: 'visible' })
    const modeMs = performance.now() - tMode0

    // 4. theme_switch_ms (light -> dark -> sepia -> light)
    const tTheme0 = performance.now()
    await page.getByRole('button', { name: '다크' }).click()
    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await page.getByRole('button', { name: '세피아' }).click()
    await expect(page.locator('html')).toHaveClass(/theme-sepia/)
    await page.getByRole('button', { name: '라이트' }).click()
    await expect(page.locator('html')).toHaveClass(/theme-light/)
    const themeMs = performance.now() - tTheme0

    await page.getByTitle('닫기').click()

    if (i >= WARMUP_RUNS) {
      libSamples.push(Math.round(libMs * 100) / 100)
      txtOpenSamples.push(Math.round(openMs * 100) / 100)
      viewModeSamples.push(Math.round(modeMs * 100) / 100)
      themeSamples.push(Math.round(themeMs * 100) / 100)
    }
  }

  const report = {
    capturedAt: new Date().toISOString(),
    environment: `${os.platform()}-${os.arch()}-node${process.versions.node.split('.')[0]}-chromium`,
    seededBookCount: SEEDED_BOOK_COUNT,
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
    metrics: [
      { metric: 'library_init_ms', samplesMs: libSamples, medianMs: median(libSamples) },
      { metric: 'large_txt_open_ms', samplesMs: txtOpenSamples, medianMs: median(txtOpenSamples) },
      { metric: 'view_mode_toggle_ms', samplesMs: viewModeSamples, medianMs: median(viewModeSamples) },
      { metric: 'theme_switch_ms', samplesMs: themeSamples, medianMs: median(themeSamples) }
    ]
  }

  const outPath =
    process.env.EV_PERF_OUTPUT ||
    path.resolve(process.cwd(), 'test-results/perf-latest.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8')
})
