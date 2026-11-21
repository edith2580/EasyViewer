import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractChangelogSection } from '../../scripts/extract-changelog.mjs'

const ROOT_DIR = path.resolve(__dirname, '../..')

describe('Multi-platform release GitHub Actions workflows', () => {
  it('defines unified tag & dispatch release workflow covering verify, macOS universal, Windows, Linux, Android, and GitHub Release upload', () => {
    const releasePath = path.join(ROOT_DIR, '.github/workflows/release.yml')
    expect(fs.existsSync(releasePath)).toBe(true)

    const content = fs.readFileSync(releasePath, 'utf-8')
    expect(content).toMatch(/tags:\s*\n\s*-\s*['"]?v\*['"]?/)
    expect(content).toContain('workflow_dispatch:')
    expect(content).toContain('contents: write')
    expect(content).toContain('node-version: 24')
    expect(content).toContain('npm run verify')

    // Desktop matrix platforms
    expect(content).toContain('macos-latest')
    expect(content).toContain('aarch64-apple-darwin,x86_64-apple-darwin')
    expect(content).toContain('windows-latest')
    expect(content).toContain('--bundles nsis,msi')
    expect(content).toContain('_x64_portable.zip')
    expect(content).toContain('ubuntu-22.04')
    expect(content).toContain('--bundles deb,rpm,appimage')
    expect(content).toContain('libwebkit2gtk-4.1-dev')
    expect(content).toContain('APPIMAGE_EXTRACT_AND_RUN')

    // macOS: Developer ID signing + notarization (Gatekeeper-safe downloads), required for releases
    expect(content).toContain('bash scripts/ci/macos-build-signed.sh')
    expect(content).toContain("REQUIRE_MAC_SIGNING: '1'")
    expect(content).toContain('secrets.APPLE_CERTIFICATE')
    expect(content).toContain('secrets.APPLE_CERTIFICATE_PASSWORD')
    expect(content).toContain('secrets.APPLE_ID')
    expect(content).toContain('secrets.APPLE_PASSWORD')
    expect(content).toContain('secrets.APPLE_TEAM_ID')
    expect(content).toContain('bundle/macos/*.app.zip')

    // Android release APK build
    expect(content).toContain("java-version: '21'")
    expect(content).toContain('android-actions/setup-android@v4')
    expect(content).toContain('aarch64-linux-android')
    expect(content).toContain('npm run android:init')
    expect(content).toContain('npm run android:release')

    // GitHub Release upload (create or clobber existing tag release) with CI-built artifacts only.
    // Locally built build/*.dmg files are ad-hoc signed and must not be published.
    expect(content).toContain('publish-release:')
    expect(content).not.toContain('build/*.dmg')
    expect(content).toContain('scripts/extract-changelog.mjs')
    expect(content).toContain('--notes-file release-notes.md')
    expect(content).toContain('gh release edit')
    expect(content).toContain('gh release upload')
    expect(content).toContain('gh release create')
  })

  it('extracts version-specific Markdown release notes from CHANGELOG.md', () => {
    const sample = [
      '# 변경 내역 (Changelog)',
      '',
      '## v0.2.4',
      '',
      '### 새 기능',
      '- 정보 탭 추가',
      '',
      '---',
      '',
      '## [0.2.3] - 2026-11-20',
      '',
      '- Linux CI 테스트 수정'
    ].join('\n')

    expect(extractChangelogSection(sample, 'v0.2.4')).toBe('### 새 기능\n- 정보 탭 추가')
    expect(extractChangelogSection(sample, '0.2.4')).toBe('### 새 기능\n- 정보 탭 추가')
    expect(extractChangelogSection(sample, 'v0.2.3')).toBe('- Linux CI 테스트 수정')
    expect(extractChangelogSection(sample, 'v9.9.9')).toBe('')
  })

  it('ships a CI macOS build script that signs with Developer ID and notarizes', () => {
    const scriptPath = path.join(ROOT_DIR, 'scripts/ci/macos-build-signed.sh')
    expect(fs.existsSync(scriptPath)).toBe(true)

    const content = fs.readFileSync(scriptPath, 'utf-8')
    expect(content).toContain('universal-apple-darwin')
    expect(content).toContain('Developer ID Application')
    expect(content).toContain('xcrun notarytool submit')
    expect(content).toContain('xcrun stapler staple')
    expect(content).toContain('spctl --assess')
    expect(content).toContain('ditto -c -k')
  })

  it('keeps build-apple.yml scoped to manual/PR Apple validation without duplicating v* tag release triggers', () => {
    const applePath = path.join(ROOT_DIR, '.github/workflows/build-apple.yml')
    const content = fs.readFileSync(applePath, 'utf-8')

    expect(content).toContain('workflow_dispatch:')
    expect(content).toContain('pull_request:')
    expect(content).not.toMatch(/tags:\s*\n\s*-\s*['"]?v\*['"]?/)
    expect(content).toContain('node-version: 24')
    expect(content).toContain('bash scripts/ci/macos-build-signed.sh')
    expect(content).toContain('bundle/macos/*.app.zip')

    // iOS is built/uploaded locally via Xcode; no unusable simulator build in CI.
    expect(content).not.toMatch(/^\s{2}ios:/m)
    expect(content).not.toContain('aarch64-sim')
  })
})
