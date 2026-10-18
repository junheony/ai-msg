# 자동 분배 설계 — 엔진·세부 모델까지 (2026-10-18)

사용자 요청: "모델이 기본으로 잡혀 있는데(자동 = Sonnet·Opus·Fable 중 선택) 니가 알아서 GPT·Gemini·Grok 분배할 거지? 세부 모델까지". 지금 자동은 둘로 나뉘어 있다: `chooseEngine`(엔진 자동이면 Claude↔GPT 를 남은 주간으로 비교)과 `chooseAutoModel`(Claude 안에서 Sonnet·Opus·Fable). Gemini·Grok 은 직접 고를 때만 쓴다(`TurnRunner.ts` "Gemini and Grok are explicit only").

## 1. 목표와 범위
- 모델 선택지 "자동" 하나로 **(엔진, 세부 모델, effort)** 을 새 세션의 첫 턴에서 한 번 정한다. 한 세션 안에서는 바꾸지 않는다(프롬프트 캐시·대화 맥락). 한도에 걸렸을 때의 이어가기는 §6.
- 판단 재료: 첫 턴의 **작업 종류·난이도**(LLM 호출 없는 규칙, 지금 `classifyPrompt` 확장), 첨부, **각 엔진의 남은 한도**, 엔진별 **할 수 없는 일**.
- 직접 고른 엔진·모델은 언제나 이긴다. 자동은 고르지 않은 경우만.
- 범위 밖: 총사령탑·자동 실행(commander) 턴은 지금처럼 Claude 만(다른 엔진은 훅 관문이 없음).

## 2. 엔진별 능력 (실측 근거)
| 엔진 | 할 수 있음 | 할 수 없음 / 주의 | 근거 |
|---|---|---|---|
| Claude | 전부(편집·셸·승인 카드·이미지) | 주간·Fable 한도 | 기존 |
| GPT (Codex) | 편집·셸(샌드박스), 이미지 | 승인 카드 없음(샌드박스가 관문), 계정 1개 | 기존 D2 |
| Gemini (agy) | 읽기·분석·설명·리뷰·이미지, 신뢰 폴더 안 파일 편집 | **셸 항상 거부**(헤드리스), 신뢰 폴더(`HOME` 아래) 밖 쓰기 거부 | `docs/gemini-spike.md` |
| Grok | 편집·셸(승인 카드) | **이미지 없음**, 읽기 셸·mkdir·touch 는 승인 없이, 한도 API 없음 | `docs/grok-spike.md`, Grok 설계 §14.9 |

## 3. 작업 분류 (규칙, `classifyTask`)
`classifyPrompt` 의 난이도(easy·medium·hard)에 **작업 종류**를 더한다.
- `explain`: 질문·설명·요약·번역·문서 읽기·코드 리뷰(수정 요청 없음). 기존 EASY 단서 + "리뷰해/검토해/review" 이고 수정 단서 없음.
- `build`: 구현·수정·버그·테스트 작성·리팩터(기존 MEDIUM 단서). 셸이 필요하다고 본다.
- `design`: 설계·보안·원인 불명(기존 HARD 단서).
- `vision`: 이미지 첨부가 있음(다른 종류와 겹칠 수 있음, 제약으로만 쓴다).
- 난이도는 지금 규칙 그대로(HARD 단서 → hard, 긴 프롬프트·첨부 → medium 이상, 짧고 EASY 단서 → easy). **hard 는 종류와 무관하게 `design · hard` 칸**을 쓴다. 수정 단서와 설명 단서가 함께 있으면 build 로 본다(셸이 필요한 쪽이 안전).

## 4. 후보 표 (작업 × 난이도 → 엔진별 세부 모델)
각 칸은 선호 순서대로의 후보 목록이다. 뒤 엔진은 앞 엔진이 막혔을 때만(한도·쿨다운·설치 안 됨·능력 부족).

| | 1순위 | 2순위 | 3순위 | 4순위 |
|---|---|---|---|---|
| explain · easy | Claude Sonnet | Gemini Flash | GPT Sol (low) | Grok 4.7 |
| explain · medium | Claude Opus | Gemini Pro | GPT Sol | Grok 4.7 |
| build · easy | Claude Sonnet | GPT Sol (low) | Grok 4.7 | — |
| build · medium | Claude Opus | GPT Sol | Grok 4.7 | — |
| design · hard | Claude Fable | GPT Astra (high) | Claude Opus | Gemini Pro (high, 읽기 전용 분석으로) |

