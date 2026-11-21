import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extracts the Markdown release notes section for `tagOrVersion` (e.g. `v0.2.4` or `0.2.4`)
 * from a CHANGELOG.md document. Returns empty string if no matching section exists.
 */
export function extractChangelogSection(markdown, tagOrVersion) {
  const normalized = String(tagOrVersion || '')
    .trim()
    .replace(/^v/i, '')
  if (!normalized) return ''

  const lines = String(markdown || '').split(/\r?\n/)
  const versionPattern = new RegExp(
    `^##\\s+\\[?v?${escapeRegExp(normalized)}\\]?(?:\\s|$|\\(|-)`,
    'i'
  )

  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (versionPattern.test(lines[i].trim())) {
      startIdx = i + 1
      break
    }
  }
  if (startIdx < 0) return ''

  const sectionLines = []
  for (let i = startIdx; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break
    sectionLines.push(lines[i])
  }

  // Trim leading/trailing blank lines and trailing Markdown horizontal rules (--- / *** / ___)
  while (sectionLines.length > 0 && sectionLines[0].trim() === '') {
    sectionLines.shift()
  }
  while (
    sectionLines.length > 0 &&
    (sectionLines[sectionLines.length - 1].trim() === '' ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(sectionLines[sectionLines.length - 1].trim()))
  ) {
    sectionLines.pop()
  }

  return sectionLines.join('\n').trim()
}

function main() {
  const args = process.argv.slice(2)
  const getArg = (flag) => {
    const idx = args.indexOf(flag)
    return idx >= 0 && args[idx + 1] !== undefined ? args[idx + 1] : ''
  }

  const tag = getArg('--tag') || args[0] || ''
  const filePath = path.resolve(process.cwd(), getArg('--file') || 'CHANGELOG.md')
  const outPath = getArg('--out')

  if (!tag) {
    console.error('[extract-changelog] --tag <version> 인자가 필요합니다.')
    process.exit(1)
  }

  let extracted = ''
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8')
    extracted = extractChangelogSection(content, tag)
  }

  if (outPath) {
    const absOut = path.resolve(process.cwd(), outPath)
    if (extracted) {
      fs.writeFileSync(absOut, `${extracted}\n`, 'utf-8')
      console.log(`[extract-changelog] ${tag} 섹션 추출 완료 (${extracted.length}자) -> ${outPath}`)
    } else {
      fs.writeFileSync(absOut, '', 'utf-8')
      console.log(`[extract-changelog] ${tag} 섹션을 찾지 못해 기본 릴리즈 노트 생성으로 폴백합니다.`)
    }
  } else if (extracted) {
    process.stdout.write(`${extracted}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
