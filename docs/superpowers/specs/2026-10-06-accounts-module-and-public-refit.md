# 계정 모듈화 · 공개 저장소 정비 (설계, 2026-10-06)

상태: 1절(계정 모듈) 1~4단계 구현됨 — 브랜치 `accounts-module`, UI 리뷰 중·master 병합 전. 설계와 다르게 한 것은 1절 끝 "구현 메모". 2절(공개 정비) 미착수. 사용자 요청 — "계정수는 추가하고싶은만큼 붙일 수 있게 모듈 형식", "공개 저장소에 업로드 해보게 재정비".

## 1. 계정 모듈

**설정 파일** `<configDir>/accounts.json` (없어도 됨)

```json
{ "version": 1, "home": "a",
  "accounts": [
    { "id": "a", "label": "A", "configDir": "~/.claude", "card": "claude:main" },
    { "id": "b", "configDir": "~/.claude-b", "card": "claude:second" },
    { "id": "c", "retired": true } ] }
```

- `id` = 영속 키(`^[a-z0-9][a-z0-9_-]{0,15}$`). `label` 기본 `id.toUpperCase()`, `configDir` 기본 `~/.claude-<id>`, `card` 기본 `claude:<id>`.
- Desktop 미러링 대상은 최상위 `home` 단일값(계정 플래그 아님 — 둘 지정 오류 방지).
- 보호 계정은 파일에 넣지 않는다. `~/.config/offload/protect` / `CLAUDE_PROTECT` 가 claude-pick·offload 와 공유하는 원본.
- **파일이 없을 때**: `~/.claude` → `a`, `~/.claude-<x>` 발견 → `x`, 정렬. 카드 id 는 앞 3개 `claude:main/second/third`(기존 규약), 이후 `claude:<id>`. `home='a'`. 지금 구성과 같은 결과 → 이전 작업 없음.
- **타입**: `Account` 를 `string` 브랜드로 넓히고 `AccountRegistry`(`list/has/label/profileDir/cardId/env/isHome/fallback`)를 주입. `ACCOUNTS`·`CARD_ID`·중복 `LABEL` 4곳(`AccountRouter.ts`, `EngineChoice.ts`, `TurnRunner.ts`, `ui/state.ts`) 제거.
- **프로토콜**: `z.enum(['a','b','c'])` → `z.string().regex(ID)`, 서버가 처리 시점에 `registry.has()` 검사. UI 는 `hello.accounts: {id,label,home,retired}[]`(선택 필드, `docs/protocol.md` 규칙)로 목록을 받는다.
- **UsageIndex v2**: 지금 `v = mask + max*16`, 비트 1·2·4 = a/b/c, 8 = GLOBAL → 4번째 계정이 GLOBAL 과 충돌. v2 는 파일에 `sources: string[]`(추가만) 저장, 비트0 = GLOBAL, 비트 i+1 = `sources[i]`. 로드 시 v1 1회 변환: `mask2 = (v&8?1:0) | ((v&7)<<1)`, `max = floor(v/16)`, `sources=['a','b','c']`. 변환 실패 → 인덱스 삭제 후 전체 재스캔.
- **계정 제거**: `retired:true` = 읽기 전용(세션·사용량은 보임, 라우터·선택기에서 제외, 재개 시 오류). 설정에 없는 id 의 저장 세션은 회색 라벨, 재개 거부, 삭제 허용. 쿨다운 파일명 `<dir>/<id>` 는 그대로.
- **UI**: 라벨은 레지스트리 값, `.acct`/`usage-letter` 는 `min-width`+padding, 색은 `--acct-0..7` 팔레트를 순번으로, `'A (Desktop)'` → `${label}${isHome ? ' (Desktop)' : ''}`.
- **usage-deck 없이**: 잔여량 미지 계정을 제외가 아니라 후순위 후보로. `leastWeekly` 의 `?? 'b'` → `registry.fallback()`(비보호 첫 계정).

**단계** (각각 테스트·리뷰·커밋)

1. `AccountRegistry` + `accounts.json` 로드·기본 발견, 서버 상수 치환 (`shared/accounts.ts`, `server/config.ts`, `main.ts`, `routing/*`, `usage/UsageService.ts`, `sessions/*`). 프로토콜 무변경.
2. UsageIndex v2 + 이전, `token-usage.ts` 동적화. **실제 `usage-index.json` 사본으로 왕복 테스트 필수.**
3. 프로토콜 widening + `hello.accounts` + UI N개.
4. `retired`·미지 계정 동작, usage-deck 없는 라우팅.

