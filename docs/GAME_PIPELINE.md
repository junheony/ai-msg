# 레퍼런스로 새 게임 만들기

기존 게임은 읽기 전용 레퍼런스로 사용하고, 별도의 새 저장소에서 콘셉트부터 출시까지 진행한다. 대시보드는 `studio/games/<id>.json`이 연결한 실제 증거를 읽는다. 템플릿 파일이나 과거 게임의 성공 기록을 새 게임의 완료로 간주하지 않는다.

`select-reference → clone-template → concept → assets → build → test → preview → approval → release` 순서로 진행한다. 앞의 두 단계는 준비 작업이며 스튜디오의 퀘스트 트랙은 `concept`부터 시작한다. 단계 상태는 서버가 증거 존재와 승인 상태에서 계산한다. 사용자가 임의로 `done`을 적지 않는다. **증거 파일 존재는 품질 자동 판정이 아니다. 담당자가 내용을 검토하고 종료 조건을 통과한 새 증거만 단계에 연결한다.**

## 반드시 지킬 경계

- `~/games/neon-apex*`, `bored-brawl-vercel`, `bored-brawl-unity`, `boredbrain-wt-race`, `unity-aero-v1` 및 모든 레퍼런스 원본을 수정하지 않는다. `~/ai-msg`는 LIVE 대시보드이므로 작업하지 않는다.
- 새 저장소는 `~/games/<new-id>` 또는 `~/bbai-codex/<new-id>`에 만든다. 검증 fixture만 `/tmp/.../<new-id>`를 사용한다. 기존 대상·manifest를 덮어쓰지 않는다.
- 에셋은 **CC0 또는 직접 제작한 것만** 사용한다. 저작권 있는 타인 에셋, 출처 불명 에셋, 에셋 구매, 유료 모델/API 호출은 금지한다. 복제 코드의 LICENSE/NOTICE도 별도로 보존·준수한다.
- 비밀은 `secret-tool`에만 보관한다. Git·프롬프트·로그에 쓰지 않는다. Git에 50MB 초과 파일을 넣지 않는다. GitHub 원격은 `junheony` 소유만 허용한다.
- 자동 배포는 없다. **병합·릴리스·배포·공개 각각에 해당 범위를 명시한 오너의 OK가 필요하다.** QA 통과, job `DONE`, 승인 요청, 로컬 미리보기는 이 OK를 대신하지 않는다. 새 빌드로 바뀌면 기존 승인의 적용 범위를 재확인한다.

## 단계별 계약

