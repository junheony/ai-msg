# ~/shorts_status · 파일 스키마 (v1)

MSG Hub 의 `영상 › Shorts 공장` 탭이 읽는 세 파일. 모두 UTF-8, 시각은 ISO 8601(오프셋 포함, 예 `2026-11-01T19:00:00+09:00`).
서버는 **읽기만** 한다. 없는 파일·깨진 JSON·빠진 필드는 전부 "없음/형식 오류/미보고" 로 표시되며 절대 정상이나 0 으로 보이지 않는다.
필드 이름에 `key token secret vault wallet password credential cookie seed` 가 들어가면 서버가 통째로 지운다(비밀 차단 규칙). 쓰지 말 것.

## 1. status.json — 루틴(파이프라인)이 매 실행마다 통째로 덮어쓴다

```json
{
  "schema": 1,
  "generated_at": "2026-11-01T19:05:00+09:00",
  "placeholder": false,
  "routine": {
    "last_run_at": "2026-11-01T19:00:00+09:00",
    "status": "ok",
    "log_tail": ["[19:00:01] render ep-041 ok", "[19:04:50] upload queued"]
  },
  "last_render": { "file": "ep-041.mp4", "at": "2026-11-01T19:04:40+09:00" },
  "gate_failures": [ { "gate": "caption-length", "at": "2026-11-01T18:30:00+09:00", "detail": "ep-040 caption 2.1s over" } ],
  "queue_depth": 3,
  "scheduled": [ { "channel_id": "UC3rtb2M3lZoKIkIZWR4saYQ", "video_id": "ep-042", "title": "…", "publish_at": "2026-11-02T18:00:00+09:00" } ],
  "published": [ { "channel_id": "UC3rtb2M3lZoKIkIZWR4saYQ", "video_id": "zCpK0B_jnnw", "title": "…", "published_at": "2026-11-01T18:00:00+09:00" } ],
  "notes": ["TikTok 계정 신청 대기"]
}
```

| 필드 | 타입 | 규칙 |
|---|---|---|
| `schema` | 1 | 생략 가능. |
| `generated_at` | ISO | **필수.** 파일을 쓴 시각. 지금보다 **6시간** 넘게 오래되면 탭 전체에 `오래됨` 밴드. |
| `placeholder` | bool | `true` 면 "자리표시자 · 수집 전" 밴드. 루틴이 처음 쓸 때 반드시 `false` 로. |
| `routine.last_run_at` | ISO \| null | 마지막 실행 시작 시각. |
| `routine.status` | `"ok" \| "failed" \| "running" \| "unknown"` | `unknown` 은 부트스트랩 전용(자리표시자). `failed` → 주의(bad). `running` 이 6시간 넘으면 주의(warn). 그 외 문자열은 형식 오류로 표시. |
| `routine.log_tail` | string[] \| string | 마지막 줄들(최대 40줄, 줄당 200자까지 표시). 문자열이면 줄바꿈으로 나눔. |
| `last_render.file` | string \| null | 파일 이름만(경로 제외; 홈 경로는 서버가 가린다). |
| `last_render.at` | ISO \| null | |
| `gate_failures` | (string \| {gate, at?, detail?})[] | 비어 있으면 "없음". 개수가 KPI 에 간다. |
| `queue_depth` | int \| null | null = 미보고. 0 과 다르다. |
| `scheduled[]` | {channel_id, video_id, title, publish_at} | **내일(KST) 예약 알림의 근거.** channels.json 의 채널마다 내일 날짜에 항목이 없으면 주의(warn). |
| `published[]` | {channel_id, video_id, title, published_at (또는 publish_at)} | 캘린더에 게시(ok 점)로 표시. 14일 창 밖은 무시. |
| `notes` | string[] | 메모 섹션. |

## 2. channels.json — `collect_youtube.py` 가 원자적으로 덮어쓴다 (tmp + rename)

```json
{
  "schema": 1,
  "generated_at": "2026-11-01T20:10:12+09:00",
  "collector": "collect_youtube.py",
  "planned_total": 20,
  "channels": [
    {
      "id": "UC3rtb2M3lZoKIkIZWR4saYQ",
      "name": "궁금한 1분",
      "lang": "ko",
      "publish_kst": "18:00",
      "platforms": {
        "youtube":   { "status": "live", "url": "https://www.youtube.com/channel/UC3rtb2M3lZoKIkIZWR4saYQ" },
        "tiktok":    { "status": "none" },
        "instagram": { "status": "none" },
        "x":         { "status": "none" },
        "other":     { "status": "none" }
      },
      "subscribers": null,
      "total_views": null,
      "video_count": 12,
      "videos": [ { "id": "zCpK0B_jnnw", "title": "…", "views": 545, "url": "https://www.youtube.com/shorts/zCpK0B_jnnw", "uploaded_at": null } ],
      "last_attempt_at": "2026-11-01T20:10:00+09:00",
      "last_success_at": "2026-11-01T20:10:05+09:00",
      "error": null
    }
  ]
}
```

