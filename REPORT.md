# BRIEF11 리서치 패널 보고

## 요약

허브에 **리서치 탭**과 **개요 하단 패널**을 추가했고 `feat/hub-research` 브랜치에 커밋했습니다. 머지, 푸시, 배포, 재시작은 하지 않았으므로 라이브 허브에는 새 빌드를 올려야 보입니다.

- **화면:** 맨 위 글을 내러티브 색의 단색 표지로 크게 싣고, 나머지는 색 띠가 있는 카드로, 그 아래에 태그 필터와 외부 리서치 목록을 둡니다. 제목은 명조 계열 Hahmlet입니다. 그라데이션, 이모지 아이콘, 가짜 숫자는 쓰지 않았습니다.
- **데이터:** `~/.msg/research/articles.json`(글 4건)과 `sources.json`(출처 14곳)을 요청마다 읽으므로 글을 추가할 때 코드 수정이나 재시작이 필요 없습니다. 추가는 `scripts/msg-research-add`, 스키마는 `docs/research.md`에 있습니다.
- **출처:** 14곳 모두 확인했고 뺀 곳은 없습니다. 추측한 도메인도 없습니다.
- **검증:** 타입체크, 빌드, 대비 검사 통과. 전체 테스트 4,514건(신규 39건 포함)은 전부 통과한 실행도 있지만, 실행마다 다른 기존 테스트가 1~2건씩 간헐적으로 실패합니다(아래 "테스트 결과" 참고). 스크린샷은 `shots-research/`에 있습니다.

**오너가 알아둘 점**

1. 글 4건 모두 요약이 비어 있어 지금은 "요약 대기"로 보입니다. 결론은 지어내지 않았으니 `articles.json`에 채워 주세요.
2. Cursor 글 링크는 로그인 없이 열면 로그인 페이지로 넘어갑니다. Cursor에 로그인한 브라우저에서만 열릴 수 있습니다.
3. Compute Markets 글은 날짜가 없어 시드 날짜 2026-11-02로 넣었습니다. "매일 갱신" 글이라 화면에는 날짜 대신 배지가 보이고, 등록일은 툴팁에 있습니다.

## 테스트 결과

최종 커밋의 전체 테스트 3회와 깨끗한 `main` 2회 결과입니다. 측정 당시 머신 부하(load average)는 약 187이었습니다.

| 대상 | 결과 | 실패한 테스트 |
| --- | --- | --- |
| 이 브랜치 1회차 | 2건 실패 / 4,514건 | `Thinking.test.tsx` 1건, `TradingRoom.test.tsx` 1건 |
| 이 브랜치 2회차 | 전부 통과 | |
| 이 브랜치 3회차 | 1건 실패 / 4,514건 | 총사령탑 `commanderHop` 테스트 (대기 시간 초과) |
| `main` 1회차 | 전부 통과 (4,475건) | |
| `main` 2회차 | 1건 실패 / 4,475건 | `#replay` 테스트 |

실패한 테스트는 매번 달랐고 리서치 테스트는 한 번도 실패하지 않았으며, 이 변경이 없는 `main`에서도 같은 양상이 나왔습니다. `Thinking`과 `TradingRoom` 두 파일은 따로 돌리면 3회 모두 통과했습니다. 그래서 부하에 따른 기존 간헐 실패로 판단했습니다. 다만 부하가 낮을 때 돌려 본 것은 아닙니다.

## 머지 확인

| 브랜치 | 결과 |
| --- | --- |
| `feat/hub-controls` | 충돌 없음. 임시 워크트리에서 머지한 뒤 타입체크 통과. |
| `feat/hub-yap-quant` | `quant.ts`, `yapping.ts`, `yapping.test.ts`, `HubPage.tsx` 4개 파일 충돌. `main`과 머지해도 똑같이 나므로 이 커밋 때문이 아닙니다. |
| `feat/terminal-redesign` | 로컬에 브랜치가 없어 확인하지 못했습니다. |

