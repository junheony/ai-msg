# 사용량 헤더 개편 설계 (2026-10-18)

사용자 지적: "조잡해 보인다 — Gemini 사용량 연동, Grok 도 띄워야". 지금 헤더는 Claude A/B/C·GPT 카드와 Gemini 카드의 생김새가 다르고(Gemini 는 "한도 —"), Grok 카드는 없다. 상용판(Quarterdeck)의 "통합 사용량 대시보드"와 같은 부품이다.

## 1. 목표
- 모든 좌석 카드를 **한 해부 구조**로 통일한다. 벤더마다 다른 것은 "행에 무엇을 넣느냐"뿐이다.
- Gemini: 계정(좌석)마다 카드 하나, 버킷별 % 막대와 리셋.
- Grok: 공식 한도 API 가 없으므로 "쓸 수 있는가"와 "오늘 얼마나 썼는가"를 보인다.
- 좁은 폭에서도 깨지지 않는다(지금의 `useCramped` 를 일반화).

## 2. 카드 해부 (모든 좌석 공통)
```
┌───────────────────────────┐
│ [마크] 이름        상태점 │   머리: 엔진 마크, 좌석 이름(A·B·C·GPT·Gemini 1·Gemini 2·Grok), 상태점(정상·오래됨·불명·쿨다운)
│ ███████░░░  72%  · 2h 10m │   주 행: 가장 찬 창의 남은 % 막대 + 짧은 리셋
│ 주간 41% · Fable 63%      │   보조 행: 나머지 창을 한 줄 요약(작은 글씨)
└───────────────────────────┘
```
- 막대는 **남은 양**을 보인다(지금과 같은 의미). 색은 남은 % 기준 3단계(여유·주의·위험)로 모든 좌석이 같다.
- 현재 좌석 강조(`current`), 다음 라우팅 후보 표시(`next`), 클릭 시 상세 팝오버는 지금 동작을 그대로 쓴다. 팝오버도 모든 좌석이 같은 틀(창별 행 + 관측 시각 + 힌트)이다.
- 숫자가 없을 때: 주 행 자리에 이유 한 줄("로그인 필요", "아직 관측 없음", "읽기 실패 · 3분 전 값")을 같은 높이로 넣어 카드 높이가 흔들리지 않게 한다.
- 좁을 때(`cramped`): 머리 + 주 행의 막대·%만 남긴다. 더 좁으면 마크 + % 만.

## 3. 좌석별 행
| 좌석 | 주 행 | 보조 행 | 데이터 |
|---|---|---|---|
| Claude A·B·C | 5시간·주간·Fable 중 가장 찬 창 | 나머지 둘 | `AccountUsage` (그대로) |
| GPT | 5시간·주간 중 가장 찬 창 | 나머지 + 크레딧 | `AccountUsage` + `credits` (그대로) |
| Gemini 1·2 | 버킷 중 가장 찬 것 | 나머지 버킷 이름·% (그룹+기간 이름, 짧은 표기) | `GeminiUsage` (Gemini 실측 수정 반영 후 모양) |
| Grok | 상태 문장: "사용 가능 · 마지막 턴 3분 전" / "로그인 필요" / "한도 — 14:20 이후" | 오늘 토큰 합계 · 턴 수 | 새 `GrokUsage` (§4) |

## 4. 데이터 변경
- `UsageSnapshot.geminiSeats?: Partial<Record<'g1' | 'g2', GeminiUsage>>` 를 더한다. 기존 `gemini` 는 g1 과 같은 값으로 당분간 함께 보낸다(구버전 UI 호환). g2 는 좌석이 켜진 뒤에만 채운다(지금은 비어 있음).
- `UsageSnapshot.grok?: GrokUsage` — 없으면 grok 바이너리 없음(카드 없음).
  ```ts
  type GrokUsage = {
    status: 'ok' | 'down' | 'cooldown' | 'unknown';   // unknown = 아직 Grok 턴 없음
    lastTurnAt: string | null;                        // 마지막으로 끝난 Grok 턴
    lastError: 'auth' | 'limit' | 'busy' | null;      // 마지막 턴의 분류(§8 of grok design)
    cooldownUntil: string | null;                     // 한도 오류에서 읽은 시각, 없으면 null
    today: { inputTokens: number; outputTokens: number; turns: number; day: string };  // 로컬 날짜 기준
  };
  ```
- 출처는 deck 자신의 Grok 턴 결과(turn_result usage·오류 분류)뿐이다. 서버가 하루 합계를 `<설정 폴더>/grok-usage.json` 에 저장한다(원자적 쓰기, 날짜가 바뀌면 리셋). `grok usage` 명령이나 `~/.grok` 파일은 읽지 않는다.
- 로그인 상태는 미리 확인하지 않는다(Grok 설계 §5). 마지막 턴이 인증 오류였으면 'down' + "로그인 필요".