| 필드 | 규칙 |
|---|---|
| `generated_at` | 파일을 쓴 시각. **8시간** 넘게 오래되면 `오래됨` 밴드(4시간 주기 cron 기준 두 번 놓침). |
| `planned_total` | 계획 채널 수(기본 20). KPI `채널 n/20` 의 분모. |
| `channels[].id` | YouTube 채널 ID `UC…`. 필수. 없으면 그 항목은 형식 오류로 건너뜀. |
| `publish_kst` | `HH:MM` KST 일일 업로드 시각(계획). 캘린더 예정이 비어 있을 때 참고로만 쓰고 예정으로 치지 않는다. |
| `platforms.<p>.status` | `"live"`(실제 계정 있음) \| `"none"`(미개설) \| `"unknown"`. YouTube 가 `live` 인 채널만 "개설 채널" 로 센다. |
| `subscribers`, `total_views` | 공개 API(yt-dlp)가 값을 주면 정수, 아니면 **null**. 작은 영상 부분집합 합계로 총 조회를 만들지 않는다. |
| (정밀도) | `views`·`subscribers`·`total_views` 는 공개 플랫리스트 응답값 그대로이며 **반올림되어 올 수 있다**(예: 수동 관측 1157 ↔ 수집 1100). 이전 값보다 작아져도 실제 감소라고 단정하지 않는다; 수집기는 단조 증가를 강제하거나 값을 고치지 않는다. null 은 "공개 수집 응답에 없음"이지 "YouTube 가 절대 공개하지 않음"이 아니다. |
| `videos[]` | 최신 N편(기본 5) — 쇼츠 탭 우선, 없으면 videos 탭. `views` 는 null 가능. |
| `last_attempt_at` / `last_success_at` | 독립 기록. 실패하면 `last_attempt_at` 만 갱신되고 `videos/subscribers/total_views` 는 **이전 성공값 유지**, `error` 에 사유. |
| `error` | string \| null. 있으면 행에 `실패 · 이전 값 유지`. |

## 3. history.jsonl — 한 줄 = 한 관측. 수집기가 append 만 한다

```json
{"at":"2026-11-01T20:10:05+09:00","channel_id":"UC3rtb2M3lZoKIkIZWR4saYQ","source":"collector","subscribers":null,"total_views":null,"videos":[{"id":"zCpK0B_jnnw","views":545},{"id":"h1yhOEI46fg","views":2300}]}
{"at":"2026-11-01T19:00:00+09:00","channel_id":"UC3rtb2M3lZoKIkIZWR4saYQ","source":"user_reference","videos":[{"id":"h1yhOEI46fg","views":2163}],"mapping":"live_lookup"}
{"at":"2026-11-01T19:00:00+09:00","channel_id":null,"source":"user_reference","videos":[{"id":"VFfjBXHu6Oo","views":431}],"mapping":"unmapped"}
```

| 필드 | 규칙 |
|---|---|
| `at` | 관측 시각. |
| `channel_id` | `UC…` 또는 null(채널 미지정 참고 관측). |
| `source` | `"collector"`(수집 성공 시 채널당 1줄) \| `"user_reference"`(사람이 준 기준값). 그 외는 무시. |
| `subscribers`, `total_views` | 선택. null 가능. |
| `videos[]` | `{id, views}`. 스파크라인 재료: 채널의 **최신 영상** 조회 추이(2점 이상일 때), 아니면 회차별 최신 N편 합. |
| `mapping` | user_reference 전용. `"live_lookup"`(영상→채널을 공개 조회로 확인) \| `"collected"`(수집 목록에서 발견) \| `"unmapped"`(아직 모름). unmapped 줄은 매핑이 밝혀지면 **그 줄만 제자리에서 갱신**된다(같은 source+video id+at 은 한 줄). |

서버는 파일 꼬리 **512 KB** 까지만 읽고(약 2천 줄), 깨진 줄은 센 뒤 건너뛴다.

## 상태 판정 요약
- `오래됨`: status.json 6h, channels.json 8h.
- `자리표시자`: `placeholder: true` 또는 `routine.status: "unknown"`.
- 디스크 `>95%` → 주의(bad). 사용률은 서버가 `df -P /` 로 직접 잰다(파일에 쓰지 않는다).
- Claude: 서버가 `claude-pick --verbose` 판정 줄만 해석(계정 글자, 주간 %, 리셋 h, 점수, 제외 사유). 덱 JSON·토큰·URL 은 저장·전송하지 않는다.
- Codex: `codex --version` 한 줄. 실행 못 하면 `미설치/실행 불가`.

## 수집기 실행
```
python3 -I ~/shorts_status/collect_youtube.py                # 기본: 채널 전부, 최신 5편, 호출 사이 3–5초
python3 -I ~/shorts_status/collect_youtube.py --channel UC3rtb2M3lZoKIkIZWR4saYQ --videos 3
python3 -I ~/shorts_status/collect_youtube.py --dry-run      # 파일을 쓰지 않고 수집 결과만 stdout
python3 -I ~/shorts_status/collect_youtube.py --no-reference # 기준 관측값 시드 생략
```
종료 코드 0 = 전부 성공, 1 = 일부 채널 실패(파일은 썼음), 2 = 잠금 충돌(다른 수집기 실행 중) 또는 yt-dlp 없음.
예상되는 부분 실패: 쇼츠 탭 없음(→ videos 탭 시도), 타임아웃(재시도 2회), YouTube 일시 차단(해당 채널만 error 기록, 이전 값 유지).