**위험한 가정**: ① `.seen` 인코딩 해석이 모든 기존 줄에 맞다 ② 디스크 상태에 `Record<Account,X>` 전체 키를 요구하는 숨은 역직렬화가 없다 ③ claude-pick/offload 가 새 id 를 받아들인다(쿨다운 파일명·카드 id 공유 — 4번째 계정은 그쪽도 맞춰야 함).

**구현 메모** (설계와 다르게 한 것)

- UsageIndex v2 는 v1 파일을 덮어쓰지 않고 이름을 나눴다: `usage-index-v2.json`(+`.seen`). v1(`usage-index.json`)은 읽기만 하고 남겨 둔다. v2 가 깨졌으면 지우고 전체 재스캔하는 대신 v1 에서 다시 변환하고, v1 도 못 쓰면 그때 전체 재스캔한다.
- v2 의 계정 자리는 유한하다(`MAX_USAGE_ACCOUNTS`, 뺀 계정 포함). 넘치는 계정은 다른 계정에 섞지 않고 세지 않으며 한 번 로그로 알린다.
- 파일이 없을 때의 자동 발견은 `~/.claude` 와 `~/.claude-<영문 한 글자>` 만. 그 밖의 `~/.claude-*` 는 계정으로 쓰지 않고, 추가하려면 넣을 accounts.json 항목을 시작 로그에 한 줄씩 찍는다.
- accounts.json 이 있는데 읽을 수 없거나 내용이 틀리면 기본값으로 넘어가지 않고 시작을 거부한다(다른 계정 구성으로 조용히 도는 것을 막음).
- "usage-deck 없이"는 설치별로 판정한다: `UsageSnapshot.usageSource` — usage-deck 응답을 한 번이라도 본 설치는 `'deck'`(`<configDir>/usage-source.json` 에 기록, 잔여량 모름 = 기존대로 Opus·엔진 전환), 한 번도 못 본 설치는 `'none'`(모름만으로는 모델·엔진을 바꾸지 않음). `DECK_USAGE_STRICT=1|0` 으로 강제. 첫 조회가 끝나기 전에는 `'deck'`.
- 라우터는 잔여량을 모르는 계정을 "후순위 후보"로 둔다: 값이 알려진 후보 뒤, 한도에 닿은 것으로 알려진 계정 앞.
- 생성자·deps 의 `accounts` 는 필수 인자다. a/b/c 기본값(`LEGACY_ACCOUNTS`)은 `hello.accounts` 가 없는 옛 서버에 붙은 새 UI 용으로만 남겼다.

## 2. 공개 정비

- **이력**: 새 저장소에 단일 커밋으로. 289커밋 전부에 로컬 호스트명 메일, 이력 전반에 개인 경로·Tailnet 패턴. 이 저장소는 비공개 원본으로 보존.
- **순서**: 픽스처 치환 → 위생 테스트 → 문서 정리 → LICENSE/CI → 올리기.
- **픽스처 규칙**(`tests/hygiene.test.ts` 로 강제): 홈 경로 → `/Users/alice`, 한글 작업 폴더 → `Documents/work`, Tailnet 호스트 → `deck.example.ts.net`, IP → `192.0.2.x`, 개인 프로젝트명 → `acme`.
- **문서**: `docs/HANDOFF.md`, `docs/superpowers/plans/*`, 이 파일은 공개본에서 제외. `specs/2026-09-30-deck-design.md` 는 세정 후 `docs/ARCHITECTURE.md`. `gemini-spike.md`, `protocol.md` 유지.
- **언어**: UI 한국어 유지(i18n 안 함), README 영어 주 + `README.ko.md`.
- **기타**: `.gitignore` 보강, `package.json` 에 `license`/`description`/`repository`(`private:true` 유지), README 재작성(계정 1개로도 동작, usage-deck·claude-pick·offload 는 선택), `test:e2e` 는 실계정 토큰 소모 경고.
- **사용자 결정 대기**: ① 라이선스(MIT 권고) ② 단일 커밋 공개 ③ 저장소 이름·저자 표기 ④ Codex·Gemini 기능 공개 범위.
