# {{title}} — 새 게임 빌드

역할: 빌드 (Claude 또는 Codex job). 이 템플릿을 `~/jobs/<new-id>-build/BRIEF.md`로 복사하고 아래 빈칸을 먼저 채운다.

- 새 게임: {{id}}
- 작업 저장소: {{target}}
- 읽기 전용 레퍼런스 ID: {{reference}}
- 작업 범위 / 제외 파일:
- 실제 빌드 명령 / 출력 경로:
- 실제 단위·게임 규칙 테스트 명령:

입력은 확정된 `CONCEPT.md`, 검토된 `ASSETS.md`와 `assets/LICENSES.md`다. 미검토 에셋은 사용하지 않는다. 새 저장소만 수정하며 레퍼런스, LIVE 대시보드와 다른 job 파일은 수정하지 않는다. 원본 코드를 실행하기 전에 패키지 hook·배포 명령을 검토한다. 의존성 설치가 필요하면 lifecycle scripts를 끈 상태에서 검토된 lockfile로 진행한다.

핵심 루프, 승패·재시작, 터치와 키보드 입력을 구현한다. 390×844와 1280×800에서 사용할 수 있어야 한다. 결과물은 실제 빌드 파일과 명령·종료코드를 기록한 job 보고서다. 가짜 테스트 결과, 과거 레퍼런스의 완료 증거·승인 재사용은 금지한다.

제약: CC0/자가제작 에셋만, 유료 모델/API·에셋 구매 금지. 비밀은 `secret-tool`에만 보관하고 로그·프롬프트·Git에 남기지 않는다. Git에 50MB 초과 파일 금지. GitHub는 `junheony` 아래만 사용한다. 자동 배포 금지. 병합·릴리스·배포·공개는 각각 해당 범위의 명시적 오너 승인 이후만 가능하다. 이 BRIEF는 승인서가 아니다.

완료 조건: 콘셉트의 완료 조건과 테스트 통과, 빌드 산출물 존재, 새 코드·에셋 검토 기록. 완료 후 coordinator가 dashboard의 `studio/games/{{id}}.json`의 build evidence를 실제 경로로 갱신한다. 새 저장소 `studio.json`은 초안 사본이다.

작업 상태 파일: `account.txt`(a/b/c/codex), 실행 중 `pid.txt`, 비밀 제거한 `run.log`. 마지막에 job 폴더 `REPORT.md`를 작성한다. 바꾼 파일, 실제 명령·종료코드, 산출물 경로, 남은 문제를 적는다. 마지막 줄은 정확히 `STATUS: DONE` 또는 `STATUS: BLOCKED: <이유>`다. `DONE`은 이 job의 완료이며 출시 승인이 아니다.
