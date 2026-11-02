# BRIEF10 야핑봇 재구성

@cblabx 자동 성장 운영일 한도와 실제 게시 기록을 우선한다. 수동 09:30/15:30/21:30 로테이션, 초안 선택 지시, 중복 빨간 API 칩과 동일 실패를 반복한 주의 목록을 제거했다.

## 디자인 결정

frontend-design skill와 기존 허브 type scale을 따른다. The Seeker dashboard 방향은 운영 정보 우선, 제한된 강조, 정보 밀도와 읽기 순서로 반영했다. 팔레트는 기존 토큰의 배경 #14141c, 표면 #1c1c26, 본문 #efeff6, 보조 #b3b1c2, 링크 #9ec3ef, 강조 #a78bfa를 사용하고 밝은 테마에서는 기존 토큰을 그대로 전환한다. 기존 --font/--hub-font와 --fs-*만 사용한다.

레이아웃은 [일일 게시/답글 한도 4열 → 성장 변화 2열 → X/TG 독립 최신 게시 목록 → 접힌 소스 상태]. 모바일 한도는 2열, 게시 목록은 1열이다. 동일 KPI 카드를 반복하기보다 하나의 일일 예산 표면 안에서 완료/예약과 한도를 비교하도록 했다. 링크 목록은 게시 시각, 실제 본문, 목적지를 보여 준다. 별도 장식/이미지/동작 버튼은 없다. 기존 폰트 크기를 줄여 텍스트를 끼워 넣지 않고 영역을 재배치한다. 소스 패널과 링크는 키보드로 접근 가능하다.

## :8095 진단과 해결

실측 원본은 `docs/brief10-diagnosis.md`. 기존 7 endpoint 동시 호출은 모두 HTTP200이나 6.05~7.81초 걸렸으며, 6개 endpoint의 3초 제한 때문에 6/7 timeout이 재현되었다. 경로 오류/프로세스 다운이 아니다. 서버 재시작은 하지 않았다.

허브는 이제 :8095에 요청하지 않는다. `python3 -c` 고정 스크립트가 SQLite URI `mode=ro`, `PRAGMA query_only=ON`, 고정 SELECT와 바인딩으로 필요한 상태만 읽는다. targets YAML과 watchdog JSON도 제한 필드만 반환한다. yapping-bot app 모듈은 import하지 않는다. GET `/api/autopilot`은 ext 인자 없이도 qt_auto.plan이 쓰기를 하므로 사용하지 않는다. watchdog 실행, mutation API, 서비스 재시작, ledger 수정은 없다.

한 번의 Python 조회는 1.8초 실행 예산, SQLite lock 대기는 0.3초다. 같은 HubDeps 인스턴스에서 30초 캐시, 진행 중 요청 공유, 실패 시 마지막 정상 결과와 원래 시각을 사용한다. 날짜가 바뀐 완료/한도 사용량은 오늘 수치로 재사용하지 않는다. systemd service read는 기존 deps의 별도 시간 예산을 사용하며 실패가 나도 게시/팔로워 결과는 유지한다.

실제 collector 2026-11-02 02:06 KST: 총1772ms, 속보5/5, 리포트1/2, 전체7/7, 답글12/40, 팔로워508(+3 직전 수집 대비), X3건/TG3건. 병렬 빌드 중 재측정에서 Python201ms, systemd3053ms(확인 불가)로 분리되었다. 이것은 API 상태가 아닌 서비스 조회 지연으로 접힌 소스 상태에만 표시된다.

## 값의 근거와 기준 시각

