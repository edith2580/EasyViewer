# Implementation Plan: 헌법 준수 기반 아키텍처·품질·보안 리팩토링

**Branch**: `001-constitution-compliance-refactoring` | **Date**: 2026-11-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-constitution-compliance-refactoring/spec.md`

**Note**: 이 계획 문서는 `/speckit-plan` 워크플로우의 Phase 0~1 설계 산출물이며, 구체적 작업 분해(`tasks.md`)는 `/speckit-tasks` 단계에서 생성한다.

## Summary

EasyViewer(`0.1.5` 착수 → `0.1.6-alpha` 프리릴리즈 목표) 코드베이스를 프로젝트 헌법(`v3.2.0`)의 품질·보안·아키텍처·검증 원칙에 정렬하기 위한 리팩토링 구현 계획이다. 핵심 요구사항은 (1) 테스트 하네스 부재(`package.json` 내 `test` 스크립트 미정의)를 해소하고 Tier 1(`Vitest` + `@vue/test-utils` + `jsdom` + `@tauri-apps/api/mocks`) 및 Tier 2(`Playwright` 웹 DOM·레이아웃 범위) 자동화 검증·성능 기준선 체계를 구축하며(`FR-001`~`FR-003`, `FR-011`, `FR-012`), (2) 뷰(`LibraryView.vue`)와 스토어(`useBookStore.ts`)에 남아 있는 직접 `@tauri-apps/*` 호출을 `src/services/platform/` 추상화 계층(`PlatformDialogPort`, `PlatformPathPort`, `PlatformDragDropPort`, `PlatformCredentialPort`)으로 캡슐화해 플랫폼 일관성을 확보하고(`FR-004`~`FR-006`), (3) 앱 CSP(`src-tauri/tauri.conf.json`의 `csp: null` 제거 및 `index.html` 외부 Google Fonts 제거), `/__remote_proxy` Zero-Trust(Fail-Closed Origin/메서드/크기/타임아웃·DNS Pinning·세션 논스) 및 네이티브 Rust `safe_remote_fetch` 단일 신뢰 계층(와일드카드 `http:default` 제거), EPUB Zip Bomb 사전 차단·샌드박스·새니타이즈 일관성, WebDAV `href` 경로 탐색 차단 및 평문 자격증명 제거(`v1 -> v2` 마이그레이션)를 통해 종합 보안 방어선을 구축하는 것이다(`FR-007`~`FR-010`).

기술적 접근 방식과 상세 계약은 [research.md](./research.md), [data-model.md](./data-model.md), [contracts/platform-boundary.md](./contracts/platform-boundary.md), [contracts/security-policy.md](./contracts/security-policy.md), [contracts/quality-gates.md](./contracts/quality-gates.md) 및 [quickstart.md](./quickstart.md)에 정의한다.

## Technical Context

- **Language/Version**: TypeScript `~5.6.3` (`tsconfig.json` `strict: true`), Vue `^3.5.13` (`<script setup lang="ts">`), Rust edition `2021` (`src-tauri/Cargo.toml`)
- **Primary Dependencies**:
  - Frontend (Stability-Pinned for Refactoring Parity): `vue ^3.5.13`, `pinia ^2.3.0`, `vue-router ^4.5.0`, `tailwindcss ^3.4.17`, `lucide-vue-next ^0.468.0`, `epubjs ^0.3.93`, `jszip ^3.10.1`, `vite ^6.0.5`, `vue-tsc ^2.2.0` (`SC-003` 렌더러·빌드 동등성 보장을 위해 `vite 6` / `tailwindcss 3` / `epubjs`+`jszip`을 현 리팩토링 범위에서 고정하며, 후속 트랙에서 `foliate-js` + `fflate`, `vite 8`, `vitest 5`, `tailwindcss 4` 전환을 별도 추진)
  - Tauri 2 Runtime & Plugins (macOS Modern Alignment): `@tauri-apps/api ^2.12.x`, `@tauri-apps/cli ^2.12.x` (macOS LaunchServices 재시작 수정 포함 최신 Tauri v2), 공식 플러그인(`plugin-dialog`, `plugin-fs`, `plugin-store`, `plugin-opener` 최신 `2.x`; 공식 플러그인 MSRV `1.90.0`), 자격증명 분리(`tauri-plugin-keyring-store 0.3.2` + `tauri-plugin-keyring-store-api` 유지로 5개 OS 즉시 호환 보장; 순수 `keyring v4`+`android-keyring` 경량화는 후속 트랙으로 분리), `tauri = "2"`, `reqwest 0.13` (`rustls` + `rustls-platform-verifier`, 크레이트 MSRV `1.85.0` — macOS Keychain 사설/사내 CA 신뢰 확보; WebView `@tauri-apps/plugin-http` 직접 fetch/와일드카드 `http:default` 제거), `serde`, `serde_json`
  - Planned Test & Quality Tooling (devDependencies): `Vitest` (`^3.2`, Vite 6 공식 호환 Stability-Pinned), `@vue/test-utils`, `jsdom` (Tier 1 단위·계약 테스트 및 `@tauri-apps/api/mocks` IPC 모킹), `Playwright` (Tier 2 실제 브라우저 렌더링·레이아웃·CSP·성능 검증)
- **Storage**: `PlatformStorageAdapter` (`src/services/storage/platformAdapter.ts` — Tauri 데스크톱/모바일 FS + `@tauri-apps/plugin-store` / 웹 fallback), `WebDavConnection` (`v1 -> v2` 마이그레이션으로 평문 `password` 제거 + 자격증명 포트 분리)
- **Testing**:
  - 현재 환경: 로컬 호스트 `node v24.16.0`, `npm 11.13.0`, Rust `cargo 1.100.0` / `rustc 1.100.0` (`aarch64-apple-darwin` 단일 타겟 설치; macOS universal/iOS/Android 크로스 타겟 및 실기기·공증 환경은 미보유)
  - 목표 체계: Tier 1 `npm test` (Vitest + `mockIPC`/`clearMocks`, 30초 이내 고속 피드백) + Tier 2 `test:e2e` (Playwright 실제 브라우저 검증) + `test:perf` (워밍업 제외 다회 실행 중앙값 p50 기준선) + Rust `cargo test` (`scripts/verify.mjs`로 통합 실행; Rust 툴체인 미설치 환경에서는 기본 exit `2` `BLOCKED` 반환)
- **Target Platform**: Tauri 2 Desktop (`macOS 11.0+` — 기본 비샌드박스 `.dmg` + Hardened Runtime 기준; Mac App Store App Sandbox 배포 시 `tauri-plugin-persisted-scope` 및 `com.apple.security.files.user-selected.read-write` entitlement 필수), Tauri 2 Mobile (`iOS 15.0+`, Android `scripts/android.mjs`), Web Fallback (`vite preview` / 개발 서버)
- **Project Type**: Tauri 2 + Vue 3 SPA 데스크톱·모바일 하이브리드 전자책(EPUB/TXT) 뷰어
- **Performance Goals**:
  - Tier 1 단위·계약 테스트 suites 전체 실행 <= 30s (`SC-001`) 및 `mockIPC` 기반 `initLibrary`/`prepareBookFiles` IPC 호출 횟수 상한 회귀 방지
  - Playwright 웹 DOM/레이아웃(Chromium) 범위에서 서재 초기화(`50`권 시드)·1MB+ TXT 열람·보기 모드/테마 전환 경로의 워밍업 제외 다회 실행 중앙값(p50) 기준선 측정 시 `deltaMs > 15ms && ratio > 0.10` 회귀 금지 (`FR-012`, `SC-006`) — 데스크톱 파일 I/O IPC 상한은 `mockIPC`로, 대용량 EPUB 스캔은 단위 경계로 별도 검증
- **Constraints**:
  - 버전 동기화: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (및 락파일 `package-lock.json`, `src-tauri/Cargo.lock`) 모두 `"0.1.6-alpha"` 프리릴리즈 버전 일치 유지
  - 보안: `index.html`의 Google Fonts `<link>` 제거 및 로컬/시스템 폰트 스택 전환으로 CSP 외부 폰트 호스트 예외 0건 유지; `src-tauri/tauri.conf.json` `csp: null` 제거 및 `connect-src: "'self' ipc: http://ipc.localhost blob: data:"` 제한, `CONTENT_CSP`·`jszip` Zip Bomb 사전 상한(`10,000` 엔트리/`256 MiB`)·`<base>` 정합성 강화; `/__remote_proxy`에서 Fail-Closed `Origin`/`Sec-Fetch-Site`·메서드 화이트리스트·요청/응답 상한·전체 요청 deadline(`timeoutMs`)·`X-EasyViewer-Proxy: 1` 식별 헤더·Node DNS Pinning(TOCTOU 방지)·세션 논스 게이트·WebDAV `href` 탐색 차단 적용; 네이티브는 `"http:default"` Capability 및 WebView 직접 `plugin-http` 호출을 제거하고 Rust `safe_remote_fetch`(`reqwest` `redirect::Policy::none()`, 연결 IP 고정, 바이트 상한, 명시 승인 시에만 TLS 예외) 단일 신뢰 경계로 통합; WebDAV 기억 비밀번호는 `tauri-plugin-keyring-store` + `tauri-plugin-keyring-store-api`로 OS 키체인에 분리 저장
  - 경계: `src/services/platform/`(시스템 대화상자·경로·드래그앤드롭·자격증명), `src/services/storage/`(파일·KV 영속화), `src/services/network/`(순수 SSRF 분류·원격 HTTP 경유)로 역할을 분리하고, 데스크톱 드래그앤드롭은 `tauri.conf.json` `"dragDropEnabled": true` + `isTauriEnv()` 전용 `onDragDropEvent` 단일 구독(Option A)으로 통합하며, `src/engines/{epub,txt}/`는 `@/types` 외 상위 레이어에 의존하지 않음 (`FR-006`)
  - 로컬·타겟 환경 제약: 로컬 호스트(`rustc 1.100.0`, `aarch64-apple-darwin`)에서는 `npm run verify`(빌드·Vitest·경계·버전·`cargo check && cargo test`)가 직접 실행 가능하나, 미설치 크로스 타겟(macOS universal/Android/iOS 빌드) 및 코드 서명/App Sandbox 공증·실앱 GUI/모바일 실기기 수동 검증(`T059`)은 대상 CI·실기기 환경에서 별도로 완료해야 함(또한 `cargo` 부재 호스트에서는 `verify.mjs`가 `BLOCKED` exit `2`로 정직하게 구분함)
- **Scale/Scope**: 기존 `src/` 21개 파일(뷰 2, 모달/패널 컴포넌트 4, 스토어 2, 엔진 4, 서비스 5, 타입/엔트리/라우터/스타일 4), `vite.config.ts`, `index.html`, `src-tauri/` 설정·기능·Rust 엔트리를 대상으로 점진적 리팩토링 수행

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### 1. Pre-Design Gate (Phase 0 진입 전 점검)

- **원칙 I (한국어 우선 커뮤니케이션 & 커밋 규율)**: PASS — 모든 스펙·계획·체크리스트·보고 문서는 한국어로 작성하며, 코드 식별자·테스트명·주석은 영어, 커밋은 `Conventional Commits` + 상세 한국어 본문 규정을 준수하도록 `check:commit-msg` 게이트를 설계에 포함한다.
- **원칙 II (테스트 우선 품질 보증)**: PASS (조건부 부트스트랩 필수) — 현재 `package.json`에 `test` 스크립트가 없으므로 리팩토링 본 작업 전 `Vitest` (`^3.2`) + `@vue/test-utils` + `jsdom` + `@tauri-apps/api/mocks` 부트스트랩을 최우선 단계로 배치한다. Rust `cargo test`는 호스트 툴체인 부재 시 `BLOCKED`로 구분 기록하고 CI/Rust 환경 검증을 필수로 유지한다.
- **원칙 III (무결성·현실적 검증 원칙)**: PASS — 프로덕션 코드 내 하드코딩·임시 우회·플레이스홀더(예: 프론트엔드 JS 가짜 암호화)를 금지하며, 네이티브 WebDAV 자격증명은 `tauri-plugin-keyring-store` OS 키체인 백엔드로 구현한다. 테스트 모킹은 `@tauri-apps/api/mocks`(`mockIPC`), FS/HTTP/스토리지/레이아웃 I/O 경계로만 제한한다.
- **원칙 IV (근거 기반 엔지니어링 & 최신성 검증)**: PASS — 외부 기술 결정(Tauri 2 CSP/Capabilities/`mockIPC`/Rust `reqwest` `safe_remote_fetch` vs `plugin-http` 우회 차단/`tauri-plugin-keyring-store` + `-api`, OWASP DNS Pinning, EPUB Zip Bomb/`<base>`·SVG/CSS 정화, Vitest 3.2+/Vite 6 호환)은 Phase 0 [research.md](./research.md)에서 공식 문서 기반으로 근거를 확보하고, 내부 검증은 직접 실행 결과만 보고한다.
- **원칙 V (단순하고 일관된 아키텍처 & 플랫폼 추상화)**: PASS — `LibraryView.vue`, `useBookStore.ts`, `syncService.ts`의 직접 `@tauri-apps/*`/외부 `fetch` 의존성을 제거하고 `src/services/platform/`, `src/services/storage/`, `src/services/network/` 역할별 경계로 통합한다. `epubEngine.ts`와 `txtEngine.ts`의 `@/types` 전용 의존 규율은 유지한다.
- **원칙 VI (지속적 회의주의와 검증 중심 원칙)**: PASS — 리팩토링 설계 및 구현 완료 시 항상 "의심 → 확인 → 검토 → 검증" 주기를 적용하며, `scripts/verify.mjs`는 `cargo` 부재 시 기본 종료 코드 `2`(`BLOCKED`)를 반환해 미검증 상태의 거짓 통과(`exit 0`)를 금지하고(`--frontend-only` 명시 시에만 프론트엔드 전용 게이트 통과 허용), Playwright(웹) + `mockIPC`(IPC 횟수 상한) + `cargo test`(Rust)로 검증 범위를 정직하게 분리 보고한다.
- **원칙 VII (Zero Trust 보안 원칙)**: PASS — WebView/프론트엔드 JS 검사는 우회 가능하므로 신뢰하지 않는다. 네이티브 원격 HTTP는 WebView `"http:default"` Capability를 제거하고 Rust `safe_remote_fetch`에서 SSRF·DNS/IP·리다이렉트·응답 크기·TLS 예외를 원자 강제하며, `/__remote_proxy`는 Fail-Closed Origin·메서드·크기/타임아웃·세션 논스 게이트를 적용하고, EPUB/WebDAV 입력은 사전 크기·엔트리·경로 검증으로 차단한다.
- **품질 게이트 & 기술 제약**: PASS — `vue-tsc -b && vite build`, `npm test`, 경계 위반 검사, 버전(`0.1.6-alpha` 포함 매니페스트·락파일) 동기화 검사, CSP 설정 강화를 모두 계약([contracts/quality-gates.md](./contracts/quality-gates.md), [contracts/security-policy.md](./contracts/security-policy.md))으로 고정한다.

### 2. Post-Design Gate (Phase 1 설계 완료 후 재점검)

- **플랫폼 추상화 vs 과도한 추상화 방지 (원칙 V)**: PASS — [contracts/platform-boundary.md](./contracts/platform-boundary.md)는 `FR-004`에서 플랫폼 분기가 실제로 필요한 4개 영역(`PlatformDialogPort` 지연 `readBuffer()`, `PlatformPathPort`, `PlatformDragDropPort`, `PlatformCredentialPort`)만 포트화하고, 표준 웹 DOM UI 제어(`window` 이벤트, `getSelection`, 테마 클래스 조작)는 뷰/스토어에 남겨 불필요한 래퍼 남발을 방지했다.
- **데이터 모델 및 하위 호환 마이그레이션 (원칙 III·V)**: PASS — [data-model.md](./data-model.md)에서 `WebDavConnection`의 `v1 -> v2` 마이그레이션과 `tauri-plugin-keyring-store` OS 키체인 분리를 정의하여 기존 `webdav_history` 내 평문 `password`를 최초 로드 시 안전 이관·제거하고, `TrustedRemoteHostConsent` 및 동일 환경·`50`권 시드 `PerformanceBaselineReport` 스키마를 명확히 고정했다.
- **종합 보안 정책 정합성 (원칙 IV·VII·기술 제약)**: PASS — [contracts/security-policy.md](./contracts/security-policy.md)에서 (1) `index.html` Google Fonts 제거에 따른 무예외 앱 CSP 및 Playwright preview HTTP 헤더 주입 검증, (2) `src-tauri/capabilities/` `default.json`(`appdata-*-recursive`·`http:default` 제거, `$APPDATA/books/**` 한정)·`desktop.json`(드래그앤드롭 스코프 검증 포함) 최소 권한 분리, (3) `/__remote_proxy` Zero-Trust(Fail-Closed Origin·메서드·상한·타임아웃·DNS Pinning·세션 논스·WebDAV `href` 검증) 및 네이티브 Rust `safe_remote_fetch` 단일 신뢰 계층, (4) EPUB Zip Bomb 사전 검사·`<base>`/CSP 정합성·SVG/CSS `@import` 정화가 상호 충돌 없이 설계되었다.
- **테스트·성능 검증 현실성 (원칙 II·III·VI)**: PASS — Tier 1(고속 모킹 단위/계약 + `mockIPC` 호출 횟수 상한)과 Tier 2(Playwright 실제 브라우저 + CSP 헤더 주입 + 웹 DOM/레이아웃 성능) 2계층 분리 및 동일 환경·고정 `50`권 시드·워밍업 제외 중앙값(`deltaMs > 15ms && ratio > 0.10`), `verify.mjs` `BLOCKED`(exit `2`) 의미론이 플레이키 실패와 허위 통과를 모두 방지한다.

## Project Structure

### Documentation (this feature)

```text
specs/001-constitution-compliance-refactoring/
├── spec.md              # 기능 명세서 (FR-001~FR-012, SC-001~SC-006, Clarifications)
├── checklists/
│   ├── requirements.md  # 명세 품질 체크리스트 (16/16 통과)
│   └── governance.md    # 구현 무결성·품질·거버넌스 체크리스트 (T055)
├── plan.md              # 본 구현 계획서 (/speckit-plan 출력)
├── tasks.md             # Phase 1~9 구현·수렴 작업 목록 (/speckit-tasks, /speckit-converge)
├── research.md          # Phase 0 리서치 및 기술 의사결정 근거
├── data-model.md        # Phase 1 엔티티·마이그레이션·상태 계약 모델
├── quickstart.md        # Phase 1 시나리오별 검증 가이드
└── contracts/           # Phase 1 경계·보안·품질 게이트 계약
    ├── platform-boundary.md
    ├── security-policy.md
    └── quality-gates.md
```

### Source Code (repository root)

```text
.
├── README.md                                   # v0.1.6-alpha 아키텍처·품질 게이트·크로스 플랫폼 빌드·macOS Ad-Hoc 안내
├── LICENSE                                     # GNU General Public License v3.0 (원문 보존)
├── THIRD_PARTY_LICENSES.md                     # 0.1.6-alpha npm/Cargo 직접 의존성 SPDX 라이선스 고지
├── .github/workflows/
│   ├── release.yml                             # v*/수동 멀티 플랫폼 자동 릴리즈 (verify + macOS Universal/Windows NSIS/Linux deb·AppImage/Android APK)
│   └── build-apple.yml                         # PR/수동 전용 macOS Universal 서명·공증 빌드 워크플로우 (verify 게이트 + Node 24 LTS, iOS 시뮬레이터 job 제거)
├── build/                                      # 배포용 .dmg 산출물 보관 (.gitignore `!build/*.dmg`, 0.1.6-alpha 정합 유지)
├── index.html                                  # Google Fonts CDN 제거 대상
├── package.json                                # version "0.1.6-alpha"; @tauri-apps/* ^2.12.x·plugin-opener ^2.x 및 test/verify/gate 스크립트 추가 대상
├── tsconfig.json                               # strict: true, @/* -> src/*
├── vite.config.ts                              # /__remote_proxy SSRF·Origin·TLS 방어 강화 대상
├── scripts/
│   ├── android.mjs                             # 기존 Android 빌드 스크립트
│   ├── remoteProxyGuard.mjs                    # (신규) Node 전용 DNS Pinning·SSRF 소켓 가드
│   ├── check-boundaries.mjs                    # (신규) 직접 @tauri-apps/*·스토리지·비승인 fetch 및 엔진 역의존 검사
│   ├── check-version-sync.mjs                  # (신규) package.json/Cargo.toml/tauri.conf.json 및 락파일 버전 일치 검사
│   ├── check-commit-msg.mjs                    # (신규) Conventional Commits + 한국어 본문 검사
│   ├── verify.mjs                              # (신규) 통합 품질 게이트(Rust 부재 시 기본 exit 2 BLOCKED, --frontend-only 지원)
├── src/
│   ├── App.vue
│   ├── main.ts
│   ├── assets/main.css                         # 로컬/OS 폰트 스택 유지·보강
│   ├── router/index.ts
│   ├── types/
│   │   ├── index.ts                            # v2 WebDavConnection·보안/플랫폼 타입 확장
│   │   └── epubjs.d.ts
│   ├── engines/                                # (@/types 외 상위 레이어 의존 금지)
│   │   ├── epub/
│   │   │   ├── epubEngine.ts                   # jszip Zip Bomb 사전 검증·<base> 호환·sanitize/CONTENT_CSP 보강
│   │   │   └── stableScrollManager.ts
│   │   └── txt/
│   │       ├── txtEngine.ts
│   │       └── txtMeasuredPagination.ts
│   ├── services/
│   │   ├── sampleBooks.ts
│   │   ├── platform/                           # (신규) 플랫폼 추상화 포트 및 구현체
│   │   │   ├── index.ts
│   │   │   ├── dialogService.ts
│   │   │   ├── pathService.ts
│   │   │   ├── dragDropService.ts
│   │   │   └── credentialService.ts            # 세션 메모리 + tauri-plugin-keyring-store 연동
│   │   ├── storage/
│   │   │   └── platformAdapter.ts              # 기존 스토리지 어댑터, openStorageDir(@tauri-apps/plugin-opener openPath) 및 v1->v2 마이그레이션 연계
│   │   ├── network/
│   │   │   ├── ssrfValidator.ts                # (신규) 브라우저/Node 공용 순수 URL·CIDR 분류기
│   │   │   ├── remoteFetch.ts                  # (신규) 네이티브(Rust safe_remote_fetch)/프록시 통합 fetch
│   │   │   ├── webdavService.ts                # 평문 저장 제거, 신뢰 호스트 동의·자격증명·href 경로 검증 연동
│   │   │   └── downloadService.ts              # 원격 다운로드·프록시 오류 매핑 정합성
│   │   └── sync/
│   │       └── syncService.ts                  # remoteFetch.ts 경유로 직접 fetch 제거
│   ├── stores/
│   │   ├── useBookStore.ts                     # 직접 @tauri-apps/api/path 호출 제거 -> pathService
│   │   └── useSettingsStore.ts
│   ├── components/
│   │   ├── library/
│   │   │   ├── NetworkDownloadModal.vue        # 사설 NAS 신뢰 동의·자격증명 저장 옵션 UI 연계
│   │   │   └── SyncModal.vue                   # syncNow 예외 처리, 보안 차단 안내·NAS/TLS 동의 프롬프트(일시적 오프라인만 local-hub 폴백)
│   │   └── viewer/
│   │       ├── ViewerSettingsPanel.vue
│   │       └── ViewerSideDrawer.vue
│   └── views/
│       ├── LibraryView.vue                     # 직접 dialog/webview/fs 호출 제거 -> platform/*
│       └── ReaderView.vue
├── src-tauri/
│   ├── Cargo.toml                              # version = "0.1.6-alpha", reqwest 0.13(rustls+rustls-platform-verifier), tauri-plugin-opener, tauri-plugin-keyring-store 0.3.2 (http:default 제거)
│   ├── tauri.conf.json                         # version = "0.1.6-alpha", bundle.macOS.signingIdentity: "-", dragDropEnabled: true(데스크톱 sourcePath), 명시적 CSP(connect-src 와일드카드 http:/https: 제거)
│   ├── capabilities/
│   │   ├── default.json                        # 공통 최소 권한 + 모바일 $APPDATA/books/** 스코프(http:default·appdata-*-recursive 제거)
│   │   └── desktop.json                        # (신규) platforms:["linux","macOS","windows"] 데스크톱 FS·드래그앤드롭·스코프 제한 opener:allow-open-path 권한
│   └── src/
│       ├── main.rs
│       └── lib.rs                              # #[cfg(desktop)] read_validated_book_file(화이트리스트+tauri::ipc::Response 바이너리), 조상 canonicalize allow_storage_dir, safe_remote_fetch(reqwest 0.13), opener 플러그인 전환, keyring 초기화
└── tests/                                      # (신규) 2계층 자동화 테스트 및 성능 기준선
    ├── unit/                                   # Vitest + @vue/test-utils + jsdom + mockIPC
    ├── e2e/                                    # Playwright 실제 브라우저 렌더링/CSP/레이아웃 검증
    └── perf/                                   # 워밍업 제외 다회 실행 중앙값(p50) 성능 기준선
```

**Structure Decision**: 기존 Tauri 2 + Vue 3 단일 저장소 구조를 유지하면서, 플랫폼 의존성을 `src/services/platform/` 아래 4개 단일 책임 포트 모듈로 분리하고, 자동화 검증과 품질 게이트 스크립트를 각각 `tests/{unit,e2e,perf}/` 및 `scripts/`에 추가한다. 엔진(`src/engines/`)과 Rust 코어(`src-tauri/src/`)의 기존 경계는 불필요하게 이동하지 않고 계약 검증 대상으로 고정한다.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
| :--- | :--- | :--- |
| 해당 없음 (위반 없음) | `src/services/platform/`에 4개 포트(`dialogService`, `pathService`, `dragDropService`, `credentialService`)를 추가하는 것은 헌법 제5원칙(`FR-004`, `FR-005`)의 직접 API 제거 및 플랫폼 추상화 준수를 위한 최소 분리임 | 모든 플랫폼 기능을 `platformAdapter.ts` 단일 파일(이미 373줄)에 병합하면 스토리지·다이얼로그·드래그앤드롭·자격증명 책임이 혼합되어 테스트 격리와 유지보수성이 저하됨 |
