# EasyViewer

심플한 Text, epub 범용 문서 뷰어

## 지원 기능

### 옵션

- 세로 스크롤 / 가로 페이지 넘김
- 글꼴 종류, 크기, 줄 간격 조절
- 다크 모드 / 세피아 모드

### 뷰어

- 목차 및 챕터 이동 (EPUB전용)
- 책갈피 및 읽던 위치 저장
- TXT / EPUB 통합 검색
- 마지막 읽은 페이지 동기화
- 네트워크 파일 다운로드 및 오프라인 읽기

## 개발 정보

개발 언어 : Vue3 + Typescript + Tauri 2 + epub.js

지원 플랫폼 : Windows, MacOS, Android, IOS, Web

디자인 : tailwindcss 기반

---

## 개발 구현 계획서

### 1. 아키텍처 및 기술 스택 설계

| 구분              | 기술 스택                            | 주요 역할                                                                               |
| :---------------- | :----------------------------------- | :-------------------------------------------------------------------------------------- |
| **프레임워크**    | Vue 3 (Composition API) + TypeScript | 컴포넌트 기반 UI 구축 및 타입 안정성 확보                                               |
| **상태 관리**     | Pinia                                | 뷰어 설정(글꼴, 테마, 보기 방식), 책갈피, 독서 진행률 상태 관리                         |
| **스타일링**      | Tailwind CSS                         | 반응형 레이아웃 및 다크/세피아 테마 스타일링                                            |
| **문서 엔진**     | `epub.js` / Custom Text Engine       | EPUB 파싱·렌더링 및 대용량 TXT 청크 분할·인코딩 감지(`TextDecoder`)                     |
| **크로스 플랫폼** | Tauri 2 + Web Fallback Adapter       | 데스크톱(Windows, macOS)·모바일(Android, iOS) 네이티브 기능 및 Web(IndexedDB) 호환 계층 |

### 2. 디렉토리 구조 (안)

```text
EasyViewer/
├── src/
│   ├── assets/             # 폰트, 아이콘, 글로벌 스타일 (Tailwind)
│   ├── components/
│   │   ├── common/         # 공통 UI (모달, 토스트, 슬라이더 등)
│   │   ├── library/        # 서재 목록, 네트워크 파일 다운로드 UI
│   │   └── viewer/         # 뷰어 헤더/푸터, 설정 패널, 목차/책갈피/검색 드로어
│   ├── engines/
│   │   ├── epub/           # epub.js 래퍼, CFI 위치 추적, 테마/폰트 주입기
│   │   └── txt/            # TXT 인코딩 감지, 가상 스크롤 및 가로 페이지네이션 계산기
│   ├── services/
│   │   ├── storage/        # 플랫폼별 파일/데이터 저장소 추상화 (Tauri FS/Store vs Web IndexedDB)
│   │   ├── network/        # 원격 파일 다운로드 및 오프라인 캐싱 서비스
│   │   └── sync/           # 마지막 읽은 위치 및 책갈피 동기화 서비스
│   ├── stores/             # Pinia 스토어 (useSettingsStore, useBookStore, useSyncStore)
│   ├── types/              # 공통 TypeScript 인터페이스 정의
│   └── views/              # 라우터 뷰 (LibraryView, ReaderView, SettingsView)
└── src-tauri/              # Tauri 2 Rust 백엔드 (파일 시스템, 네트워크, 모바일 플러그인 설정)
```

### 3. 단계별 구현 로드맵

#### Phase 1: 프로젝트 초기 환경 구축 및 플랫폼 추상화

- [x] Vite + Vue 3 + TypeScript + Tailwind CSS 프로젝트 초기화
- [x] Tauri 2 연동 및 데스크톱(Windows, macOS) / 모바일(Android, iOS) 타겟 설정
- [x] **플랫폼 추상화 계층(Platform Adapter) 구현**: Tauri 환경(`@tauri-apps/plugin-fs`, `plugin-store`)과 Web 브라우저 환경(`IndexedDB`, `localStorage`, `File API`)에서 동일하게 동작하는 통합 인터페이스 작성

#### Phase 2: 핵심 문서 뷰어 엔진 구현 (TXT / EPUB)

- [x] **EPUB 뷰어 엔진 (`epub.js` 기반)**
  - `scrolled-doc`(세로 스크롤) 및 `paginated`(가로 페이지 넘김) 렌더링 모드 연동
  - EPUB 내장 목차(TOC) 파싱 및 챕터 간 빠른 이동 구현
  - EPUB CFI(Canonical Fragment Identifier) 기반 정밀 위치 추적
- [x] **TXT 뷰어 엔진 (Custom 렌더러)**
  - 파일 인코딩 자동 감지(UTF-8, EUC-KR 등) 및 대용량 텍스트 청크(Chunk) 분할 로드
  - 세로 가상 스크롤(Virtual Scroll) 및 `Canvas`/DOM 측정 기반 가로 페이지 분할 알고리즘 구현

#### Phase 3: 뷰어 옵션 및 테마 시스템 구현