| 단계 ID / 담당 | 입력 | 출력과 스튜디오 증거 | 종료 조건 / 화면 표시 |
| --- | --- | --- | --- |
| `select-reference` / 기획 Claude 또는 Codex | 기존 카드, 실제 repo·REPORT, 원하는 새 게임 범위 | 선택한 reference ID, 원본 경로, 참고할 점을 새 `CONCEPT.md`에 기록할 계획 | 원본과 새 게임 ID가 다름, 재사용 범위·권리 검토 필요 사항 확인. 아직 새 완료 단계 없음 |
| `clone-template` / 빌드 Claude 또는 Codex | 등록된 reference manifest, 읽기 전용 source, 새 ID·대상 | 새 저장소·템플릿, dashboard `studio/games/<id>.json`, 새 저장소 `studio.json` 사본 | 대상 충돌·중첩 없음, 안전 제외 확인, `git init`만 완료. 카드 status `concept`, lineage `reference`, 첫 미완료 단계 활성 |
| `concept` / 기획 Claude 또는 Codex | 레퍼런스 메커닉, 새 목표·제약 | 완성된 `<repo>/CONCEPT.md`를 concept evidence에 등록 | 핵심 루프·승패·입력·범위·정량 완료 조건 합의. 콘셉트 단계 완료 표시 |
| `assets` / 아트 Claude 또는 Codex | 확정 콘셉트, 복제 에셋 목록·고지 | `<repo>/ASSETS.md`, `<repo>/assets/LICENSES.md`, 실제 에셋. 검토된 두 문서를 assets evidence에 등록 | 모든 사용 에셋의 CC0/자가제작 근거 확인, 미확인 에셋 제거. 에셋 단계 완료; 실제 콘셉트 그림만 artifacts.concept에 추가 |
| `build` / 빌드 Claude 또는 Codex | 콘셉트·권리 검토 통과 에셋 | 실제 `<repo>/dist/...` 또는 엔진 빌드와 job REPORT. build evidence 및 artifacts.builds에 실제 경로 등록 | 빌드 명령 종료0, 핵심 루프·입력 구현, 새 빌드 식별 가능. 빌드 단계와 산출물 표시 |
| `test` / QA Claude 또는 Codex | 새 빌드·SHA-256/revision, 완료 조건 | 실제 자동 테스트 리포트, job `shots/*.png`, 캡처 `manifest.json`, REPORT. tests 배열·artifacts.screenshots·test evidence에 검토한 경로 등록 | 단위/규칙/플레이 흐름 검증, 390×844·1280×800 캡처 검토, 오류·미검증 범위 기록. 통과한 새 검증만 테스트 단계 완료 |
| `preview` / QA·빌드 Claude 또는 Codex | 테스트한 동일 빌드 | `<job>/PREVIEW.md`에 로컬/tailnet URL, 빌드 식별자, 확인 시각·방법. preview evidence와 preview 배열에 등록 | 실제 접근·조작 확인. 외부 공개 없는 링크와 미리보기 단계 표시; 오래된 URL은 제거/갱신 |
| `approval` / 릴리스 Claude 또는 Codex가 요청, 오너가 결정 | 콘셉트·에셋·QA·동일 빌드 미리보기·남은 위험 | 실제 결정 이후 `<job>/APPROVAL.md`에 오너 응답, 시간, 빌드 식별자, 허용 행동·대상 기록. approvals에 해당 결정·시각 반영 | 응답 전 pending, 거절 rejected. 명시 승인 뒤에만 approved 및 실제 기록을 approval evidence에 연결. 오너 결정 카드와 승인 단계 표시 |
| `release` / 릴리스 Claude 또는 Codex | 해당 병합/릴리스/배포/공개 범위의 실제 승인 | 승인된 행동만 실행 후 `<repo>/DEPLOYMENT.md`에 버전·해시·배포 위치·검증·롤백 기록. release evidence, 실제 URL·status 갱신 | 승인 범위 일치, 실제 배포 검증과 기록 존재. 출시 단계 완료. 후보/비공개 상태는 live로 쓰지 않음 |

`reference`는 새 manifest가 가리키는 기존 게임 ID다. 예를 들어 `reference: "neon-apex"`이면 스튜디오는 새 게임과 NEON APEX의 계보를 연결할 수 있다. 원본의 approval·tests·preview를 복사하는 의미가 아니다. `repos`에는 새 작업 경로만 등록하며 원본 자체의 manifest를 변경하지 않는다.

## 새 게임 생성

대시보드 작업 트리에서 실행한다. Python 3와 Git이 필요하며 네트워크 호출이나 설치는 하지 않는다. 레퍼런스는 지정한 `--studio-root`의 `studio/games/<reference>.json`에 등록돼 있어야 한다.

```bash
bash templates/game/scripts/new-game-from-reference.sh \
  --reference neon-apex --source "$HOME/games/neon-apex" \
  --id orbit-racer --title '오빗 레이서' \
  --target "$HOME/games/orbit-racer" \
  --studio-root "$HOME/bbai-codex/msg-studio" --dry-run
```

출력된 원본·대상·manifest·제외 수를 검토한 뒤 같은 명령에서 `--dry-run`만 빼면 생성한다. 사용자 요청에 새 게임 생성이 포함되어 있으면 이 가역적인 로컬 생성은 그 범위에서 진행한다. `--dry-run`은 계획을 읽어서 출력할 뿐 디렉터리, manifest, `.git`을 만들지 않는다.

기본 target은 `~/games/<id>`다. `--studio-root`는 **`studio/`의 부모인 대시보드 루트**다. 템플릿 원위치에서는 자동 계산되지만 새 게임으로 복제된 scripts를 다시 실행할 때는 반드시 명시한다. `id`와 target의 마지막 디렉터리 이름은 같아야 한다. `--source`는 실제 선택한 레퍼런스의 repo 경로로 지정한다.

