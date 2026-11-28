import { describe, expect, it } from 'vitest'
import {
  compileTxtTocRule,
  detectAndDecodeText,
  formatTxtTocRuleExample,
  paginateTxtDocument,
  parseOffsetLocator,
  parseTxtDocument,
  recomputeTxtToc,
  searchTxtDocument
} from '@/engines/txt/txtEngine'

describe('txtEngine characterization', () => {
  it('decodes UTF-8 BOM, UTF-8, and UTF-16LE buffers accurately', () => {
    const utf8Text = '윤동주 서시\n죽는 날까지'
    const rawUtf8 = new TextEncoder().encode(utf8Text)
    const bomBuf = new Uint8Array(3 + rawUtf8.length)
    bomBuf.set([0xef, 0xbb, 0xbf], 0)
    bomBuf.set(rawUtf8, 3)

    expect(detectAndDecodeText(bomBuf.buffer)).toEqual({
      text: utf8Text,
      encoding: 'UTF-8 (BOM)'
    })
    expect(detectAndDecodeText(rawUtf8.buffer.slice(0))).toEqual({
      text: utf8Text,
      encoding: 'UTF-8'
    })

    // UTF-16LE "AB"
    const u16le = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])
    expect(detectAndDecodeText(u16le.buffer)).toEqual({
      text: 'AB',
      encoding: 'UTF-16LE'
    })
  })

  it('parses headings into TOC while ignoring hashtags like #2024년', () => {
    const sample = '제1장 시작\n평문 문장입니다.\n#2024년 회고\n#001화 프롤로그\nChapter 2'
    const parsed = parseTxtDocument(sample)

    expect(parsed.paragraphs).toHaveLength(5)
    expect(parsed.toc.map((t) => t.label)).toEqual([
      '제1장 시작',
      '#001화 프롤로그',
      'Chapter 2'
    ])
    expect(parsed.toc.every((t) => t.href.startsWith('offset:'))).toBe(true)
    expect(parsed.totalLength).toBeGreaterThan(sample.length)
  })

  it('parses angle-bracketed numeric/episode headings into TOC', () => {
    const sample = [
      '〈 76. 제목 〉',
      '〈 76화 제목 〉',
      '< 76. 제목 >',
      '< 76화 제목 >',
      '〈77화〉',
      '<78. 공백없는제목>',
      '〈 일반 괄호 문장 〉',
      '<일반 태그>'
    ].join('\n')
    const parsed = parseTxtDocument(sample)

    expect(parsed.toc.map((t) => t.label)).toEqual([
      '〈 76. 제목 〉',
      '〈 76화 제목 〉',
      '< 76. 제목 >',
      '< 76화 제목 >',
      '〈77화〉',
      '<78. 공백없는제목>'
    ])
  })

  it('compiles user custom TOC pattern rules safely and recomputes TOC dynamically', () => {
    const rules = [
      { id: 'r1', prefix: '[', suffix: '부', closing: ']', enabled: true },
      { id: 'r2', prefix: '', suffix: '회', closing: '', enabled: true },
      { id: 'r3', prefix: '★', suffix: '.', closing: '', enabled: false }
    ]

    expect(compileTxtTocRule(rules[0])).not.toBeNull()
    expect(compileTxtTocRule(rules[2])).toBeNull()
    expect(formatTxtTocRuleExample(rules[0])).toBe('[ 12부 제목 ]')

    const sample = '[ 1부 여명의 시작 ]\n일반 본문입니다.\n12회 결전\n★ 3. 비활성 규칙'
    const base = parseTxtDocument(sample)
    expect(base.toc).toHaveLength(0)

    const updated = recomputeTxtToc(base.paragraphs, rules)
    expect(updated.toc.map((t) => t.label)).toEqual(['[ 1부 여명의 시작 ]', '12회 결전'])
    expect(updated.paragraphs[0].isHeading).toBe(true)
    expect(updated.paragraphs[2].isHeading).toBe(true)
    expect(updated.paragraphs[3].isHeading).toBe(false)
  })

  it('paginates with fallback estimator keeping percentages within 0..100', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `문단 ${i + 1}: 테스트 문장입니다.`).join('\n')
    const { paragraphs, totalLength } = parseTxtDocument(lines)
    const pages = paginateTxtDocument(paragraphs, totalLength, {
      containerWidth: 800,
      containerHeight: 480,
      fontSize: 18,
      lineHeight: 1.7,
      pageMargin: 32
    })

    expect(pages.length).toBeGreaterThan(1)
    expect(pages[pages.length - 1].percentage).toBe(100)
    for (const p of pages) {
      expect(p.percentage).toBeGreaterThanOrEqual(0)
      expect(p.percentage).toBeLessThanOrEqual(100)
      expect(p.startOffset).toBeLessThanOrEqual(p.endOffset)
    }
  })

  it('searches across paragraphs and parses offset locators safely', () => {
    const raw = '제1장 별\n하늘과 바람과 별과 시\n제2장 밤\n별 헤는 밤에 적는 별'
    const { paragraphs, totalLength } = parseTxtDocument(raw)
    const hits = searchTxtDocument(paragraphs, totalLength, '별', 10)

    expect(hits.length).toBeGreaterThanOrEqual(4)
    expect(hits[0].chapterTitle).toBe('제1장 별')
    expect(hits.every((h) => h.locator.startsWith('offset:'))).toBe(true)
    expect(hits.every((h) => (h.percentage ?? 0) >= 0 && (h.percentage ?? 0) <= 100)).toBe(true)

    expect(parseOffsetLocator('offset:120')).toBe(120)
    expect(parseOffsetLocator('45')).toBe(45)
    expect(parseOffsetLocator('invalid')).toBe(0)
    expect(parseOffsetLocator(undefined)).toBe(0)
  })
})