- `build` 에는 Gemini 를 넣지 않는다(셸이 없어 테스트·빌드를 못 돌림).
- `vision` 이 있으면 Grok 은 후보에서 뺀다.
- `design · hard` 에 Grok 은 넣지 않는다(권한 보장 수준이 낮고 설계 검증 실적이 없음).
- effort: easy=low(Claude 는 지금 `AUTO_EFFORT` 그대로), medium=medium(Claude high), hard=high. 각 모델의 `MODEL_EFFORTS` 밖이면 가장 가까운 아래 값.

## 5. 한도 판단 (누가 "막혔나")
지금 규칙을 엔진마다 같은 모양으로 맞춘다. 각 엔진은 `capacity(engine, model)` 하나로 답한다: `ok` / `low`(넘어가도 됨) / `blocked`(쓰면 안 됨) / `unknown`.
- Claude: 지금 `rankCandidates`·`WEEKLY_SWITCH_PCT`(85%)·Fable 80% 규칙 그대로. 가장 여유 있는 계정 기준.
- GPT: 주간 ≥ 85% 또는 쿨다운 → blocked. 잔여 불명 → unknown.
- Gemini: 그 모델의 버킷(Pro → Argon 그룹, Flash → Flash 그룹) 남은 양 < 15% → blocked. 좌석 g1·g2 중 여유 있는 쪽(g2 는 켜진 뒤). 로그인 없음 → blocked.
- Grok: 쿨다운 중이거나 마지막 턴이 인증 오류 → blocked. 그 밖에는 ok(한도 API 없음).
- **unknown 처리:** 1순위가 unknown 이면 쓴다(지금 Claude "잔여량 불명 → Claude" 와 같은 태도). 2순위 이하가 unknown 이면 건너뛴다.
- **여유 균형(지금 GPT_MARGIN 규칙 일반화):** 1순위가 ok 여도 그 엔진의 남은 주간이 30% 미만이고 2순위가 ok 이면서 남은 양이 1순위보다 `GPT_MARGIN_PCT`(10)점 이상 많으면 2순위로 간다. 단 `design · hard` 는 균형 이동을 하지 않는다(품질 우선).
- **쓰지 않으면 사라지는 한도:** 2순위 이하 엔진의 주간(또는 Gemini 버킷)이 24시간 안에 리셋되고 남은 양이 50% 이상이면, `easy` 작업에 한해 그 엔진을 1순위로 올린다. 배지에 "곧 리셋되는 여유 사용"이라고 적는다.

## 6. 세션 도중 한도에 걸릴 때
- 지금 Claude 계정 간 이동과 GPT 쿨다운은 그대로다.
- 엔진이 바뀌어야 하는 경우(그 엔진 전체가 blocked)는 **자동으로 바꾸지 않는다.** 턴을 끝내고 카드로 "다음 후보: GPT Sol 로 새 세션으로 이어가기"를 제안한다(기존 "새 세션으로 이어가기" + 인계 요약 `HANDOFF_PROMPT` 를 그대로 쓴다). 한 번 누르면 된다.
- 무인 자동 이어가기(벤더 간)는 v1 에 넣지 않는다(§10-8).

## 7. 사용자에게 보이는 것
- 모델 선택지의 "자동" 설명: "첫 턴 내용과 남은 한도로 엔진·모델 선택 (Claude·GPT·Gemini·Grok)".
- 첫 턴 배지 이유 예: `자동 · 구현 · Claude 주간 88% → GPT Sol`, `자동 · 설명 · 곧 리셋되는 여유 → Gemini Flash`, `자동 · 이미지 첨부 → Claude Opus`.
- 설정 "자동에 쓸 엔진" 체크(기본: 설치·로그인된 엔진 모두). 끈 엔진은 후보에서 빠진다.
- 새 채팅의 엔진 선택지에 "자동"이 이미 있으면 그대로 두고, 모델 "자동"과 합친다: 엔진 자동 + 모델 자동 = 이 설계 전체. 엔진을 직접 고르고 모델이 자동이면 그 엔진 안에서만 §4 의 해당 열을 쓴다(예: Grok 지정 + 자동 → 4.7, effort 만 난이도로).

