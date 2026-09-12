"""
BabelDOC PDF 翻译子进程 runner。

为什么是独立子进程而不是在 FastAPI 进程内跑：
- babeldoc 依赖树极重（opencv/onnx/scikit/pymupdf），常驻会让 ai-service 内存翻倍；
  子进程跑完即退，内存全数归还；
- babeldoc 内部有自己的 asyncio/线程池/日志配置，进程隔离避免与 uvicorn 互相污染；
- 万一版面模型崩溃（原生库段错误）只损失一个任务，不拖垮整个 ai-service。

协议：argv[1] 为配置 JSON 文件路径；stdout 每行一个 JSON 事件（babeldoc 自身日志走
stderr，不混流）：
  {"event": "progress", "stage": "...", "overall": 42.5}
  {"event": "finish", "mono": "...", "dual": "..."}
  {"event": "error", "message": "..."}

配置字段见 main.py 的 PdfTranslateReq。
"""
import asyncio
import json
import os
import sys


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def ensure_assets():
    """确保版面模型/字体/cmap 就位。

    babeldoc 默认把资产放在 ~/.cache/babeldoc（路径写死，无环境变量可改），缺失时联网下载
    约 337MB。便携版随包带了官方离线资产 zip（ai-service/babeldoc-assets/），首次运行从
    本地还原，用户不必联网、也不用等下载。资产已齐时直接返回，开销可忽略。
    """
    from babeldoc.assets import assets
    from babeldoc.const import get_cache_file_path

    file_list = assets.generate_all_assets_file_list()
    missing = any(
        not assets.verify_file(get_cache_file_path(d["name"], kind), d["sha3_256"])
        for kind, descs in file_list.items() for d in descs
    )
    if not missing:
        return
    bundled = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "babeldoc-assets")
    if os.path.isdir(bundled):
        from pathlib import Path
        assets.restore_offline_assets_package(Path(bundled))   # 目录内自动找匹配的 zip
    else:
        assets.warmup()                                        # 无离线包则联网补齐


def main():
    # Windows 下子进程管道默认 GBK，译文路径/报错可能含中文，锁死 UTF-8
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)

    import babeldoc.format.pdf.high_level as high_level
    from babeldoc.docvision.doclayout import DocLayoutModel
    from babeldoc.format.pdf.translation_config import (
        TranslationConfig,
        WatermarkOutputMode,
    )
    from babeldoc.translator.translator import (
        OpenAITranslator,
        set_translate_rate_limiter,
    )

    ensure_assets()

    high_level.init()

    translator = OpenAITranslator(
        lang_in=cfg["lang_in"],
        lang_out=cfg["lang_out"],
        model=cfg["model"],
        base_url=cfg["base_url"],
        api_key=cfg["api_key"],
        ignore_cache=False,
    )
    set_translate_rate_limiter(cfg.get("qps", 4))

    doc_layout_model = DocLayoutModel.load_onnx()
    config = TranslationConfig(
        input_file=cfg["source_path"],
        translator=translator,
        lang_in=cfg["lang_in"],
        lang_out=cfg["lang_out"],
        output_dir=cfg["out_dir"],
        doc_layout_model=doc_layout_model,
        # 译文即产品，不打水印
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
        no_dual=cfg.get("no_dual", True),
        no_mono=False,
        # 文档模式与项目现有管线一致：不做额外的术语抽取（省一轮 LLM 调用，行为可预期）
        auto_extract_glossary=False,
        # 单进程一次性任务，工作线程数跟 QPS 走即可
        qps=cfg.get("qps", 4),
        report_interval=0.5,
    )

    # 字体映射初始化：babeldoc CLI 在翻译前必调，缺了会影响译文字体选择/字形回退
    init_font_mapper = getattr(doc_layout_model, "init_font_mapper", None)
    if init_font_mapper is not None:
        init_font_mapper(config)

    async def run():
        ok = False
        async for event in high_level.async_translate(config):
            t = event.get("type")
            if t in ("progress_update", "progress_end"):
                emit({
                    "event": "progress",
                    "stage": str(event.get("stage", "")),
                    "overall": float(event.get("overall_progress", 0.0)),
                })
            elif t == "finish":
                r = event["translate_result"]
                emit({
                    "event": "finish",
                    "mono": str(r.mono_pdf_path) if r.mono_pdf_path else None,
                    "dual": str(r.dual_pdf_path) if r.dual_pdf_path else None,
                })
                ok = True
                break               # 必须 break（babeldoc 自家 CLI 也这么做）：让生成器
                                    # 跑到底会停在它内部的 finish_event.wait() 上，永不返回
            elif t == "error":
                emit({"event": "error", "message": str(event.get("error", "未知错误"))})
                break
        return ok

    ok = asyncio.run(run())
    # 硬退出而非 return：babeldoc 内部的工作线程池不会被关闭，正常退出会卡在
    # threading._shutdown 里等它们——实测译文已落盘、finish 事件已发出，进程仍常驻，
    # 调用方的 stdout 读取循环因此永不结束，任务卡在 RUNNING。
    # 本进程是一次性任务，产物已在磁盘上，交给 OS 回收资源最干净。
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if ok else 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # 任何未预期异常都以协议行报出，Java 侧才有可读错误
        emit({"event": "error", "message": f"{type(e).__name__}: {e}"})
        sys.stdout.flush()
        os._exit(1)                     # 同上：绕开可能卡住的线程池收尾
