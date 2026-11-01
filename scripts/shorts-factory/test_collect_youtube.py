#!/usr/bin/env python3
"""Offline tests for collect_youtube.py: a fake yt-dlp runner, no network, no sleeping.
Run: python3 -I scripts/shorts-factory/test_collect_youtube.py   (vitest runs it via src/server/hub/shorts-collector.test.ts)"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I drops the script dir from sys.path
import collect_youtube as cy  # noqa: E402

CH1 = "UC3rtb2M3lZoKIkIZWR4saYQ"
CH2 = "UC6OpOfe_e7tS665qqZgmc8g"


def tab(entries: list[tuple[str, int | None]], **extra: Any) -> dict[str, Any]:
    return {"channel_id": extra.get("channel_id", CH1), "channel_follower_count": extra.get("subs"), "view_count": extra.get("views"),
            "playlist_count": len(entries), "entries": [{"id": i, "title": f"t-{i}", "view_count": v, "url": f"https://www.youtube.com/shorts/{i}"} for i, v in entries]}


class FakeRunner:
    """Maps a URL substring to a scripted response list; each call pops the next one. ('exit', code, stderr) | ('json', obj) | ('timeout',) | ('raw', text)."""

    def __init__(self, script: dict[str, list[tuple[Any, ...]]]):
        self.script = script
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], timeout_s: int) -> tuple[int, str, str]:
        self.calls.append(argv)
        url = argv[-1]
        for key, steps in self.script.items():
            if key in url:
                step = steps.pop(0) if len(steps) > 1 else steps[0]
                break
        else:
            return 1, "", "ERROR: no script for " + url
        if step[0] == "timeout":
            raise cy.CollectError("timeout", f"timeout after {timeout_s}s")
        if step[0] == "exit":
            return step[1], "", step[2]
        if step[0] == "raw":
            return 0, step[1], ""
        return 0, json.dumps(step[1]), ""


def args(**kw: Any) -> Any:
    ns = cy.build_parser().parse_args([])
    ns.yt_dlp = "yt-dlp"
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns


class Sleeper:
    def __init__(self) -> None:
        self.n = 0

    def __call__(self) -> None:
        self.n += 1


class ParseTab(unittest.TestCase):
    def test_counts_and_entries(self) -> None:
        r = cy.parse_tab(tab([("a", 545), ("b", None), ("c", 10)], subs=None, views=None), 2)
        self.assertEqual(r["subscribers"], None)
        self.assertEqual(r["total_views"], None)
        self.assertEqual(r["video_count"], 3)
        self.assertEqual([v["id"] for v in r["videos"]], ["a", "b"])
        self.assertEqual(r["videos"][1]["views"], None)
        self.assertEqual(r["videos"][0]["url"], "https://www.youtube.com/shorts/a")

    def test_bad_shapes_do_not_raise_and_never_become_zero(self) -> None:
        r = cy.parse_tab({"entries": [None, {"title": "no id"}, {"id": "x", "view_count": -4}], "channel_follower_count": True, "view_count": "12"}, 5)
        self.assertEqual(r["subscribers"], None)  # bool is not a count
        self.assertEqual(r["total_views"], None)
        self.assertEqual(r["videos"], [{"id": "x", "title": None, "views": None, "url": "https://www.youtube.com/shorts/x", "uploaded_at": None}])


class FetchChannel(unittest.TestCase):
    def test_shorts_tab_first_no_cookies_bounded_items(self) -> None:
        run = FakeRunner({"/shorts": [("json", tab([("a", 1)]))]})
        r = cy.fetch_channel(run, "yt-dlp", CH1, 3, 60, 2, Sleeper())
        self.assertEqual(len(run.calls), 1)
        argv = run.calls[0]
        self.assertTrue(argv[-1].endswith(f"/channel/{CH1}/shorts"))
        for flag in ("--ignore-config", "--no-cookies-from-browser", "--skip-download", "--flat-playlist", "-J"):
            self.assertIn(flag, argv)
        self.assertIn("1-3", argv)
        self.assertFalse(any("cookie" in a and "no-cookies" not in a for a in argv))
        self.assertEqual(r["videos"][0]["id"], "a")

    def test_falls_back_to_videos_tab_with_a_sleep_between(self) -> None:
        s = Sleeper()
        run = FakeRunner({"/shorts": [("exit", 1, "ERROR: [youtube:tab] UC..: This channel does not have a shorts tab")], "/videos": [("json", tab([("b", 2)]))]})
        r = cy.fetch_channel(run, "yt-dlp", CH1, 5, 60, 2, s)
        self.assertEqual([c[-1].rsplit("/", 1)[1] for c in run.calls], ["shorts", "videos"])
        self.assertEqual(s.n, 1)
        self.assertEqual(r["videos"][0]["id"], "b")

    def test_retries_are_bounded_and_timeouts_surface(self) -> None:
        s = Sleeper()
        run = FakeRunner({"/shorts": [("timeout",)]})
        with self.assertRaises(cy.CollectError) as cm:
            cy.fetch_channel(run, "yt-dlp", CH1, 5, 7, 2, s)
        self.assertEqual(cm.exception.kind, "timeout")
        self.assertEqual(len(run.calls), 3)  # 1 + 2 retries, and no /videos attempt after a timeout
        self.assertEqual(s.n, 2)

    def test_bad_json_is_not_retried(self) -> None:
        run = FakeRunner({"/shorts": [("raw", "<html>")]})
        with self.assertRaises(cy.CollectError) as cm:
            cy.fetch_channel(run, "yt-dlp", CH1, 5, 60, 3, Sleeper())
        self.assertEqual(cm.exception.kind, "json")
        self.assertEqual(len(run.calls), 1)


class Merge(unittest.TestCase):
    plan = cy.CHANNELS[0]

    def test_failure_keeps_previous_numbers_and_moves_only_attempt_and_error(self) -> None:
        prev = {"id": CH1, "subscribers": 10, "total_views": 99, "video_count": 2, "videos": [{"id": "a", "views": 1}], "last_attempt_at": "t0", "last_success_at": "t0", "error": None,
                "platforms": {"youtube": {"status": "live", "url": "u"}, "tiktok": {"status": "none"}}}
        out = cy.merge_channel(prev, self.plan, None, "timeout: timeout after 60s", "t1")
        self.assertEqual((out["subscribers"], out["total_views"], out["video_count"], out["videos"]), (10, 99, 2, [{"id": "a", "views": 1}]))
        self.assertEqual((out["last_attempt_at"], out["last_success_at"]), ("t1", "t0"))
        self.assertEqual(out["error"], "timeout: timeout after 60s")
        self.assertEqual(out["platforms"]["youtube"], {"status": "live", "url": "u"})
        self.assertEqual(out["platforms"]["instagram"], {"status": "none"})

    def test_success_replaces_numbers_and_marks_youtube_live(self) -> None:
        res = cy.parse_tab(tab([("a", 5)]), 5)
        out = cy.merge_channel(None, self.plan, res, None, "t1")
        self.assertEqual((out["subscribers"], out["total_views"], out["video_count"]), (None, None, 1))
        self.assertEqual((out["last_attempt_at"], out["last_success_at"], out["error"]), ("t1", "t1", None))
        self.assertEqual(out["platforms"]["youtube"]["status"], "live")
        self.assertEqual(out["platforms"]["youtube"]["url"], f"https://www.youtube.com/channel/{CH1}")
        self.assertEqual(out["publish_kst"], "18:00")


class Reference(unittest.TestCase):
    def channels(self) -> list[dict[str, Any]]:
        return [{"id": CH1, "videos": [{"id": "h1yhOEI46fg", "views": 2300}, {"id": "zCpK0B_jnnw", "views": 545}]}]

    def test_seeds_once_maps_from_collected_then_lookup_else_unmapped(self) -> None:
        looked: list[str] = []

        def lookup(vid: str) -> str | None:
            looked.append(vid)
            return CH2 if vid == "u0sAQG6Ur0k" else None

        kept, new = cy.seed_reference([], self.channels(), lookup)
        self.assertEqual(kept, [])
        rows = [json.loads(l) for l in new]
        self.assertEqual(len(rows), len(cy.REFERENCE_VIEWS))
        by = {r["videos"][0]["id"]: r for r in rows}
        self.assertEqual((by["h1yhOEI46fg"]["channel_id"], by["h1yhOEI46fg"]["mapping"]), (CH1, "collected"))
        self.assertEqual((by["u0sAQG6Ur0k"]["channel_id"], by["u0sAQG6Ur0k"]["mapping"]), (CH2, "live_lookup"))
        self.assertEqual((by["Ab9r7LBi4ig"]["channel_id"], by["Ab9r7LBi4ig"]["mapping"]), (None, "unmapped"))
        self.assertEqual(by["h1yhOEI46fg"]["videos"], [{"id": "h1yhOEI46fg", "views": 2163}])
        self.assertTrue(all(r["at"] == cy.REFERENCE_AT and r["source"] == "user_reference" for r in rows))
        self.assertEqual(sorted(looked), sorted(v for v in cy.REFERENCE_VIEWS if v not in ("h1yhOEI46fg", "zCpK0B_jnnw")))
        # second run: nothing new, nothing re-looked-up
        looked.clear()
        kept2, new2 = cy.seed_reference(new, self.channels(), lookup)
        self.assertEqual(new2, [])
        self.assertEqual(kept2, new)
        self.assertEqual(looked, [])

    def test_unmapped_row_upgraded_in_place_when_collected_later(self) -> None:
        _, new = cy.seed_reference([], [], None)
        self.assertTrue(all(json.loads(l)["channel_id"] is None for l in new))
        history = ["not json", *new, json.dumps({"at": "x", "channel_id": CH1, "source": "collector", "videos": []})]
        kept, new2 = cy.seed_reference(history, self.channels(), None)
        self.assertEqual(new2, [])
        self.assertEqual(len(kept), len(history))
        self.assertEqual(kept[0], "not json")
        self.assertEqual(kept[-1], history[-1])
        rows = [json.loads(l) for l in kept[1:-1]]
        up = {r["videos"][0]["id"]: r for r in rows}
        self.assertEqual((up["zCpK0B_jnnw"]["channel_id"], up["zCpK0B_jnnw"]["mapping"]), (CH1, "collected"))
        self.assertEqual((up["Ab9r7LBi4ig"]["channel_id"], up["Ab9r7LBi4ig"]["mapping"]), (None, "unmapped"))


class EndToEnd(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = self.tmp.name
        self.logs: list[str] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_collector(self, script: dict[str, list[tuple[Any, ...]]], **kw: Any) -> tuple[int, FakeRunner, Sleeper]:
        runner, sleeper = FakeRunner(script), Sleeper()
        code = cy.run(args(out=self.out, no_lookup=True, **kw), runner, sleeper, self.logs.append)
        return code, runner, sleeper

    def read(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        with open(os.path.join(self.out, "channels.json"), encoding="utf-8") as f:
            ch = json.load(f)
        hp = os.path.join(self.out, "history.jsonl")
        rows: list[dict[str, Any]] = []
        if os.path.exists(hp):
            with open(hp, encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
        return ch, rows

    def test_full_run_partial_failure_exit_1_and_data_preserved_on_next_failure(self) -> None:
        script = {f"{CH1}/shorts": [("json", tab([("h1yhOEI46fg", 2300)], channel_id=CH1))], f"{CH2}/shorts": [("exit", 1, "ERROR: HTTP Error 429")]}
        script.update({f"{c['id']}/shorts": [("json", tab([(f"v-{c['id'][-4:]}", 7)], channel_id=c["id"]))] for c in cy.CHANNELS[2:]})
        code, runner, sleeper = self.run_collector(script)
        self.assertEqual(code, 1)
        ch, rows = self.read()
        self.assertEqual(ch["planned_total"], cy.PLANNED_TOTAL)
        self.assertEqual([c["id"] for c in ch["channels"]], [c["id"] for c in cy.CHANNELS])
        c2 = next(c for c in ch["channels"] if c["id"] == CH2)
        self.assertEqual((c2["videos"], c2["last_success_at"]), ([], None))
        self.assertTrue(c2["error"].startswith("exit: yt-dlp exit 1"))
        self.assertEqual(c2["platforms"]["youtube"]["status"], "none")
        self.assertEqual(sum(1 for r in rows if r["source"] == "collector"), 6)
        self.assertEqual(sum(1 for r in rows if r["source"] == "user_reference"), 7)
        self.assertEqual(next(r for r in rows if r["videos"][0]["id"] == "h1yhOEI46fg" and r["source"] == "user_reference")["channel_id"], CH1)
        # sleeps between channels (6) + retries for CH2 (2) — no sleep before the first call
        self.assertEqual(sleeper.n, 6 + 2)
        self.assertFalse(any(f.startswith(".tmp-") for f in os.listdir(self.out)))
        # next run: only CH1, which now times out → its numbers stay, the other six entries stay, history gains nothing
        code2, _, _ = self.run_collector({f"{CH1}/shorts": [("timeout",)]}, channel=[CH1])
        self.assertEqual(code2, 1)
        ch2, rows2 = self.read()
        self.assertEqual(len(ch2["channels"]), 7)
        c1 = next(c for c in ch2["channels"] if c["id"] == CH1)
        self.assertEqual(c1["videos"][0]["views"], 2300)
        self.assertEqual(c1["last_success_at"], ch["channels"][0]["last_success_at"])
        self.assertGreaterEqual(c1["last_attempt_at"], c1["last_success_at"])
        self.assertTrue(c1["error"].startswith("timeout"))
        self.assertEqual(len(rows2), len(rows))

    def test_dry_run_writes_nothing_and_prints_document(self) -> None:
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            code, _, _ = self.run_collector({"/shorts": [("json", tab([("a", 1)]))]}, dry_run=True, channel=[CH1])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buf.getvalue())["channels"][0]["id"], CH1)
        self.assertEqual(sorted(os.listdir(self.out)), [".collect.lock"])

    def test_lock_conflict_exits_2(self) -> None:
        import fcntl
        fd = os.open(os.path.join(self.out, ".collect.lock"), os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            code, runner, _ = self.run_collector({"/shorts": [("json", tab([("a", 1)]))]})
        finally:
            os.close(fd)
        self.assertEqual(code, 2)
        self.assertEqual(runner.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.out, "channels.json")))

    def test_unknown_channel_and_no_reference_flags(self) -> None:
        code, _, _ = self.run_collector({}, channel=["UCnope"])
        self.assertEqual(code, 2)
        code, _, _ = self.run_collector({"/shorts": [("json", tab([("a", 1)]))]}, channel=[CH1], no_reference=True)
        self.assertEqual(code, 0)
        _, rows = self.read()
        self.assertEqual([r["source"] for r in rows], ["collector"])


class Cli(unittest.TestCase):
    def test_sleep_floor_and_video_bounds_exit_2(self) -> None:
        import io
        from contextlib import redirect_stderr
        with redirect_stderr(io.StringIO()):
            self.assertEqual(cy.main(["--sleep-min", "0", "--dry-run"], runner=FakeRunner({})), 2)
            self.assertEqual(cy.main(["--videos", "0"], runner=FakeRunner({})), 2)
            self.assertEqual(cy.main(["--videos", "21"], runner=FakeRunner({})), 2)

    def test_atomic_write_replaces_whole_file(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.json")
            cy.write_atomic(p, "one")
            cy.write_atomic(p, "two")
            with open(p, encoding="utf-8") as f:
                self.assertEqual(f.read(), "two")
            self.assertEqual(os.listdir(d), ["x.json"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
