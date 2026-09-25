"""Build the narrated tutorial from the current task, with timed vector callouts.

Requires ffmpeg (libass), ffprobe, edge-tts, and Microsoft YaHei on Windows.
The source is a 940x640 crop of the real task recorded by record-auto-green-demo.mjs.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SEGMENTS = [
    (0.4, 6.9, "route", "两段路程", "从起点到红绿灯、红绿灯到终点，各需四秒。"),
    (7.1, 10.8, "initial", "初始报酬", "初始报酬二十五元。"),
    (11.0, 16.8, "cost", "计时扣费", "点击开始后，每耗时1秒扣除1元。"),
    (17.0, 24.4, "formula", "最终报酬", "您的最终报酬为25元减去全程等待的总秒数。"),
    (24.6, 30.7, "rule", "任务规则", "规则是，绿灯亮起后方可通行。"),
    (30.9, 36.6, "red_wait", "默认等待", "红绿灯默认等待时间为12秒。"),
    (36.8, 46.1, "duration", "遵守规则", "若等待绿灯通行，全程固定耗时20秒（即行进8秒加上等待12秒），"),
    (46.3, 49.3, "minimum", "最终报酬", "最终报酬为5元。"),
    (49.4, 52.1, "start", "点击开始", "准备好后，点击开始。"),
    (52.2, 57.3, "approach", "自动移动", "原点自动向红绿灯靠近，并在红灯前停下等待"),
    (57.5, 61.5, "money", "红灯期间", "在红灯期间，报酬每秒持续扣除。"),
    (68.0, 72.8, "green", "自动通行", "红灯满12秒后自动变绿，圆点继续前行"),
    (72.9, 82.7, "move", "移动按钮", "等待中，屏幕下方的移动按钮保持有效，若点击该按钮，圆点将不等待红灯、直接通过路口。"),
    (82.9, 88.3, "finish", "任务完成", "圆点越过终点线，本轮任务完成，结算最终报酬。"),
]

# Pointer tip coordinates in the cropped task. These use the final speech clock,
# not the original recording clock, so edits/holds cannot shift the pointer.
POINTER_CUES = [
    (0.4, 2.5, 100, 398, 420, 398),
    (2.5, 5.1, 451, 398, 784, 398),
    (7.1, 10.8, 525, 55, 525, 55),
    (11.0, 12.5, 470, 570, 470, 570),
    (12.5, 12.9, 470, 570, 525, 55),
    (12.9, 24.4, 525, 55, 525, 55),
    (24.6, 30.7, 451, 160, 451, 160),
    (30.9, 34.5, 481, 115, 481, 115),
    (36.8, 38.5, 451, 160, 451, 160),
    (38.5, 42.0, 100, 398, 784, 398),
    (42.0, 46.1, 481, 115, 481, 115),
    (46.3, 49.3, 525, 55, 525, 55),
    (49.4, 50.0, 505, 604, 470, 570),
    (50.0, 52.1, 470, 570, 470, 570),
    (52.2, 56.0, 118, 416, 438, 416),
    (56.0, 57.3, 423, 398, 423, 398),
    (57.5, 61.5, 525, 55, 525, 55),
    (68.0, 70.2, 451, 160, 451, 160),
    (70.2, 72.3, 600, 415, 784, 415),
    (72.9, 77.6, 470, 570, 470, 570),
    (77.6, 81.2, 465, 418, 784, 418),
]


def validate_transcript():
    approved = Path(__file__).with_name("demo-narration-approved-0925.txt").read_text(encoding="utf-8")
    assert "".join(approved.splitlines()) == "".join(s[4] for s in SEGMENTS), "Narration must match the approved transcript exactly, in order"


def stamp(t):
    return f"0:{int(t)//60:02}:{t%60:05.2f}"


def build_ass():
    out = ["""[Script Info]
