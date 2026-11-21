# 변경 내역 (Changelog)

## v0.2.4

### 새 기능
- **정보 탭 추가**
  - 앱 아이콘, 프로그램 이름, 현재 버전, 실행 형태(Windows 설치/포터블, macOS 앱 번들, Linux AppImage/.deb) 표시
  - **GitHub 열기**, **릴리스 페이지** 바로가기 버튼 추가
- **GitHub Release 기반 자동 업데이트**
  - 최신 릴리스 버전 비교 및 다운로드 진행률 표시
  - **Windows 설치 버전**: Inno Setup Uninstall 레지스트리를 확인해 설치 버전을 판별하고, 최신 인스톨러(`-win64-setup.exe`)를 내려받아 자동 업데이트 및 재시작
  - **Windows 포터블 버전**: 최신 포터블(`.zip`)을 내려받아 파일 교체 후 자동 재시작
  - **macOS / Linux**: `.dmg`(macOS) 및 `.AppImage`(Linux) 자동 업데이트 지원, `.deb` 패키지는 다운로드 및 설치 안내 제공
- **사용 라이브러리 정보 표시**
  - 설정 > 정보 탭에 사용 중인 오픈소스 라이브러리 목록(라이브러리, 라이선스, 설명) 표시 및 항목 더블클릭 시 프로젝트 페이지 열기
  - `src/AppInfo.h`의 `AppInfo::kUsedLibraries` 변수에서 항목을 간편하게 추가/삭제 가능

### 버그 수정
- **안정화 작업**
  - 안정화 작업

---

## v0.2.3

- Linux 에서 Windows 전용 경로 정규화 테스트가 실행되지 않도로기 cfg 분기 추가
