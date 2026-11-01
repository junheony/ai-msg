#!/usr/bin/env python3
"""
collect_youtube.py — public YouTube numbers for the Shorts 공장 channels → ~/shorts_status/channels.json + history.jsonl.

Schema: SCHEMA.md next to this file. What it does and does not do:
  * yt-dlp metadata only (-J --flat-playlist on the channel's /shorts tab, /videos as fallback). No cookies, no login,
    no download, no upload. `--ignore-config` so a user yt-dlp config cannot add cookies.
  * 3–5 s sleep between calls, bounded retries and timeouts, at most --videos entries per channel.
  * A channel that fails keeps its previous numbers in channels.json; only `last_attempt_at` and `error` move.
    `last_success_at` moves only on success. Counts YouTube does not expose stay null — never a sum of a few videos.
  * history.jsonl is append-only: one `collector` row per successful channel per run, plus the user-given reference
    points (`user_reference`) seeded once, idempotently; an unmapped reference row is upgraded in place when its
    channel becomes known (collected list or one public per-video lookup).
  * A lock file stops two collectors from overlapping; channels.json is written atomically (tmp + rename).

CLI:
  python3 -I collect_youtube.py                       # all channels, 5 videos each
  python3 -I collect_youtube.py --channel UC… --videos 3
  python3 -I collect_youtube.py --dry-run             # collect, print channels.json to stdout, write nothing
  python3 -I collect_youtube.py --no-reference        # skip the reference seeding
Exit: 0 all channels ok · 1 some channel failed (files were written) · 2 lock held / yt-dlp missing / bad arguments.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable

KST = dt.timezone(dt.timedelta(hours=9))
PLANNED_TOTAL = 20
PLATFORMS = ("youtube", "tiktok", "instagram", "x", "other")
# The planned channels (KST daily slot). Add the rest here as they open; the dashboard counts live ones against PLANNED_TOTAL.
CHANNELS: list[dict[str, str]] = [
    {"id": "UC3rtb2M3lZoKIkIZWR4saYQ", "name": "궁금한 1분", "lang": "ko", "publish_kst": "18:00"},
    {"id": "UC6OpOfe_e7tS665qqZgmc8g", "name": "Curious Minute", "lang": "en", "publish_kst": "09:00"},
    {"id": "UCWVedICiqdbRhLVt6avZmQQ", "name": "썰 한 스푼", "lang": "ko", "publish_kst": "20:00"},
    {"id": "UCpbGhmV6u0bdeyN4ATY6f6A", "name": "동물 의외사전", "lang": "ko", "publish_kst": "17:30"},
    {"id": "UCn2AmigSiQjID0z89Xe8vZQ", "name": "Animal Oddities", "lang": "en", "publish_kst": "08:00"},
    {"id": "UClRd6FJNY6CiGdq42Xjapdg", "name": "역사 반전", "lang": "ko", "publish_kst": "20:00"},
    {"id": "UCnwAUca9CUTxnWapE_R8D0A", "name": "History Flipped", "lang": "en", "publish_kst": "10:30"},
]
# Views observed by hand at 2026-11-01 19:00 KST. The channel of each video was not given: it is resolved from public
# data (the collected lists, else one per-video lookup) and otherwise stays unmapped — never guessed from the order.
REFERENCE_AT = "2026-11-01T19:00:00+09:00"
REFERENCE_VIEWS: dict[str, int] = {
    "h1yhOEI46fg": 2163, "lp8Vay4jaoo": 1157, "u0sAQG6Ur0k": 839, "_j8t0zlV0YE": 553, "VFfjBXHu6Oo": 431, "zCpK0B_jnnw": 209, "Ab9r7LBi4ig": 164,
}

Runner = Callable[[list[str], int], tuple[int, str, str]]  # argv, timeout_s → (exit, stdout, stderr)


class CollectError(Exception):
    """A failure of one yt-dlp call; `kind` is 'timeout' | 'exit' | 'json' | 'no_tab'."""

    def __init__(self, kind: str, msg: str):
        super().__init__(msg)
        self.kind = kind


def now_iso() -> str:
    return dt.datetime.now(KST).isoformat(timespec="seconds")


def nonneg_int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def subprocess_runner(argv: list[str], timeout_s: int) -> tuple[int, str, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_s, check=False, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired as e:
        raise CollectError("timeout", f"timeout after {timeout_s}s") from e
    return p.returncode, p.stdout, p.stderr


def ytdlp_json(runner: Runner, ytdlp: str, url: str, extra: list[str], timeout_s: int) -> dict[str, Any]:
    argv = [ytdlp, "--ignore-config", "--no-warnings", "--no-cookies-from-browser", "--socket-timeout", "20", "--skip-download", "-J", *extra, url]
    code, out, err = runner(argv, timeout_s)
    if code != 0:
        tail = (err.strip().splitlines() or ["(no stderr)"])[-1][:200]
        if "does not have a" in tail and "tab" in tail:
            raise CollectError("no_tab", tail)
        raise CollectError("exit", f"yt-dlp exit {code}: {tail}")
    try:
        data = json.loads(out)
    except ValueError as e:
        raise CollectError("json", f"yt-dlp output not JSON: {e}") from e
    if not isinstance(data, dict):
        raise CollectError("json", "yt-dlp output not an object")
    return data


def parse_tab(data: dict[str, Any], n: int) -> dict[str, Any]:
    """The channel-level counts and the first n entries of a flat tab listing. Nulls stay nulls."""
    videos: list[dict[str, Any]] = []
    for e in data.get("entries") or []:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str):
            continue
        videos.append({"id": e["id"], "title": e.get("title") if isinstance(e.get("title"), str) else None, "views": nonneg_int(e.get("view_count")),
                       "url": e.get("url") if isinstance(e.get("url"), str) else f"https://www.youtube.com/shorts/{e['id']}", "uploaded_at": None})
        if len(videos) >= n:
            break
    return {"subscribers": nonneg_int(data.get("channel_follower_count")), "total_views": nonneg_int(data.get("view_count")),
            "video_count": nonneg_int(data.get("playlist_count")), "videos": videos, "channel_id": data.get("channel_id") if isinstance(data.get("channel_id"), str) else None}


def fetch_channel(runner: Runner, ytdlp: str, channel_id: str, n: int, timeout_s: int, retries: int, sleep: Callable[[], None]) -> dict[str, Any]:
    """/shorts first, /videos when the channel has no shorts tab; timeouts and exits retried `retries` times."""
    last: CollectError | None = None
    calls = 0
    for tab in ("shorts", "videos"):
        url = f"https://www.youtube.com/channel/{channel_id}/{tab}"
        for attempt in range(retries + 1):
            if calls:
                sleep()  # between every consecutive yt-dlp call: retries and the /videos fallback alike
            calls += 1
            try:
                data = ytdlp_json(runner, ytdlp, url, ["--flat-playlist", "--playlist-items", f"1-{n}"], timeout_s)
                return parse_tab(data, n)
            except CollectError as e:
                last = e
                if e.kind in ("no_tab", "json"):
                    break  # no point retrying; no_tab moves on to the other tab
        assert last is not None
        if last.kind != "no_tab":
            raise last
    assert last is not None
    raise last


def lookup_video_channel(runner: Runner, ytdlp: str, video_id: str, timeout_s: int) -> str | None:
    """One public per-video metadata call; the channel id or None."""
    try:
        data = ytdlp_json(runner, ytdlp, f"https://www.youtube.com/watch?v={video_id}", ["--no-playlist"], timeout_s)
    except CollectError:
        return None
    cid = data.get("channel_id")
    return cid if isinstance(cid, str) and cid.startswith("UC") else None


def merge_channel(prev: dict[str, Any] | None, plan: dict[str, str], result: dict[str, Any] | None, error: str | None, attempt_at: str) -> dict[str, Any]:
    """The channels.json entry after one attempt: on failure the previous numbers stay and only attempt/error move."""
    prev = prev if isinstance(prev, dict) else {}
    platforms = prev.get("platforms") if isinstance(prev.get("platforms"), dict) else {}
    out: dict[str, Any] = {
        "id": plan["id"], "name": plan["name"], "lang": plan.get("lang"), "publish_kst": plan.get("publish_kst"),
        "platforms": {p: (platforms.get(p) if isinstance(platforms.get(p), dict) else {"status": "none"}) for p in PLATFORMS},
        "subscribers": nonneg_int(prev.get("subscribers")), "total_views": nonneg_int(prev.get("total_views")), "video_count": nonneg_int(prev.get("video_count")),
        "videos": prev.get("videos") if isinstance(prev.get("videos"), list) else [],
        "last_attempt_at": attempt_at, "last_success_at": prev.get("last_success_at") if isinstance(prev.get("last_success_at"), str) else None,
        "error": error,
    }
    out["platforms"]["youtube"].setdefault("url", f"https://www.youtube.com/channel/{plan['id']}")
    if result is not None:
        out.update({"subscribers": result["subscribers"], "total_views": result["total_views"], "video_count": result["video_count"], "videos": result["videos"],
                    "last_success_at": attempt_at, "error": None})
        out["platforms"]["youtube"]["status"] = "live"
    return out


def read_json(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_history(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8") as f:
            return [l.rstrip("\n") for l in f if l.strip()]
    except OSError:
        return []


def write_atomic(path: str, text: str) -> None:
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def collector_row(entry: dict[str, Any], at: str) -> dict[str, Any]:
    return {"at": at, "channel_id": entry["id"], "source": "collector", "subscribers": entry["subscribers"], "total_views": entry["total_views"],
            "videos": [{"id": v["id"], "views": v["views"]} for v in entry["videos"]]}


def seed_reference(history: list[str], channels: list[dict[str, Any]], lookup: Callable[[str], str | None] | None) -> tuple[list[str], list[str]]:
    """Returns (history lines after in-place upgrades, new lines to append). Idempotent: an already seeded point is not added again."""
    by_video: dict[str, str | None] = {}
    for c in channels:
        for v in c.get("videos") or []:
            if isinstance(v, dict) and isinstance(v.get("id"), str):
                by_video[v["id"]] = c["id"]

    def resolve(vid: str, allow_lookup: bool) -> tuple[str | None, str]:
        if vid in by_video:
            return by_video[vid], "collected"
        if allow_lookup and lookup is not None:
            cid = lookup(vid)
            if cid:
                return cid, "live_lookup"
        return None, "unmapped"

    seen: dict[str, int] = {}  # video id → index of its existing reference line
    for i, line in enumerate(history):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get("source") == "user_reference" and r.get("at") == REFERENCE_AT:
            for v in r.get("videos") or []:
                if isinstance(v, dict) and isinstance(v.get("id"), str):
                    seen[v["id"]] = i
    out = list(history)
    new: list[str] = []
    for vid, views in REFERENCE_VIEWS.items():
        if vid in seen:
            i = seen[vid]
            r = json.loads(out[i])
            if r.get("channel_id") is None:
                cid, how = resolve(vid, allow_lookup=False)  # upgrades come from collected lists only: no extra calls per run
                if cid:
                    r["channel_id"], r["mapping"] = cid, how
                    out[i] = json.dumps(r, ensure_ascii=False)
            continue
        cid, how = resolve(vid, allow_lookup=True)
        new.append(json.dumps({"at": REFERENCE_AT, "channel_id": cid, "source": "user_reference", "videos": [{"id": vid, "views": views}], "mapping": how}, ensure_ascii=False))
    return out, new


def run(args: argparse.Namespace, runner: Runner, sleep: Callable[[], None], log: Callable[[str], None]) -> int:
    out_dir = os.path.expanduser(args.out)
    os.makedirs(out_dir, exist_ok=True)
    channels_path = os.path.join(out_dir, "channels.json")
    history_path = os.path.join(out_dir, "history.jsonl")
    lock_path = os.path.join(out_dir, ".collect.lock")
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another collector holds the lock; exiting")
        os.close(lock_fd)
        return 2
    try:
        prev = read_json(channels_path)
        prev_by_id: dict[str, dict[str, Any]] = {}
        if isinstance(prev, dict):
            for c in prev.get("channels") or []:
                if isinstance(c, dict) and isinstance(c.get("id"), str):
                    prev_by_id[c["id"]] = c
        plan = [c for c in CHANNELS if not args.channel or c["id"] in args.channel]
        if not plan:
            log("no such channel in the plan")
            return 2
        entries: list[dict[str, Any]] = []
        rows: list[dict[str, Any]] = []
        failed = 0
        for i, c in enumerate(plan):
            if i:
                sleep()
            attempt_at = now_iso()
            try:
                result = fetch_channel(runner, args.yt_dlp, c["id"], args.videos, args.timeout, args.retries, sleep)
                error = None
            except CollectError as e:
                result, error = None, f"{e.kind}: {e}"[:200]
                failed += 1
                log(f"{c['name']} ({c['id']}): {error}")
            entry = merge_channel(prev_by_id.get(c["id"]), c, result, error, attempt_at)
            entries.append(entry)
            if result is not None:
                rows.append(collector_row(entry, attempt_at))
                log(f"{c['name']}: {len(entry['videos'])} videos, subscribers={entry['subscribers']}, total_views={entry['total_views']}")
        # channels not in this run keep their previous entry (a --channel run must not drop the others)
        kept = [prev_by_id[c["id"]] for c in CHANNELS if c["id"] in prev_by_id and c["id"] not in {e["id"] for e in entries}]
        order = {c["id"]: i for i, c in enumerate(CHANNELS)}
        all_entries = sorted(entries + kept, key=lambda e: order.get(e["id"], 999))
        doc = {"schema": 1, "generated_at": now_iso(), "collector": "collect_youtube.py", "planned_total": PLANNED_TOTAL, "channels": all_entries}
        history = read_history(history_path)
        upgraded, new_rows = history, []
        if not args.no_reference:
            lookup = None
            if not args.no_lookup:
                def lookup(vid: str) -> str | None:
                    sleep()
                    return lookup_video_channel(runner, args.yt_dlp, vid, args.timeout)
            upgraded, new_rows = seed_reference(history, all_entries, lookup)
        if args.dry_run:
            print(json.dumps(doc, ensure_ascii=False, indent=2))
            log(f"dry run: {len(rows)} collector rows, {len(new_rows)} reference rows not written")
            return 1 if failed else 0
        write_atomic(channels_path, json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
        if upgraded != history:
            write_atomic(history_path, "\n".join(upgraded) + ("\n" if upgraded else ""))
        with open(history_path, "a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
            for line in new_rows:
                f.write(line + "\n")
        log(f"wrote {channels_path}: {len(all_entries)} channels ({failed} failed), +{len(rows) + len(new_rows)} history rows")
        return 1 if failed else 0
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Public YouTube numbers for the Shorts 공장 channels (no auth, no downloads).")
    p.add_argument("--out", default="~/shorts_status", help="output folder (channels.json, history.jsonl)")
    p.add_argument("--videos", type=int, default=5, help="latest videos per channel (1–20)")
    p.add_argument("--channel", action="append", help="only this channel id (repeatable)")
    p.add_argument("--timeout", type=int, default=60, help="seconds per yt-dlp call")
    p.add_argument("--retries", type=int, default=2, help="retries per call on timeout/exit")
    p.add_argument("--sleep-min", type=float, default=3.0, help="seconds between yt-dlp calls, lower bound (≥ 1)")
    p.add_argument("--sleep-max", type=float, default=5.0, help="seconds between yt-dlp calls, upper bound")
    p.add_argument("--yt-dlp", default=None, help="yt-dlp binary (default: PATH, then ~/.local/bin/yt-dlp)")
    p.add_argument("--dry-run", action="store_true", help="collect and print, write nothing")
    p.add_argument("--no-reference", action="store_true", help="do not seed the user reference points")
    p.add_argument("--no-lookup", action="store_true", help="do not resolve unmapped reference videos with a per-video lookup")
    return p


def main(argv: list[str] | None = None, runner: Runner = subprocess_runner) -> int:
    args = build_parser().parse_args(argv)
    if not 1 <= args.videos <= 20:
        print("--videos must be 1–20", file=sys.stderr)
        return 2
    if args.yt_dlp is None:
        args.yt_dlp = shutil.which("yt-dlp") or os.path.expanduser("~/.local/bin/yt-dlp")
    if runner is subprocess_runner and not (os.path.isfile(args.yt_dlp) and os.access(args.yt_dlp, os.X_OK)):
        print(f"yt-dlp not found ({args.yt_dlp}); install it (pip install --user yt-dlp) or pass --yt-dlp", file=sys.stderr)
        return 2
    lo, hi = min(args.sleep_min, args.sleep_max), max(args.sleep_min, args.sleep_max)
    if lo < 1.0:
        print("--sleep-min/--sleep-max must be at least 1 second (public pages, be gentle)", file=sys.stderr)
        return 2

    def sleep() -> None:
        if hi > 0:
            time.sleep(random.uniform(lo, hi))

    def log(msg: str) -> None:
        print(f"[{now_iso()}] {msg}", file=sys.stderr)

    try:
        return run(args, runner, sleep, log)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