- [x] **보기 모드 전환**: 세로 스크롤 ↔ 가로 페이지 넘김 실시간 전환 및 현재 읽던 위치 유지
- [x] **타이포그래피 제어**: 글꼴 종류(시스템 폰트 및 웹폰트), 글자 크기, 줄 간격, 문단 여백 실시간 조절 (`epub.js` iframe 스타일 주입 및 TXT 뷰어 CSS 변수 바인딩)
- [x] **컬러 테마 적용**: 기본(라이트) / 다크 모드 / 세피아 모드 프리셋 제공 및 뷰어 영역 동기화

#### Phase 4: 독서 편의 기능 (책갈피, 통합 검색, 오프라인 저장)

- [x] **책갈피 및 위치 저장**: 파일 해시(ID) 기준으로 책갈피 목록 관리 및 페이지 이동 시 마지막 읽던 위치 자동 저장
- [x] **TXT / EPUB 통합 본문 검색**
  - TXT: 정규식/문자열 매칭을 통한 라인·오프셋 추출 및 미리보기 제공
  - EPUB: 섹션별 비동기 텍스트 검색을 통한 CFI 추출, 검색어 하이라이팅 및 해당 위치 즉시 이동
- [x] **네트워크 파일 다운로드 및 오프라인 읽기**: URL 기반 원격 문서 다운로드, 진행률 표시, 로컬 스토리지(Tauri AppData 또는 Web IndexedDB) 캐싱을 통한 오프라인 서재 구축

#### Phase 5: 동기화 및 멀티 플랫폼 최적화·배포

- [x] **마지막 읽은 페이지 동기화**: 원격 스토리지/API 연동을 통한 기기 간 독서 진행률(파일 식별자, 진행 위치, 타임스탬프) 동기화 및 충돌 해결 로직 구현
- [x] **플랫폼별 UX 최적화**: 모바일 터치 스와이프/탭 영역 설정, 데스크톱 키보드 단축키(화살표, 스페이스바, 검색 단축키) 지원
- [x] **크로스 플랫폼 빌드 및 검증**: Web 배포 번들링, Windows/macOS 설치 패키지, Android(APK/AAB) 및 iOS 빌드 파이프라인 구축

---

## 실행 방법

```bash
# 패키지 설치
npm install

# 웹 개발 서버 실행 (http://localhost:1420)
npm run dev

# 프로덕션 빌드 (TypeScript 검증 및 번들링)
npm run build

# Tauri 데스크톱 앱 실행 (Rust 설치 환경)
npm run tauri dev
```

## Rust 설치

```txt
Desktop development with C++ (C++를 사용한 데스크톱 개발)

이 워크로드에 필요한 다음 구성 요소가 포함되어 있는지 확인하세요.
- MSVC C++ x64/x86 build tools
- Windows 10 또는 Windows 11 SDK
- C++ 관련 빌드 도구
```

### Rust 설치 명령어

```bash
# rustup 설치
winget install --id Rustlang.Rustup

# MSVC 툴체인 설치
rustup default stable-msvc

# rustup 업데이트
rustup update
```

### 버젼 확인

```bash
node -v
npm -v

rustc --version
cargo --version
rustup show

where.exe rustc
where.exe cargo
```

# 빌드 명령어

## windows

설치 마법사 없이 단독 .exe 실행 파일만 빠르게 빌드:

```bash
npm run tauri build -- --no-bundle
```

NSIS(setup.exe) 설치 파일만 빌드:

```bash
npm run tauri build -- --bundles nsis
```

MSI(.msi) 설치 파일만 빌드:

```bash
npm run tauri build -- --bundles msi
```

### 빌드 결과물 생성 경로

```txt
빌드가 완료되면 src-tauri/target/release/ 하위에 생성됩니다:

단독 실행 파일 (Portable .exe): src-tauri/target/release/easy-viewer.exe
NSIS 설치 프로그램: src-tauri/target/release/bundle/nsis/EasyViewer_0.1.0_x64-setup.exe
MSI 설치 패키지: src-tauri/target/release/bundle/msi/EasyViewer_0.1.0_x64_en-US.msi
```

## IOS

macOS 개발 실행

```bash
npm run mac:dev
```

macOS 유니버설(Apple Silicon + Intel) 빌드

```bash
npm run mac:build
```

아키텍처별 macOS 빌드

```bash
npm run mac:build:arm / mac:build:intel
```

iOS(Xcode) 프로젝트 생성

```bash
npm run ios:init
```

iOS 개발 실행 / 빌드

```bash
npm run ios:dev / ios:build
```

### macOS에서 직접 해야 할 일

```text
1. 실기기나 App Store용 iOS 빌드는 Xcode 설치와 Apple Developer 계정이 필요합니다. 환경변수 APPLE_DEVELOPMENT_TEAM으로 팀 ID를 지정합니다.

2. macOS 앱을 외부에 배포하려면 코드 서명과 공증(notarization)이 필요합니다.
```

### mac 에서 빌드시 Websocket 오류시 호출

```bash
kill -9 $(lsof -t -i :1420 -i :1421) 2>/dev/null; find src-tauri/target -name "lock.ios" -delete 2>/dev/null

pgrep -lf "cargo|tauri|xcodebuild|rustc"

kill -9 34094 36307 2>/dev/null; find src-tauri/target -name "lock.ios" -delete 2>/dev/null; find src-tauri/target -name ".cargo*-lock" -delete 2>/dev/null

kill -9 $(lsof -t -i :1420 -i :1421) 2>/dev/null
```
