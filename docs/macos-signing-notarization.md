# macOS 코드 서명 & 공증 (GitHub Actions)

GitHub Actions에서 빌드한 `.dmg` / `.app`을 다운로드해 실행하면
**"안전하지 않은 앱" / "개발자를 확인할 수 없음" / "손상되었기 때문에 열 수 없음"** 으로 실행이 막히는 문제를 해결하기 위한 작업 기록과 남은 절차입니다.

> 상태 (2026-11-18): 워크플로/스크립트 수정 완료. **Apple 인증서 발급 + GitHub Secrets 등록이 남아 있음** (아래 [남은 작업](#남은-작업-체크리스트)).

---

## 1. 원인

| #   | 원인                                                                                     | 결과                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src-tauri/tauri.conf.json` 의 `bundle.macOS.signingIdentity` 가 `"-"` → **ad-hoc 서명** | `codesign -dv` 결과 `flags=0x10002(adhoc,runtime)`, `TeamIdentifier=not set`. 다운로드된 앱(quarantine)은 Gatekeeper가 차단 |
| 2   | **공증(notarization) 미수행**                                                            | Developer ID로 서명만 해도 공증이 없으면 여전히 차단                                                                        |
| 3   | `build-apple.yml` 이 `.app` 폴더를 그대로 artifact 업로드                                | `actions/upload-artifact` 는 실행 권한(x 비트)·심볼릭 링크를 보존하지 않아 다운로드 후 실행 불가                            |
| 4   | `release.yml` publish 단계가 저장소의 `build/*.dmg` 를 릴리스에 함께 업로드              | 로컬 ad-hoc 빌드(예: `build/EasyViewer_0.1.6_aarch64.dmg`)가 릴리스에 섞여 배포됨                                           |

다운로드한 앱이 정상 실행되려면 **둘 다** 필요합니다.

1. **Developer ID Application** 인증서로 서명 (Apple Development / Apple Distribution 인증서는 App Store 외부 배포용이 아님)
2. Apple **공증(notarization)** + 티켓 스테이플(staple)

---

## 2. 변경된 파일

### `scripts/ci/macos-build-signed.sh` (신규)

CI 전용 macOS 유니버설 빌드 스크립트.

1. `APPLE_CERTIFICATE`(base64 `.p12`)를 임시 키체인에 import
2. `Developer ID Application` 서명 ID 자동 탐지 (`APPLE_SIGNING_IDENTITY` 로 직접 지정 가능)
3. 임시 override 설정(`--config`)으로 `signingIdentity` 와 `hardenedRuntime: true` 를 주입해 빌드
   - `npx tauri build --target universal-apple-darwin --bundles app,dmg --config <override>`
   - Tauri가 `.app` 을 서명 → 공증 → 스테이플
4. `.dmg` 자체도 `codesign` → `xcrun notarytool submit --wait` → `xcrun stapler staple`
5. 검증: `codesign --verify --deep --strict`, `hdiutil verify`, (공증 시) `spctl --assess`, `stapler validate`
6. `.app` 을 `ditto -c -k --keepParent` 로 압축 → `EasyViewer_<ver>_universal.app.zip`
7. 마지막 줄에 `signed=<0|1> notarized=<0|1>` 출력
8. 종료 시 임시 키체인 / `.p12` / `.p8` 삭제

동작 모드:

- Secrets 없음 + `REQUIRE_MAC_SIGNING` 미설정 → 경고 후 ad-hoc 빌드 (fork PR 대비)
- Secrets 없음 + `REQUIRE_MAC_SIGNING=1` → **빌드 실패** (미서명 릴리스 방지)

> 로컬 `tauri.conf.json` 의 `"signingIdentity": "-"` 는 그대로 둡니다. 로컬 개발 빌드는 기존처럼 ad-hoc, CI에서만 override 됩니다.

### `.github/workflows/release.yml`

- macOS matrix: `build_cmd: bash scripts/ci/macos-build-signed.sh`, `bundle_path` 에 `*.app.zip` 추가
- 일반 빌드 스텝은 `if: matrix.name != 'macos-universal'`
- macOS 전용 스텝 `Build, sign and notarize macOS bundle` 추가 (Apple secrets 는 이 스텝에만 주입, `REQUIRE_MAC_SIGNING: '1'`)
- 기존 `Verify macOS bundle signature and DMG integrity` 스텝 제거 (스크립트에서 수행)
- publish 단계의 `build/*.dmg` 복사 제거, `*.app.zip` 수집 추가

### `.github/workflows/build-apple.yml`

- `npm run mac:build` → `bash scripts/ci/macos-build-signed.sh` (secrets 주입, 실패 강제 없음)
- artifact 업로드 대상: `bundle/dmg/*.dmg`, `bundle/macos/*.app.zip` (`if-no-files-found: error`)

---

## 3. 남은 작업 체크리스트

- [ ] **Developer ID Application 인증서 발급**
  - https://developer.apple.com/account/resources/certificates/list → `+` → **Developer ID Application**
  - Account Holder 권한 필요
  - CSR: 키체인 접근 → 인증서 지원 → 인증 기관에서 인증서 요청
- [ ] 발급된 `.cer` 더블클릭으로 키체인에 설치 → 키체인 접근에서 인증서(개인 키 포함) 우클릭 → **`.p12` 내보내기** (비밀번호 설정)
- [ ] base64 변환: `base64 -i DeveloperID.p12 | pbcopy`
- [ ] **앱 전용 암호** 생성: https://appleid.apple.com → 로그인 및 보안 → 앱 전용 암호
- [ ] GitHub → 저장소 → **Settings → Secrets and variables → Actions** 에 Secrets 등록 (아래 표)
- [ ] `build-apple.yml` 수동 실행(workflow_dispatch) → 로그 마지막 `signed=1 notarized=1` 확인
- [ ] artifact 의 `.dmg` 를 다운로드해 다른 Mac(또는 본인 Mac)에서 경고 없이 열리는지 확인
- [ ] (선택) 저장소에 커밋된 로컬 빌드 `build/EasyViewer_0.1.6_aarch64.dmg` 정리

### GitHub Secrets

필수 (서명):

| Secret                       | 값                       |
| ---------------------------- | ------------------------ |
| `APPLE_CERTIFICATE`          | `.p12` 의 base64 문자열  |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 내보내기 비밀번호 |

공증 — 방법 A (Apple ID):

| Secret           | 값                          |
| ---------------- | --------------------------- |
| `APPLE_ID`       | 개발자 계정 Apple ID 이메일 |
| `APPLE_PASSWORD` | 앱 전용 암호                |
| `APPLE_TEAM_ID`  | `GMXNVH8YU9`                |

공증 — 방법 B (App Store Connect API 키, A 대신 사용 가능):

| Secret             | 값                                   |
| ------------------ | ------------------------------------ |
| `APPLE_API_ISSUER` | Issuer ID                            |
| `APPLE_API_KEY`    | Key ID                               |
| `APPLE_API_KEY_P8` | `AuthKey_XXXX.p8` 파일 **내용 전체** |

선택:

| Secret                   | 값                                                                      |
| ------------------------ | ----------------------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY` | 예: `Developer ID Application: 이름 (GMXNVH8YU9)` — 미지정 시 자동 탐지 |

---

## 4. 확인 방법

CI 로그 마지막:

```
signed=1 notarized=1
```

다운로드한 파일을 로컬에서 직접 확인:

```bash
# 서명 정보 (Authority=Developer ID Application ..., TeamIdentifier=GMXNVH8YU9 이어야 함)
codesign -dv --verbose=2 /Applications/EasyViewer.app

# Gatekeeper 평가 (accepted / source=Notarized Developer ID 이어야 함)
spctl --assess --type execute --verbose=4 /Applications/EasyViewer.app

# 스테이플 확인
xcrun stapler validate EasyViewer_<ver>_universal.dmg
```

로컬에서 스크립트 동작 확인 (secrets 없이 → ad-hoc 폴백 경로):

```bash
bash scripts/ci/macos-build-signed.sh
```

> 2026-11-18 로컬 폴백 경로 실행 결과: 빌드 → `codesign --verify` → `hdiutil verify` → `.app.zip` 생성까지 성공 (`signed=0 notarized=0`). 서명/공증 경로는 인증서가 없어 아직 미검증.

---

## 5. 트러블슈팅

| 증상                                                                       | 확인/조치                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE does not contain a 'Developer ID Application' identity` | Apple Development / Distribution 인증서를 넣은 것. Developer ID Application 으로 다시 발급·내보내기           |
| `security import` 실패                                                     | `.p12` 비밀번호(`APPLE_CERTIFICATE_PASSWORD`) 불일치, 또는 base64 줄바꿈/공백 오염                            |
| `.p12` 에 개인 키가 없음                                                   | 키체인에서 인증서만이 아니라 **개인 키가 포함된 항목**을 내보내야 함                                          |
| notarytool `Invalid`                                                       | `xcrun notarytool log <submission-id> <인증 옵션>` 으로 상세 사유 확인 (Hardened Runtime, 미서명 바이너리 등) |
| notarytool 인증 실패                                                       | `APPLE_PASSWORD` 는 계정 비밀번호가 아니라 **앱 전용 암호**여야 함                                            |
| 릴리스 job 이 secrets 없다고 실패                                          | 의도된 동작(`REQUIRE_MAC_SIGNING=1`). Secrets 등록 필요                                                       |
| 받은 `.app.zip` 이 안 열림                                                 | Finder 로 압축 해제(또는 `ditto -x -k`). 다른 압축 도구는 권한/리소스 포크를 잃을 수 있음                     |

임시 우회 (본인 Mac 한정, 배포 해결책 아님):

```bash
xattr -dr com.apple.quarantine /Applications/EasyViewer.app
```

---

## 6. 참고

- Tauri v2 macOS code signing: https://v2.tauri.app/distribute/sign/macos/
- Apple Notarization: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Tauri 가 인식하는 환경 변수: `APPLE_SIGNING_IDENTITY`, `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`, `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH`
  - 스크립트는 `APPLE_API_KEY_P8`(내용)을 임시 파일로 써서 `APPLE_API_KEY_PATH` 로 넘김
  - 스크립트가 인증서를 직접 import 하므로 Tauri 실행 전 `APPLE_CERTIFICATE` 는 unset 함 (중복 import 방지)
