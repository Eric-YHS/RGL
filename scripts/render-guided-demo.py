"""Build the narrated tutorial from our recorded task, with timed vector callouts.

Requires ffmpeg (libass), ffprobe, edge-tts, and Microsoft YaHei on Windows.
The source video is our existing demo-guided-0921.mp4. Its task clock is untouched.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SEGMENTS = [
    (0.4, 5.9, "route", "两段路程", "起点到红绿灯、红绿灯到终点，各需四秒。"),
    (6.3, 9.2, "initial", "初始报酬", "初始报酬，二十五元。"),
    (9.6, 13.8, "cost", "计时扣费", "点击开始后，每耗时一秒，扣除一元。"),
    (14.3, 19.3, "rule", "任务规则", "红灯等待十二秒。规则是，等绿灯后通行。"),
    (19.8, 23.8, "start", "点击开始", "准备好后，点击开始。"),
    (24.5, 27.9, "approach", "自动移动", "圆点自动向红绿灯靠近。"),
    (28.3, 31.0, "stop", "自动停下", "圆点自动停下等待。"),
    (31.4, 34.7, "count", "红灯倒计时", "红灯十二秒后，自动变绿。"),
    (35.0, 38.0, "money", "报酬变化", "等待时，报酬持续减少。"),
    (38.2, 41.9, "move", "移动按钮", "等待中，随时可以点击移动按钮。"),
    (42.2, 46.0, "pass", "通过红绿灯", "点击后，圆点立刻通过红绿灯。"),
    (46.6, 50.7, "finish", "任务完成", "越过终点线，本轮任务完成。"),
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
    arrow(.6, 5.9, 100, 418, 320)
    label(.6, 5.9, 265, 289, "起点 → 红绿灯：4秒")
    arrow(2.5, 5.9, 476, 784, 320)
    label(2.5, 5.9, 631, 289, "红绿灯 → 终点：4秒")
    box(6.3, 13.8, 346, 37, 247, 34)
    label(6.3, 9.2, 660, 235, "初始报酬  ￥25")
    label(9.6, 13.8, 660, 235, "开始计时后，每秒 −￥1")
    box(14.3, 19.3, 431, 94, 38, 95)
    label(14.3, 16.8, 650, 235, "红灯等待 12秒")
    label(16.8, 19.3, 650, 235, "任务规则：绿灯后通行")
    box(19.8, 24.1, 407, 543, 125, 55)
    label(19.8, 23.8, 655, 573, "准备好后点击")
    label(24.5, 27.9, 650, 300, "自动靠近红绿灯")
    label(28.3, 31, 640, 330, "到达后自动停下")
    box(31.4, 34.7, 431, 94, 38, 95)
    label(31.4, 34.7, 660, 235, "红灯倒计时")
    box(35, 37.9, 346, 37, 247, 34)
    label(35, 37.9, 660, 235, "等待期间仍在计时扣费")
    box(38.2, 42.2, 407, 543, 125, 55)
    label(38.2, 41.9, 680, 573, "等待中随时可按")
    label(42.2, 46, 635, 300, "按下后立即通行")
    return "".join(out)


async def voices(args):
    if args.voice_deps:
        sys.path.insert(0, args.voice_deps)
    import edge_tts
    for start, end, key, _, text in SEGMENTS:
        path = args.work / f"{key}.mp3"
        fingerprint = hashlib.sha256((text + '|zh-CN-XiaoxiaoNeural|+0%').encode()).hexdigest()
        cache_key = args.work / f"{key}.sha256"
        if not path.exists() or not cache_key.exists() or cache_key.read_text() != fingerprint:
            # Cache completed clips; retry transient service failures with capped waits.
            delay = 2
            while True:
                try:
                    await edge_tts.Communicate(text, "zh-CN-XiaoxiaoNeural", rate="+0%").save(str(path))
                    cache_key.write_text(fingerprint)
                    break
                except (ConnectionError, TimeoutError) as exc:
                    print(f"Retry {key}: {exc}", flush=True)
                    await asyncio.sleep(delay)
                    delay = min(30, delay * 2)
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
    filters = ["[0:v]pad=940:720:0:0:color=0xf7f9fb,ass=tutorial.ass[v]"]
    for i, (start, _, key, _, _) in enumerate(SEGMENTS, 1):
        cmd += ["-i", str(args.work / f"{key}.mp3")]
        filters.append(f"[{i}:a]adelay={round(start*1000)}:all=1[a{i}]")
    filters.append("".join(f"[a{i}]" for i in range(1, len(SEGMENTS)+1)) + f"amix=inputs={len(SEGMENTS)}:normalize=0,alimiter=limit=0.95,apad[a]")
    cmd += ["-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-t", "51", "-r", "25", "-c:v", "libx264", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(args.output)]
    subprocess.run(cmd, cwd=args.work, check=True)


if __name__ == "__main__":
    main()
