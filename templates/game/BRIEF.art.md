# {{title}} — 에셋 계획과 권리 확인

역할: 아트 (Claude 또는 Codex job). `~/jobs/<new-id>-art/BRIEF.md`로 복사하고 범위를 채운다.

- 새 게임: {{id}}, 저장소: {{target}}
- 읽기 전용 레퍼런스: {{reference}}
- 필요한 에셋·형식·크기·용량 예산:
- 허용된 수정 범위:

입력: 새 `CONCEPT.md`, `ASSETS.md`, 복제된 에셋과 원본 LICENSE/NOTICE. 레퍼런스의 표현을 참고하되 복제 사실을 사용 권리로 간주하지 않는다. 모든 사용 파일을 `assets/LICENSES.md`에 등록하고 CC0의 원문 URL·작성자·날짜 또는 직접 제작한 기록을 남긴다. 기존 `assets/REFERENCE-LICENSES.md`가 있으면 과거 고지로 보존하며 신규 승인 증거로 사용하지 않는다.

허용: 확인된 CC0, 직접 작성한 SVG/CSS/기하 도형 및 직접 제작한 에셋. 금지: 유료 모델/API 호출, 에셋 구매, 권리 불명 파일·상업 캐릭터·브랜드 복제. 이미지/영상/오디오가 필요하면 승인된 작업 체계의 `hf-gen` 요청을 사용하되 유료 실행은 허용되지 않는다. 비용 없이 가능한지 확인할 수 없으면 실행하지 말고 차단 사유를 남긴다.

출력: 실제 허용 에셋, 완성된 `ASSETS.md`, `assets/LICENSES.md`, job `REPORT.md`. 모든 사용 파일의 권리 확인, 모바일·데스크톱 가독성, 크기 예산 통과가 종료 조건이다. 미확인 파일은 사용 대상에서 제거하거나 대체한다. 전체 검토 후 coordinator만 새 manifest의 assets evidence를 갱신한다.

비밀·50MB 초과 파일을 Git에 넣지 않는다. 원본 수정·자동 배포 금지. 병합·릴리스·배포·공개에는 명시 오너 승인이 필요하다. GitHub는 `junheony` 아래만 사용한다. 작업 상태는 `account.txt`, `pid.txt`, `run.log`로 남기며 보고서 마지막 줄은 `STATUS: DONE` 또는 `STATUS: BLOCKED: <이유>`다.
