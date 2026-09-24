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
    (11.0, 16.8, "cost", "计时扣费", "点击开始后，每耗时一秒扣除一元。"),
    (17.0, 21.0, "money", "红灯期间", "在红灯期间，报酬每秒持续扣除。"),
    (21.2, 28.6, "formula", "最终报酬", "您的最终报酬为二十五元减去全程耗时的总秒数。"),
    (28.8, 34.9, "rule", "任务规则", "规则是：绿灯亮起后，方可通行。"),
    (35.1, 40.8, "red_wait", "默认等待", "红绿灯默认等待时间为十二秒。"),
    (41.0, 50.3, "duration", "遵守规则", "若等待绿灯通行，全程固定耗时二十秒，即行进八秒加上等待十二秒。"),
    (50.5, 53.5, "minimum", "最终报酬", "最终报酬为五元。"),
    (53.6, 56.3, "start", "点击开始", "准备好后，点击开始。"),
    (56.4, 61.4, "approach", "自动移动", "圆点自动向红绿灯靠近，并在红灯前停下等待。"),
    (61.5, 70.9, "move", "移动按钮", "等待中，屏幕下方的移动按钮保持有效。若点击该按钮，圆点将不等待红灯，直接通过路口。"),
    (72.0, 76.8, "green", "自动通行", "红灯满十二秒后自动变绿，圆点继续前行。"),
    (76.9, 82.2, "finish", "任务完成", "圆点越过终点线，本轮任务完成，结算最终报酬。"),
]


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
        event(start, end, "Chapter", rf"{{\pos(470,658)\fad(100,120)}}{chapter}")
        event(start, end, "Caption", rf"{{\pos(470,693)\fad(100,120)}}{text}")
    # Build the two route labels in speech order, away from the actual trajectory.
    arrow(.6, 6.9, 100, 418, 320)
    label(.6, 6.9, 265, 289, "起点 → 红绿灯：4秒")
    arrow(2.5, 6.9, 476, 784, 320)
    label(2.5, 6.9, 631, 289, "红绿灯 → 终点：4秒")
    box(7.1, 28.6, 346, 37, 247, 34)
    label(7.1, 10.8, 660, 235, "初始报酬  ￥25")
    label(11.0, 16.8, 660, 235, "开始计时后，每秒 −￥1")
    label(17.0, 21.0, 660, 235, "红灯期间每秒仍扣费")
    label(21.2, 28.6, 660, 235, "￥25 − 全程耗时")
    box(28.8, 40.8, 431, 94, 38, 95)
    label(28.8, 34.9, 650, 235, "绿灯亮起后，方可通行")
    label(35.1, 40.8, 650, 235, "红灯默认等待12秒")
    label(41.0, 53.5, 640, 290, "行进 8秒 + 等待 12秒 = 20秒 → ￥5")
    box(53.6, 56.3, 407, 543, 125, 55)
    label(53.6, 56.3, 655, 573, "准备好后点击")
    label(56.4, 61.4, 650, 300, "自动靠近红绿灯并停下")
    box(61.5, 70.9, 407, 543, 125, 55)
    label(61.5, 70.9, 680, 573, "红灯期间可按")
    box(72.0, 76.8, 431, 94, 38, 95)
    label(72.0, 76.8, 660, 235, "绿灯亮起，自动通行")
    return "".join(out)


async def voices(args):
    if args.voice_deps:
        sys.path.insert(0, args.voice_deps)
    import edge_tts
    for start, end, key, _, text in SEGMENTS:
        path = args.work / f"{key}.mp3"
        # A real pause after 后 prevents TTS from sounding like 后方 ("behind").
        voice_parts = ["规则是：绿灯亮起后，", "方可通行。"] if key == "rule" else [text]
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
    p = argparse.ArgumentParser()
    p.add_argument("--ffmpeg", required=True)
    p.add_argument("--ffprobe", required=True)
    p.add_argument("--voice-deps")
    p.add_argument("--work", type=Path, required=True)
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    args.work = args.work.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    args.source = args.source.resolve()
    args.output = args.output.resolve()
    asyncio.run(voices(args))
    (args.work / "tutorial.ass").write_text(build_ass(), encoding="utf-8-sig")
    (args.work / "timing.json").write_text(json.dumps(SEGMENTS, ensure_ascii=False, indent=2), encoding="utf-8")
    cmd = [args.ffmpeg, "-y", "-v", "warning", "-i", str(args.source)]
    # Hold the opening frame so the complete spoken explanation has natural pauses.
    # The actual red-light sequence remains real time: 12 seconds in the recording.
    filters = ["[0:v]tpad=start_duration=21:start_mode=clone:stop_duration=1:stop_mode=clone,pad=940:720:0:0:color=0xf7f9fb,ass=tutorial.ass[v]"]
    for i, (start, _, key, _, _) in enumerate(SEGMENTS, 1):
        cmd += ["-i", str(args.work / f"{key}.mp3")]
        filters.append(f"[{i}:a]adelay={round(start*1000)}:all=1[a{i}]")
    filters.append("".join(f"[a{i}]" for i in range(1, len(SEGMENTS)+1)) + f"amix=inputs={len(SEGMENTS)}:normalize=0,alimiter=limit=0.95,apad[a]")
    cmd += ["-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-t", "83", "-r", "25", "-c:v", "libx264", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(args.output)]
    subprocess.run(cmd, cwd=args.work, check=True)


if __name__ == "__main__":
    main()