## 5. 구현 단위
1. `src/shared/usage-types.ts`: `GrokUsage`, `geminiSeats`. `docs/protocol.md`.
2. 서버: `src/server/usage/GrokUsageTracker.ts`(새): 턴 결과를 받아 합계·상태 갱신, 디스크 저장, 스냅샷 제공. TurnRunner 의 Grok 턴 종료 지점에서 호출. `UsageService` 가 스냅샷에 싣는다.
3. UI: `UsagePanel.tsx` 를 공통 `SeatCard`(머리·주 행·보조 행·팝오버) 하나로 정리하고, 좌석별로 행 데이터만 만드는 어댑터(`claudeRows`·`gptRows`·`geminiRows`·`grokRows`)를 둔다. `GeminiCard` 는 없앤다. 마크는 `EngineMark` 에 `GrokMark` 가 있으면 쓴다.
4. CSS: `.usage-card` 공통 규칙 하나, 벤더별 클래스는 마크 색만.
5. 테스트: 어댑터 단위 테스트(빈 값·오래된 값·쿨다운), UsagePanel 렌더(좌석 5~7개, cramped 두 단계), GrokUsageTracker(날짜 리셋·원자적 저장·인증/한도 분류).

## 6. 상용판
- 유료 스펙 §4 "통합 사용량 대시보드"의 실제 모습이 이 카드다. 무료 티어는 벤더당 1좌석 카드, Pro 는 좌석 수 제한 없음.
- Grok 카드의 "한도 시각"은 관측값일 뿐이라는 점을 팝오버에 적는다(공식 API 없음, 유료 스펙 §11).

## 7. 검토 반영 (개정 1판, 이 절이 앞 절을 이긴다)
1. **스냅샷 병합:** `UsageService` 가 usage-deck 폴링을 반영할 때 `gemini` 처럼 `geminiSeats`·`grokSeats` 도 이전 값을 이어 붙인다. `emptySnapshot` 기본값을 정한다.
2. **좌석 수별 배치:** 넓은 화면(≥1100px)은 7좌석까지 전체 해부를 쓴다(그리드 열 = 좌석 수, 카드 최소 폭 120px, 넘치면 2행). dense·wrap 임계값을 좌석 수 대신 **카드당 실제 폭**(ResizeObserver)으로 정한다. 기존 `data-cards="5"` CSS 와 정규식 테스트는 새 규칙으로 바꾼다.
3. **Fable 규칙 유지:** 주 행의 %·색은 5시간·주간 중 가장 찬 창(Fable 제외 — "Fable 은 Fable 만 막는다"). 짧은 리셋 표시는 지금처럼 Fable 포함. Fable 은 보조 행.
4. **Grok 좌석 키:** `grok?` 대신 `grokSeats?: Partial<Record<GrokAccount, GrokUsage>>`(지금은 x1 만). 카드 표시 여부는 hello 의 `GrokStatus.bin` 하나로 정한다. 쿨다운의 출처는 `TurnRunner.grokCooldownUntil` 하나이고, 트래커는 그 값을 읽어 싣기만 한다.
5. **GrokUsage 규칙:** 날짜 비교는 읽을 때도 한다(자정 리셋). 한도 오류에 시각이 없으면 쿨다운 30분(TurnRunner 기존 기본값과 같게). 'down'(인증)은 다음 Grok 턴이 성공할 때까지 유지. 토큰은 끝난 턴(성공·멈춤·오류 모두, 취소 포함)의 입력+출력, 캐시·추론은 따로 세지 않음. 쓰기는 서버 안 직렬화 + 원자적 rename, 손상 파일은 `.bad-<ts>` 로 옮기고 0부터. 카드 보조 행에 "오늘 · deck 기준" 이라고 적는다.
6. **Gemini 버킷:** Gemini 모델이 아닌 그룹(예: `Claude and GPT models`)은 주 행 후보에서 빼고 팝오버 맨 끝에만 보인다.
7. **cramped:** 마크가 아니라 좌석 글자(A·B·C·GPT·G1·G2·X1)를 남긴다.
8. **g1/g2 일반화:** 카드마다 자기 좌석 id 로 `current`·`next` 를 판정한다. `useCramped` ids 에 g2·x1 을 넣는다. 팝오버는 390px 폭에서 화면 안에 들어오게 위치를 맞춘다.
9. **상태:** 상태점은 정상·오래됨·불명·쿨다운에 cli 모드 'kept'(추정이지만 라우팅 후보)를 더한다. 창별 `estimated` 는 % 옆 "~" 로 유지. 벤더 클래스가 글자 크기도 바꾸는 기존 규칙은 공통 규칙으로 흡수한다.
10. **폰(<600px):** 카드 대신 벤더별 칩 한 줄 — `Claude A72 B40 C90 │ GPT 55 │ G1 80 G2 — │ X1 ●가능`. 탭하면 같은 팝오버. Grok 칩은 % 대신 상태점 + 짧은 말(가능/14:20). 상단 "남음" 캡션은 Grok 에 맞지 않으므로 각 칩·카드 문구로 대신한다.
11. **테스트 추가:** 구버전 서버(`geminiSeats` 없음) → `gemini` 로 대체, 폴링 뒤 grok·geminiSeats 유지, 자정 읽기 리셋, 동시 쓰기·손상 파일, 쿨다운 출처 일치, Fable 제외, g2 현재 강조, Grok·Gemini "다음" 표시, 7장 × 390px 칩 줄, 기존 testid 이전.