`feat/hub-controls` 머지 트리에서 허브 테스트를 돌렸을 때 `TradingRoom.test.tsx`의 한 건이 1번 실패했습니다. 이후 그 파일만 돌리면 `feat/hub-controls` 단독과 머지 트리 모두 3회 전부 통과해서 재현되지 않았습니다. 부하에 따른 간헐 실패로 보이지만 원인을 확인한 것은 아닙니다.

## 외부 리서치 URL

2026-11-02에 다시 요청해 14곳 모두 HTTP 200을 확인했습니다.

| 이름 | 기록한 최종 URL | 비고 |
| --- | --- | --- |
| Four Pillars 포필러스 (오너 픽) | https://4pillars.io/ko | `fourpillars.io`는 연결되지 않음 |
| Tiger Research 타이거리서치 (오너 픽) | https://reports.tiger-research.com/ | |
| Citrini Research 시트리니 (오너 픽) | https://www.citriniresearch.com/ | |
| Blockworks 0xResearch | https://blockworks.com/newsletter/0xresearch | `0xresearch.co`는 연결되지 않음 |
| Delphi Digital | https://delphidigital.io/ | |
| Galaxy Research | https://www.galaxy.com/insights/research | |
| a16z Frontier | https://a16zfrontier.com/posts/ | 옛 a16z crypto. `a16zcrypto.com`에서 리디렉션되며 새 이름으로 기록 |
| DeSpread | https://despread.io/ | 리서치 조직 DeSpread Research는 2차 자료로만 확인 |
| Messari | https://app.blockworks.com/ | `messari.io`가 여기로 리디렉션됨. 페이지 제목은 Blockworks Intel. Blockworks 인수는 설명에 표기 |
| Xangle 쟁글 | https://xangle.io/ | |
| Artemis | https://about.artemis.ai/ | `artemis.xyz`에서 리디렉션 |
| Token Terminal | https://tokenterminal.com/ | |
| Kaiko | https://www.kaiko.com/ | |
| SemiAnalysis | https://semianalysis.com/ | |

제외한 곳: 없음.

## 결정한 사항

- **리서치 탭 단축키 없음:** 숫자 단축키 10개가 이미 차 있어 11번째 탭에는 주지 않았습니다. 기존 단축키는 그대로입니다.
- **기존 테스트 수정:** `App.hub.test.tsx`의 모드 목록에 리서치를 추가했습니다.
- **필터와 표지:** 태그를 고르면 첫 번째 글이 표지가 되고 표지 색도 바뀝니다. 태그가 하나뿐이면 필터를 숨깁니다.
- **의존성 추가:** `@fontsource-variable/hahmlet`(OFL). 글꼴 조각은 합쳐서 약 2 MB이고, 브라우저는 페이지에 필요한 조각만 받습니다.

## 테스트 중 고친 버그

서버가 200으로 `{}`를 돌려주면 패널이 허브 페이지 전체를 죽이는 문제가 전체 테스트에서 드러났습니다. 이제 응답 형식을 검사해 오류 안내만 표시하며, 회귀 테스트도 추가했습니다.

## 검증 범위

- 다루는 상태: 파일 없음, 형식 오류, 일부 항목 오류, 빈 요약, 구버전 서버(404), 잘못된 응답 형식.
- `shots-research/`: 1440과 390 너비, 개요와 리서치 탭, 다크 테마. 개요 상단의 허브 상태는 테스트 픽스처이고 리서치 내용은 실제 파일입니다.
- 라이트 테마, 필터 색 변경, 요약이 채워진 조판, 빈 상태와 오류 상태는 임시 데이터로 확인했고 저장소에는 넣지 않았습니다.
- 이 환경의 Node는 v22.22.2이고 `engines`는 24 이상을 요구합니다. Node 24에서는 돌려 보지 않았습니다.
- `account.txt`는 건드리지 않았고 커밋하지도 않았습니다. 라이브 서버(9377)도 건드리지 않았습니다.

STATUS: DONE
