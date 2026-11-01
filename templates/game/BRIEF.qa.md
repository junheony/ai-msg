# {{title}} — 테스트와 화면 검증

역할: QA (Claude 또는 Codex job). `~/jobs/<new-id>-qa/BRIEF.md`로 복사 후 빈칸을 채운다.

- 새 게임: {{id}}, 저장소: {{target}}
- 빌드 파일 / 코드 revision 또는 SHA-256:
- 실제 테스트 명령:
- 로컬 또는 tailnet 미리보기 URL:
- Playwright 모듈·Chromium 위치:

콘셉트의 완료 조건, 빌드, 에셋 권리 기록을 입력으로 사용한다. 원본은 읽기 전용이다. 새 게임의 단위·게임 규칙·브라우저 테스트를 실행하고 시작→플레이→실패/승리→재시작을 실제 입력으로 확인한다. 에러·overflow·터치·키보드·포커스·축소 모션을 검토한다.

스크린샷 기본 명령:

```bash
node scripts/capture-screens.mjs http://127.0.0.1:4173 --out shots/qa-001 --viewports 390x844,1280x800
```

필요하면 `--playwright-module /설치경로/playwright/index.mjs`와 `--executable /설치경로/chromium`을 지정한다. 자동 설치/다운로드는 하지 않는다. 캡처는 첫 화면의 smoke 증거다. 메뉴·HUD·결과 등 실제 게임 흐름 테스트를 따로 수행하고 각 상태의 화면을 job `shots/`에 보관한다. 캡처만으로 게임 테스트 통과를 선언하지 않는다. 중단된 테스트는 성공으로 합치지 말고 실행별 범위를 기록한다.

출력: job `REPORT.md`, 실제 테스트 리포트, `shots/*.png` 및 캡처 `manifest.json`. 결과를 직접 검토한 뒤 통과한 증거만 dashboard manifest test 단계에 등록한다. 실패한 리포트도 보존하지만 완료 evidence로 등록하지 않는다. 테스트 대상 빌드와 이후 수정이 있으면 검증 범위를 명시한다.

제약: CC0/자가제작만, 유료 호출·구매·외부 공개·자동 배포 금지. 비밀·50MB 초과 파일 Git 금지. 병합·릴리스·배포·공개에는 명시 오너 승인이 필요하다. 이 job은 승인 권한을 갖지 않는다.

job 상태는 `account.txt`, `pid.txt`, `run.log`로 남긴다. 보고서에 실제 명령·종료코드·검증 크기·산출물 경로·미검증 항목을 기록하고 마지막 줄을 `STATUS: DONE` 또는 `STATUS: BLOCKED: <이유>`로 끝낸다.