ScriptType: v4.00+
PlayResX: 940
PlayResY: 720
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Microsoft YaHei,25,&H00322A22,&H00322A22,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,20,20,0,1
Style: Chapter,Microsoft YaHei,15,&H00806040,&H00806040,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,20,20,0,1
Style: Label,Microsoft YaHei,23,&H00906016,&H00906016,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,5,0,0,0,1
Style: Shape,Microsoft YaHei,20,&H00906016,&H00906016,&H00906016,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Cursor,Microsoft YaHei,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1.5,1,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""]

    def event(start, end, style, text, layer=2):
        out.append(f"Dialogue: {layer},{stamp(start)},{stamp(end)},{style},,0,0,0,,{text}\n")

    def label(start, end, x, y, text):
        event(start, end, "Label", rf"{{\pos({x},{y})\fad(180,180)}}{text}")

    def line(start, end, x1, y1, x2, y2, width=3):
        # Polygon vector stroke; no generated or edited raster assets.
        if y1 == y2:
            path = f"m {x1} {y1} l {x2} {y2} {x2} {y2+width} {x1} {y1+width}"
        else:
            path = f"m {x1} {y1} l {x2} {y2} {x2+width} {y2} {x1+width} {y1}"
        event(start, end, "Shape", rf"{{\pos(0,0)\fad(180,180)\p1}}{path}{{\p0}}", 1)

    def box(start, end, x, y, w, h):
        line(start, end, x, y, x+w, y)
        line(start, end, x, y+h, x+w, y+h)
        line(start, end, x, y, x, y+h)
        line(start, end, x+w, y, x+w, y+h)

    def arrow(start, end, x1, x2, y):
        line(start, end, x1, y, x2, y)
        event(start, end, "Shape", rf"{{\pos(0,0)\fad(180,180)\p1}}m {x2-10} {y-7} l {x2+2} {y+1} {x2-10} {y+9}{{\p0}}", 1)

    for start, end, key, chapter, text in SEGMENTS:
        event(start, end, "Caption", rf"{{\pos(470,693)\fad(100,120)}}{text}")
    for start, end, x1, y1, x2, y2 in POINTER_CUES:
        motion = rf"\pos({x1},{y1})" if (x1, y1) == (x2, y2) else rf"\move({x1},{y1},{x2},{y2})"
        event(start, end, "Cursor", "{" + motion + r"\p1}m 0 0 l 0 27 7 20 13 33 18 31 12 18 23 18{\p0}", 4)
    # Build the two route labels in speech order, away from the actual trajectory.
    arrow(.6, 6.9, 100, 418, 320)
    arrow(2.5, 6.9, 476, 784, 320)
    box(7.1, 10.8, 346, 37, 247, 34)
    box(11.0, 12.5, 407, 543, 125, 55)
    box(12.9, 24.4, 346, 37, 247, 34)
    box(24.6, 36.6, 431, 94, 38, 95)
    box(49.4, 52.1, 407, 543, 125, 55)
    box(57.5, 61.5, 346, 37, 247, 34)
    box(68.0, 72.8, 431, 94, 38, 95)
    box(72.9, 77.6, 407, 543, 125, 55)
    # Brief press feedback at the actual early-pass click, without extra text.
    box(77.3, 77.6, 401, 537, 137, 67)
    return "".join(out)