## 8. 코드 구조
- `src/server/routing/AutoRoute.ts`(새): `classifyTask(text, attachments) → { kind, difficulty, why }`, `capacity(...)`, `chooseRoute(input) → { engine, model, effort, reason }`. 순수 함수. `chooseEngine`·`chooseAutoModel` 은 이 안으로 흡수하고, 기존 함수는 얇은 호환 래퍼로 남겨 기존 테스트를 지킨다.
- `TurnRunner` 새 세션 분기: `p.engine === 'auto' || p.model === 'auto'` 이면 `chooseRoute` 결과로 `runClaude`·`runCodex`·`runGemini`·`runGrok` 중 하나로 보낸다. "Gemini and Grok are explicit only" 주석과 분기를 없앤다.
- 설정: "자동에 쓸 엔진"은 기존 설정 저장소에 `autoEngines: EngineKind[]`.
- `src/shared/models.ts`: `AUTO_MODEL_INFO` 설명.
- 상용판: 유료 스펙의 "벤더 간 인계·유휴 할당량 작업"이 §5·§6 이다. 무료 티어는 §4 의 1·2순위까지, Pro 는 4순위까지 전부. 티어 구분은 제안이며 유료 스펙 §4 에 같은 문구로 적는다.

## 9. 테스트
- `classifyTask`: 한국어·영어 단서별 종류, 리뷰 요청이 build 가 아닌지, 이미지 첨부.
- `chooseRoute` 표 테스트: 칸마다 1순위, 1순위 blocked → 2순위, unknown 규칙, 여유 균형(설계 칸 제외), 곧 리셋 규칙(easy 만), vision 시 Grok 제외, build 시 Gemini 제외, `autoEngines` 로 끈 엔진, 엔진 지정 + 모델 자동.
- `TurnRunner`: 자동이 Gemini·Grok 로 보내는 경로, 배지 이유, commander 턴은 Claude 만.
- 기존 `EngineChoice`·`AutoModel` 테스트는 그대로 통과.