생성기는 다음을 수행한다.

1. slug, 등록된 reference ID, source/target의 분리, 경로의 symlink 여부, 기존 target/manifest를 확인한다. 조상·자손 경로를 거부한다.
2. 소스를 읽어서 `.git`, 의존성·빌드·캐시·과거 캡처·배포/백업 출력, CI/CD, 알려진 인증 설정·비밀 파일, symlink·특수 파일, 50MB 초과 파일을 제외한다. 알려진 private key·토큰 패턴도 제외한다. LICENSE/NOTICE는 보존한다.
3. 패키지의 설치 lifecycle hook 및 알려진 deploy/publish/release 명령을 제거하고 private 패키지로 시작한다. 복제 코드는 자동 실행하지 않는다. 임의 사용자 스크립트의 배포 효과나 모든 비밀을 완전히 탐지할 수는 없으므로 실행 전 검토한다. 의존성 설치는 검토한 lockfile로 lifecycle scripts를 끄고 진행한다.
4. 템플릿의 CONCEPT/ASSETS/BRIEF와 캡처 스크립트를 적용한다. 원본 `assets/LICENSES.md`가 있으면 `assets/REFERENCE-LICENSES.md`로 보존하고 신규 검토 표는 빈 상태로 만든다.
5. 모든 evidence·artifacts·tests·jobs·preview·approvals를 빈 값으로 초기화한다. 레퍼런스의 성공·승인은 계승하지 않는다. 새 디렉터리에서만 `git init`을 한다. 커밋·원격 설정·푸시·배포는 없다.

복제된 에셋은 **권리 미검토 상태**다. 저작권 고지가 있어도 CC0/자가제작에 해당하지 않으면 새 게임에서 사용하지 않는다. 알려진 비밀 필터는 전체 비밀 탐지나 법적 권리 판정을 대신하지 않는다. 원본 소스가 복제 중 바뀌지 않는 상태에서 실행한다.

## 작업 큐와 증거 갱신

각 기능을 `~/jobs/<job>/BRIEF.md` 단위로 맡긴다. 기획은 위 concept 계약을 담은 BRIEF를 작성하고, 아트·빌드·QA는 새 저장소의 `BRIEF.art.md`, `BRIEF.build.md`, `BRIEF.qa.md`를 복사해 저장소·허용 범위·실제 명령·산출물 경로를 채운다. 릴리스 job은 실행할 행동과 받은 승인 범위를 적은 별도 BRIEF를 사용한다. Claude 또는 Codex job으로 실행하되 모델을 유료 API로 호출하지 않는다.

각 job은 `account.txt`(a/b/c/codex), `pid.txt`, `run.log`, `REPORT.md`를 사용한다. `run.log`는 비밀을 제거한 내용만 남긴다. REPORT에는 바꾼 파일·실제 명령과 종료코드·산출물·남은 문제를 쓰고, 마지막 줄을 `STATUS: DONE` 또는 `STATUS: BLOCKED: <이유>`로 끝낸다. 중단된 실행을 통과로 기록하지 않는다.

dashboard manifest의 `jobs`에 job 폴더 이름을 추가하면 스튜디오가 작업 중/완료/차단/유휴 상태를 읽는다. 연결된 REPORT의 BLOCKED는 후속 작업이 이어받았으면 `이어받음`, 오래됐으면 `중단됨`, 오너를 요구하면 `승인 필요`로 표시하며, 최근의 `막힘`만 단계 차단 정보가 된다. 코드 구현 완료와 QA 완료는 서로 다른 job 종료이며, 어느 쪽도 오너 승인으로 승격하지 않는다.

