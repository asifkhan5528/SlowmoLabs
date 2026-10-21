"""Browser end-to-end test. Runs the real page, the real decode/encode pipeline and onnxruntime-web,
with a tiny blend model standing in for RIFE (so no GPU and no 20 MB download are needed).
Usage:
  RIFE_MODEL_PATH=$PWD/tests/fixtures/stub_rife.onnx PORT=5199 node server.mjs &     # dev server with the stand-in model
  python3 tests/e2e.py [base_url]                                                    # default http://localhost:5199/
  (needs: pip install playwright, a Chromium for it, and ffprobe on the PATH)"""
import asyncio, base64, json, subprocess, sys, tempfile, os
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5199/"
CLIP = os.path.join(os.path.dirname(__file__), "fixtures", "clip_vp9.webm")
SHOTS = os.environ.get("SHOTS", "/tmp/shots")
fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: fails.append(name)

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1360, "height": 900}, accept_downloads=True)
        await ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script("window.showSaveFilePicker = undefined;")  # headless can't show a save dialog
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_function("document.getElementById('modelLine').dataset.state !== 'loading'", timeout=90000)
        check("model loads", await pg.get_attribute("#modelLine", "data-state") in ("ok", "slow"), await pg.inner_text("#modelText"))
        check("export disabled before a clip", await pg.is_disabled("#go"))

        # --- load the clip
        await pg.set_input_files("#file", CLIP)
        await pg.wait_for_function("!document.getElementById('summary').hidden", timeout=30000)
        check("export enabled after a clip", not await pg.is_disabled("#go"))
        check("LCD shows 8.00", (await pg.inner_text("#lcdFactor .live")).strip() == "8.00", await pg.inner_text("#lcdFactor .live"))
        check("ladder has 8 cells (1 real + 7 generated)", await pg.locator("#ladder .cell").count() == 8 and await pg.locator("#ladder .cell.real").count() == 1)

        # --- settings drive the readout
        await pg.select_option("#preset", "fps-120")
        check("120 fps -> 4.00x", (await pg.inner_text("#lcdFactor .live")).strip() == "4.00")
        check("120 fps -> 4 cells", await pg.locator("#ladder .cell").count() == 4)
        await pg.select_option("#preset", "custom")
        check("custom field appears", await pg.is_visible("#customWrap"))
        await pg.fill("#customFps", "90")
        await pg.dispatch_event("#customFps", "input")
        check("custom 90 fps -> 3.00x", (await pg.inner_text("#lcdFactor .live")).strip() == "3.00")
        await pg.select_option("#preset", "fps-120")

        # --- persistence
        await pg.reload(wait_until="load")
        await pg.wait_for_function("document.getElementById('modelLine').dataset.state !== 'loading'", timeout=90000)
        check("preset is remembered after reload", await pg.input_value("#preset") == "fps-120")

        # --- keyboard + theme + help
        await pg.keyboard.press("t")
        theme1 = await pg.evaluate("document.documentElement.dataset.theme")
        await pg.keyboard.press("t")
        theme2 = await pg.evaluate("document.documentElement.dataset.theme")
        check("T toggles the theme", theme1 != theme2)
        await pg.keyboard.press("?")
        check("? opens help", await pg.evaluate("document.getElementById('helpDialog').open"))
        await pg.keyboard.press("Escape")
        check("Esc closes help", not await pg.evaluate("document.getElementById('helpDialog').open"))

        # --- collapse a window
        await pg.click("button[aria-controls='b-set']")
        check("collapse hides the body", not await pg.is_visible("#b-set"))
        await pg.click("button[aria-controls='b-set']")
        check("expand shows it again", await pg.is_visible("#b-set"))

        # --- the real export
        await pg.set_input_files("#file", CLIP)
        await pg.wait_for_function("!document.getElementById('summary').hidden", timeout=30000)
        await pg.select_option("#preset", "fps-120")
        await pg.click("#go")
        await pg.wait_for_function("document.getElementById('rec').classList.contains('on')", timeout=15000)
        check("REC light on while exporting", True)
        check("cancel button shown while exporting", await pg.is_visible("#cancel") and await pg.is_hidden("#go"))
        await pg.wait_for_function("!document.getElementById('result').hidden", timeout=240000)
        status = await pg.inner_text("#status")
        check("export finished", status.strip() == "Done.", status)
        await pg.screenshot(path=f"{SHOTS}/e2e-result.png", full_page=True)

        # --- inspect the exported file with ffprobe
        url = await pg.get_attribute("#download", "href")
        b64 = await pg.evaluate("async u => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); let s=''; for (let i=0;i<b.length;i+=32768) s += String.fromCharCode(...b.subarray(i,i+32768)); return btoa(s); }", url)
        out = os.path.join(tempfile.mkdtemp(), "out.webm")
        open(out, "wb").write(base64.b64decode(b64))
        pr = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=codec_name,width,height,nb_read_frames,r_frame_rate,duration", "-of", "json", out]))["streams"][0]
        # 2 s at 30 fps = 60 frames; 120 fps target -> 4x -> (60-1)*4+1 = 237 frames, played at 30 fps = 7.9 s
        check("output keeps the codec (VP9) and size", pr["codec_name"] == "vp9" and pr["width"] == 640 and pr["height"] == 360, str(pr))
        check("output has 237 frames", int(pr["nb_read_frames"]) == 237, str(pr))
        dur = float(pr["duration"]) if pr.get("duration") not in (None, "N/A") else 237 / 30
        check("output is ~7.9 s long (4x slower)", abs(dur - 7.9) < 0.3, str(dur))

        # --- compare mode
        await pg.click("#compareBtn")
        check("compare shows the original", await pg.is_visible("#cmpFig") and await pg.get_attribute("#compareBtn", "aria-pressed") == "true")
        await pg.evaluate("document.getElementById('outVideo').play()")
        await pg.wait_for_timeout(1500)
        rate = await pg.evaluate("document.getElementById('cmpVideo').playbackRate")
        check("original plays at 0.25x to match", abs(rate - 0.253) < 0.02, str(rate))
        await pg.evaluate("document.getElementById('outVideo').pause()")
        await pg.screenshot(path=f"{SHOTS}/e2e-compare.png", full_page=True)

        # --- debug report
        await pg.click("#debugBtn")
        await pg.wait_for_timeout(400)
        clip = await pg.evaluate("navigator.clipboard.readText()")
        check("debug report is copied and has the key facts", "Slow-Mo Lab v" in clip and "WebGPU:" in clip and "Settings: shot 120" in clip, clip[:200])

        # --- a second export is cancelled part-way
        await pg.set_input_files("#file", CLIP)
        await pg.wait_for_function("!document.getElementById('summary').hidden", timeout=30000)
        await pg.select_option("#preset", "fps-960")
        await pg.click("#go")
        await pg.wait_for_function("document.getElementById('rec').classList.contains('on')", timeout=15000)
        await pg.wait_for_timeout(1500)
        await pg.click("#cancel")
        await pg.wait_for_function("document.getElementById('status').textContent.trim() === 'Cancelled.'", timeout=30000)
        check("cancel works and the UI recovers", not await pg.is_disabled("#go") and not await pg.evaluate("document.getElementById('rec').classList.contains('on')"))

        check("no page errors", not errs, "; ".join(errs))
        await b.close()
    print("\n%d failed" % len(fails) if fails else "\nALL PASSED")
    sys.exit(1 if fails else 0)
asyncio.run(main())