- 속보/리포트 cap: `config/targets.yaml`의 `breaking.max_qt_per_day=5`, `data_reports.max_qt_per_day=2`.
- 레인 사용량: DB kv `qt_auto_plan`의 해당 lane에서 state pending/leased/done인 항목 수. missed/dropped는 제외. qt_auto.add_pinned의 cap 판단과 같은 의미이며 '완료+예약'을 명시했다.
- 전체 cap: `breaking.total_qt_max_per_day=7`. 사용량은 해당 운영일 `post_drafts(kind='ai_news_qt', status='posted')` 수 + pending/leased 예약 수. 일반 QT도 포함하므로 속보+리포트만 더해서 대체하지 않는다. 현재값은7/7이며 watchdog.qt.posts_today=8은 다른 집계라 사용하지 않는다.
- 게시 운영일은 KST03:00~다음날03:00, 답글은 KST자정~다음날자정. 답글 cap은 `replies_auto.daily_soft_cap=40`; done_today는 reply_items의 done_at 범위를 직접 센다.
- 팔로워는 watchdog.followers.at/followers/delta_since_last_run의 실제 관측값. '+3'은 24시간 변화가 아니라 **직전 수집 대비**다. 45분 이상 지난 관측은 회색 '마지막 정상 + 시각'.
- X 최근3건은 post_drafts의 posted_at/tweet_id/text. Telegram 최근3건은 ai_news_items의 tg_posted_at/tg_message_id/headline과 공개 ai_news.tg_channel. 공개 사용자명과 숫자 ID만 URL에 사용한다. **각 채널의 독립적인 최신3건이며 행 간 1:1 미러 관계를 주장하지 않는다.**
- 소스 패널은 기본 접힘. 구버전 API 소스가 전달되어도 timeout6/7을 '야핑봇 API 응답 느림 (6/7)' 한 줄로 그룹화한다. 빈 —/— 카드는 없다. 진짜 누락은 회색 '데이터 없음'과 원인을 보여 준다.

## 없는 metric과 필요한 endpoint

현재 `own_posts.impressions`는 각 게시물의 최신 누적값, `updated_at`도 최신값 하나만 남긴다. follower_snapshots 외에 조회수 시계열 테이블이 없다. 기존 `/api/metrics.daily_views`는 게시 날짜별 **현재** 누적 조회수 합계여서 오늘 늘어난 조회수를 의미하지 않는다. 따라서 조회수 변화는 '데이터 없음 · 조회수 과거 관측 이력이 없어 증감 비교 불가'다. 서로 다른 날에 게시한 글의 조회수 합을 빼서 증가량으로 꾸미지 않았다.

필요한 추가 API(현재 미구현): 읽기 전용 **GET `/api/growth/observations?from=<ISO8601>&to=<ISO8601>&scope=own_originals`**. 응답은 `{scope, observations:[{observed_at, followers, posts:[{tweet_id, impressions}]}]}`이며 같은 게시물 집합의 최소 두 관측 시각/누적값과 수집 누락 여부가 필요하다. 비교 기준을 명시한 24시간 증감을 만들 수 있도록 과거 관측을 upstream에 저장해야 한다. 이 작업에서 upstream을 변경하지 않았다.

추후 서버 간 접근을 위해 로컬 DB를 대체한다면 별도 순수 GET `/api/growth/snapshot`이 운영일/레인별 완료·예약·cap/답글/관측시각/최근 X·TG 링크를 반환해야 한다. 기존 `/api/autopilot`을 단순 호출하는 구현은 읽기 전용 요구를 만족하지 않는다.

## 검증

`node_modules/.bin/vitest run src/server/hub/yapping.test.ts src/server/hub/yapping-read.test.ts src/ui/hub/YappingHome.test.tsx`: 3파일13테스트 통과. missing projection, null/0 구분, 캐시/오래된 값/날짜 롤오버, cap 초과, 원천별 시간 초과 그룹화, 공개 링크 검증, UI 접힘/누락 사유를 포함한다.

Python 통합 테스트는 임시 SQLite/YAML/watchdog만 생성하고 실제 read script를 실행해 cap, 예약 제외 상태, KST03 경계, 답글00 경계, 최신3건, numeric/string TG ID, 필드 화이트리스트를 검증한다. 조회 전후 DB SHA256과 mtime은 같았다. Python3/PyYAML이 없는 테스트 환경에서는 이 통합 테스트만 skip한다; 운영 호스트에는 둘 다 있고 실제 실행 통과했다. 실제 소스 읽기에는 Python3/PyYAML이 필요하며 없으면 누락 사유와 마지막 정상값을 표시한다. 전체 typecheck/build/test와 실화면 검증은 루트 작업 결과에 합친다.