증거를 새로 만들고 검토한 뒤 **대시보드의 `studio/games/<id>.json`**을 갱신한다. 새 게임의 `studio.json`은 시작용 사본이며 자동 동기화되지 않는다. 존재하는 실제 파일은 `stages[].evidence`·`tests[].path`·`repos[].path` 등에 쓰고, 캡처 묶음은 `artifacts.screenshots`의 glob으로 연결한다. 원본 기록과 실패 리포트는 보존하되 완료 evidence에 넣지 않는다. `nextAction.text`는 가장 중요한 다음 결정/차단 하나를 한국어 60자 이내로 적는다.

```bash
node studio/validate.mjs
```

승인 요청 시에는 approvals의 `state`를 `pending`, `at`을 `null`로 두며 approval evidence는 비워 둔다. 빈 승인서 템플릿을 완료 증거로 연결하지 않는다. `approved`는 실제 오너 응답이 있고 해당 빌드와 행동에 적용될 때만 기록한다.

## 고정 화면 캡처

새 게임에서 설치된 Playwright와 Chromium을 사용한다. 도구는 의존성을 자동 설치하지 않는다.

```bash
node scripts/capture-screens.mjs http://127.0.0.1:4173 \
  --out shots/qa-001 --viewports 390x844,1280x800

node scripts/capture-screens.mjs ./dist/index.html \
  --out shots/qa-002 --selector '#game' --wait-ms 1000 \
  --playwright-module /설치된/playwright/index.mjs
```

`PLAYWRIGHT_MODULE` 환경변수로 모듈 경로를 지정할 수도 있다. 브라우저 위치가 표준 캐시에 없으면 `--executable /경로/chromium`을 쓴다. HTTP 서버가 필요한 게임은 file URL 대신 로컬 서버를 사용한다. 미리보기는 loopback 또는 접근이 제한된 tailnet에서만 제공한다. 공개 호스팅·터널 생성은 이 과정에 포함하지 않는다.

출력은 고정 viewport PNG와 `manifest.json`(크기·SHA-256·실제 캡처 결과)이다. 기존 출력 디렉터리는 덮어쓰지 않는다. 페이지/콘솔/네트워크 오류가 있거나 캡처가 실패하면 종료코드1과 실패 기록을 남긴다. 이것은 첫 화면 smoke이며 메뉴→플레이→결과의 게임 조작 검증과 시각 검토는 별도 QA가 수행한다. 캡처 통과를 게임 전체 통과로 해석하지 않는다.

## `/tmp`에서 복제 도구 검증

실제 원본을 건드리지 않으려면 임시 fixture를 사용한다. 아래는 자체 생성한 HTML만 읽으며 격리된 dashboard root에 manifest를 쓴다. 유료 호출·공개·원본 Git 변경은 없다.

```bash
fixture=$(mktemp -d /tmp/game-pipeline.XXXXXX)
mkdir -p "$fixture/source" "$fixture/dashboard/studio/games"
printf '<!doctype html><title>검증</title><p>자가제작 fixture</p>\n' > "$fixture/source/index.html"
printf '{"id":"fixture-ref","title":"검증 레퍼런스","stages":[]}\n' > "$fixture/dashboard/studio/games/fixture-ref.json"
bash templates/game/scripts/new-game-from-reference.sh \
  --reference fixture-ref --source "$fixture/source" --id fixture-game \
  --target "$fixture/fixture-game" --studio-root "$fixture/dashboard" --dry-run
# 위 dry-run 후 fixture-game 및 해당 manifest가 없어야 한다.
bash templates/game/scripts/new-game-from-reference.sh \
  --reference fixture-ref --source "$fixture/source" --id fixture-game \
  --target "$fixture/fixture-game" --studio-root "$fixture/dashboard"
git -C "$fixture/fixture-game" status --short
cat "$fixture/dashboard/studio/games/fixture-game.json"
# 파일과 빈 증거·계보를 검토한 뒤 자신이 만든 임시 fixture만 정리한다.
rm -rf -- "$fixture"
```

추가 검증은 기존 target/manifest, source=target, 중첩 경로, symlink 경로를 거부하는지 확인한다. 테스트 fixture에 `.env`, `.git`, `node_modules`, 빌드, 50MB 초과 파일을 넣어 복제되지 않는지도 확인한다. 현재 대시보드와 원본 게임의 Git에는 어떤 변경도 하지 않는다.
