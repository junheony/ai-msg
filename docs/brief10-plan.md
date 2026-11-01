# BRIEF10 작업 계획 / 위임 기록

- 작업트리 `/home/max/ai-msg-yapquant`, 브랜치 `feat/hub-yap-quant`가 `main` 9485947에서 이미 생성되어 있음을 확인했다.
- `src/server/hub/shared.ts` 및 공유 timeout은 변경하지 않는다. yap/quant 모듈, 해당 UI/types/tests, 검증 스크립트/문서/스크린샷만 변경한다.
- ask-claude: Fable 사용 한도 오류. deck-run은 서버에 설치되어 있지 않다. 무한 재시도 없이 Codex 작업 에이전트 위임으로 전환했다.
- `/root/yapping`: 야핑봇 collector/상태 읽기/UI/tests/데이터 누락 사유 문서.
- `/root/quant`: QUANT 동적 계정/단위 tests/DOM tests 및 HubPage의 좁은 조건 분기 통합.
- `/root/capture`: 실제 두 collector만 사용하는 격리 preview와 4종 desktop/mobile 캡처 검증 harness.
- 오케스트레이터: read-only API curl 실측/운영 상태 진단, Node24/의존성 준비, 전체 tests/typecheck/build, 실제 캡처 검토, REPORT.md, branch commit.
- frontend-design 스킬을 읽고 The Seeker dashboard 참조를 확인했다. 유형/색상은 기존 hub 토큰을 존중한다.
- 프로덕션/관련 systemd 변경, ledger 변경, restart, merge, push, deploy 금지.

## 재사용할 조사 결과

`docs/brief10-diagnosis.md`에 endpoints별 curl, service/PID, Node fetch 결과를 기록했다. 기존 :8095의 7개 동시 호출은 6.05~7.81s; 6개 3s 제한 초과. 순차는 0.01~2.31s. :8810은 curl 7ms/native fetch 39~647ms여서 현재 false timeout 미재현.

## 검증 환경

- 기본 셸 Node22 대신 프로젝트 요구 Node24 사용: `/home/max/.npm/_npx/387698761821791d/node_modules/node/bin/node` (v24.22.2).
- `npm ci --ignore-scripts --no-audit --no-fund` 완료. lockfile 불변.
- Playwright `/home/max/.npm/_npx/e41f203b7505f1fb/node_modules/playwright`, Chromium 캐시 준비됨.

## 통합 결과

- 전체356파일/4462테스트 PASS, 최종 대상6파일/56테스트 PASS.
- Node24 typecheck/build PASS. shared.ts/status.ts 및 lockfile 불변.
- actual built App + live read-only two collectors 캡처4개 view/32 assertions PASS,27PNG 저장.
- 뷰 증감은 이력 없음으로 muted 사유 및 필요한 observations endpoint를 REPORT에 명시.
- 결과 요약은 REPORT.md, 구현 근거는 brief10-yapping.md/quant.md, 캡처 방법은 brief10-capture.md.