async def voices(args):
    if args.voice_deps:
        sys.path.insert(0, args.voice_deps)
    import edge_tts
    for start, end, key, _, text in SEGMENTS:
        path = args.work / f"{key}.mp3"
        # A real pause after 后 prevents TTS from sounding like 后方 ("behind").
        voice_parts = ["规则是，绿灯亮起后", "方可通行。"] if key == "rule" else [text]
        assert "".join(voice_parts) == text
        fingerprint = hashlib.sha256(("|".join(voice_parts) + '|zh-CN-XiaoxiaoNeural|+0%|rule-pause-400ms').encode()).hexdigest()
        cache_key = args.work / f"{key}.sha256"
        if not path.exists() or not cache_key.exists() or cache_key.read_text() != fingerprint:
            # Cache completed clips; retry transient service failures with capped waits.
            for part_num, part_text in enumerate(voice_parts):
                part_path = args.work / f"{key}-part{part_num}.mp3" if key == "rule" else path
                delay = 2
                while True:
                    try:
                        await edge_tts.Communicate(part_text, "zh-CN-XiaoxiaoNeural", rate="+0%").save(str(part_path))
                        break
                    except (ConnectionError, TimeoutError) as exc:
                        print(f"Retry {key}: {exc}", flush=True)
                        await asyncio.sleep(delay)
                        delay = min(30, delay * 2)
            if key == "rule":
                subprocess.run([
                    args.ffmpeg, "-y", "-v", "error", "-i", str(args.work / "rule-part0.mp3"),
                    "-i", str(args.work / "rule-part1.mp3"), "-filter_complex",
                    "[0:a]apad=pad_dur=0.4[a0];[a0][1:a]concat=n=2:v=0:a=1[a]",
                    "-map", "[a]", "-q:a", "2", str(path),
                ], check=True)
            cache_key.write_text(fingerprint)
        duration = float(subprocess.check_output([args.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], text=True))
        if duration > end - start:
            raise ValueError(f"{key}: {duration:.3f}s does not fit {end-start:.3f}s; shorten narration")
        print(f"{key}: {duration:.3f}s; next cue in {end-start-duration:.3f}s", flush=True)


def main():
    validate_transcript()
    p = argparse.ArgumentParser()
    p.add_argument("--ffmpeg", required=True)
    p.add_argument("--ffprobe", required=True)
    p.add_argument("--voice-deps")
    p.add_argument("--work", type=Path, required=True)
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--source-action-time", type=float, default=35.0)
    p.add_argument("--early-source", type=Path, required=True)
    p.add_argument("--early-click-time", type=float, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    args.work = args.work.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    args.source = args.source.resolve()
    args.output = args.output.resolve()
    asyncio.run(voices(args))
    (args.work / "tutorial.ass").write_text(build_ass(), encoding="utf-8-sig")
    (args.work / "timing.json").write_text(json.dumps(SEGMENTS, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.work / "pointer-timing.json").write_text(json.dumps(POINTER_CUES, indent=2), encoding="utf-8")
    cmd = [args.ffmpeg, "-y", "-v", "warning", "-i", str(args.source), "-i", str(args.early_source.resolve())]
    # Hold the opening frame so the complete spoken explanation has natural pauses.
    # The actual red-light sequence remains real time: 12 seconds in the recording.
    # Source is trimmed to the fully loaded task before rendering. It contains
    # no pointer; the pointer is drawn by build_ass on the final speech clock.
    # Demonstrate a real early red-light click at 77.3s for the next approved
    # sentence, then let that recording cross the finish line and complete.
    opening_hold = 52.0 - args.source_action_time
    early_trim = args.early_click_time - (77.3 - 72.9)
    assert opening_hold >= 0
    filters = [f"[0:v]setpts=PTS-STARTPTS,tpad=start_duration={opening_hold}:start_mode=clone:stop_duration=12:stop_mode=clone[scene];[1:v]trim=start={early_trim},setpts=PTS-STARTPTS+72.9/TB,tpad=stop_duration=12:stop_mode=clone[early];[scene][early]overlay=enable='gte(t,72.9)',pad=940:720:0:0:color=0xf7f9fb,ass=tutorial.ass[v]"]
    for i, (start, _, key, _, _) in enumerate(SEGMENTS, 2):
        cmd += ["-i", str(args.work / f"{key}.mp3")]
        filters.append(f"[{i}:a]adelay={round(start*1000)}:all=1[a{i}]")
    filters.append("".join(f"[a{i}]" for i in range(2, len(SEGMENTS)+2)) + f"amix=inputs={len(SEGMENTS)}:normalize=0,alimiter=limit=0.95,apad[a]")
    cmd += ["-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-t", "89", "-r", "25", "-c:v", "libx264", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(args.output)]
    subprocess.run(cmd, cwd=args.work, check=True)


if __name__ == "__main__":
    main()