## 10. 교차 검토 반영 (개정 1판, 이 절이 앞 절을 이긴다)
Claude·Astra 두 리뷰가 같은 지적을 한 것은 그대로 받았다.
1. **Grok 은 4.7 만.** build-fast 는 2배 가격이고, 예비 순번에서는 속도가 이유가 되지 않는다. 설정 "Grok 빠른 모델 쓰기"를 켰을 때만 Fast(기본 꺼짐).
2. **분류는 셸 쪽으로 기운다.**
   - 셸 단서(테스트·실행·빌드·설치·로그·git·npm·돌려·왜 실패·에러 원인·`$`·명령어 코드 블록)가 하나라도 있으면 Gemini 를 뺀다.
   - Gemini 는 설명 단서가 명시되고, 셸·수정 단서가 전혀 없을 때만 후보가 된다.
   - 종류가 애매하면 build 로 본다.
   - 분류 전에 인용(``` 코드 블록, `>` 인용 줄, 붙여 넣은 로그)을 빼고 사용자 지시만 본다. 단, 코드 블록이 셸 명령처럼 보이면 셸 단서로 센다.
3. **난이도와 종류는 따로 둔다.**
   - hard 칸 후보: Fable → Astra(high) → Opus.
   - Gemini Pro(high)는 종류가 explain 일 때만 마지막에 붙고, 배지에 "읽기 전용 분석"을 적는다. "hard 는 종류와 무관하게 design 칸" 문장은 이것으로 바뀐다.
   - Grok 은 hard 에 넣지 않는다(그대로).
4. **능력 필터는 매 턴 돈다.**
   - 세션 엔진은 첫 턴에 정해지지만, 이후 턴마다 `classifyTask` 를 다시 돌린다.
   - 지금 엔진이 그 턴을 못 하면 턴을 보내지 않고 "이 작업은 ○○ 가 필요 — GPT Sol 로 새 세션 이어가기" 카드를 띄운다. 해당 경우: Gemini 에 셸 단서, Grok 에 이미지, Gemini 인데 cwd 가 신뢰 폴더 밖이고 수정 단서가 있음.
   - Gemini 가 실제로 셸 거부 이벤트를 내면 같은 카드를 띄운다.
   - 직접 고른 엔진에도 같은 카드를 띄우되, "그래도 보내기"를 둔다.
5. **Gemini 는 cwd 가 신뢰 폴더(`HOME` 아래) 밖이면** explain 에서도 수정 단서가 있을 때 blocked 로 본다.
6. **한도 상태는 셋뿐(`ok`·`blocked`·`unknown`, `low` 삭제).**
   - 설치·로그인 여부(능력)와 한도 관측(상태)을 나눈다.
   - 관측이 15분보다 오래되면 unknown 으로 본다.
   - 고르는 순서: ok 후보를 순서대로 → 없으면 1순위 unknown → 없으면 나머지 unknown(배지 "한도 불명") → 그것도 없으면 `no_route`.
   - `no_route` 는 턴을 보내지 않고 이유(엔진별 막힌 까닭)를 보여 준다.
   - Grok 은 한도 관측이 없으므로 쿨다운·인증 오류가 아니면 ok 로 두되, 아래 7의 재정렬에서는 빠진다.
7. **벤더 사이 % 비교는 하지 않는다.**
   - 엔진마다 분모·주기가 달라서 10점 차가 같은 여유를 뜻하지 않는다.
   - 여유 균형은 지금 쓰는 Claude↔GPT 주간 규칙(`GPT_MARGIN_PCT`)만 유지한다. 그 밖의 엔진은 자기 임계값으로 막힘 여부만 판단한다.
   - "곧 리셋되는 여유"는 주기가 5일 이상으로 알려진 창(Claude·GPT 주간)에만 적용한다. 조건: 주기의 마지막 15% 구간, 남은 양 50% 이상, easy 작업만. Gemini 버킷은 주기를 실측한 뒤 넣는다.
   - 적용 순서를 고정한다: 능력 필터 → `autoEngines` → 한도 상태 → Claude↔GPT 균형 → 리셋 승격 → 표 순서. 동률이면 표 순서를 따른다.
   - 같은 입력에는 같은 결과가 나온다(결정적). 동시 세션이 한쪽으로 몰리는 것은 v1 에서 받아들이는 위험으로 둔다. 다음 턴부터는 갱신된 한도를 보므로 길게 이어지지 않는다.
8. **벤더 간 이어가기는 언제나 사용자가 누른다.**
   - 무인 이어가기는 v1.1 로 미룬다. 넣을 때는 권한 관문이 같거나 더 강한 엔진으로만, 연쇄 1회로 제한한다.
   - 이어가기 후보에도 능력 필터를 다시 적용한다(이미지가 있던 세션 → Grok 제외).
   - 인계 요약에 넣을 것: `git status`·변경 파일 목록, 마지막 턴에서 결과를 확인하지 못한 명령("결과 불명 — 다시 실행하기 전에 확인")을 넣는다. 원래 cwd·권한 모드·첨부는 그대로 넘긴다.
   - 실패는 셋으로 나눈다: 재시도 가능(일시 오류) / 재인증 필요(로그인 안내, 이어가기 안 띄움) / 인계 필요(한도·능력).
9. **외부 업체로 코드가 나가는 데 대한 동의.**
   - Gemini·Grok 은 "자동에 쓸 엔진"에 처음 들어갈 때 한 번 확인 카드를 띄운다("자동 세션의 코드·대화가 Google/xAI 로 갈 수 있음").
   - 이 사용자는 직접 분배를 요청했으므로 카드는 한 번만 누르면 된다. 상용판에서는 필수 단계다.
10. **commander** 는 Claude 가 모두 blocked 면 중단하고 알림을 띄운다. 다른 엔진으로 가지 않는다.
11. **테스트 추가:**
    - 엔진·모델의 직접/자동 4조합.
    - explain 세션에 build 턴이 들어온 경우.
    - cwd 가 `HOME` 밖일 때.
    - 셸 단서가 있는 질문형 프롬프트("테스트 왜 실패해?"는 build).
    - 인용 안 단어는 무시.
    - 재정렬 순서.
    - 경계값: 85·80·15%, 주기 15% 구간, 관측 15분.
    - 전부 blocked·전부 꺼짐 → `no_route`.
    - 이미지 세션의 이어가기 후보.
    - Grok Fast 설정.
    - 같은 입력이면 같은 결과.
    - 동의 전에는 Gemini·Grok 제외.
