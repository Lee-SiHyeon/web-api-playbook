from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
CORE_PATH = HERE / "build-reference-corpus.py"


def load_core():
    spec = importlib.util.spec_from_file_location("naver_reference_core", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("reference_core_load_failed")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def med(values):
    return statistics.median(values) if values else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a current Naver Blog reference brief before writing.")
    parser.add_argument("query", help="Naver Blog search query")
    parser.add_argument("--limit", type=int, default=8, choices=range(3, 13))
    args = parser.parse_args()

    core = load_core()
    search_results = core.search_query(args.query)
    analyses = []
    failures = []
    for result in search_results[: args.limit]:
        try:
            post = core.analyze_post(result.href)
            post["search"] = core.asdict(result)
            analyses.append(post)
        except Exception as error:
            failures.append({"href": result.href, "error": type(error).__name__})
        time.sleep(0.3)

    signal_counts = Counter()
    title_types = Counter()
    hook_types = Counter()
    for post in analyses:
        signal_counts.update(key for key, enabled in post["signals"].items() if enabled)
        title_types.update(post["titleTypes"])
        hook_types.update(post["hookTypes"])

    summary = {
        "postCount": len(analyses),
        "medianTitleLength": med([post["titleLength"] for post in analyses]),
        "medianTextLength": med([post["textLength"] for post in analyses]),
        "medianParagraphCount": med([post["paragraphCount"] for post in analyses]),
        "medianImageCount": med([post["imageCount"] for post in analyses]),
        "signalRates": {
            key: round(count / len(analyses), 3) if analyses else 0
            for key, count in signal_counts.items()
        },
        "titleTypes": dict(title_types.most_common()),
        "hookTypes": dict(hook_types.most_common()),
    }

    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    slug = core.re.sub(r"[^0-9A-Za-z가-힣]+", "-", args.query).strip("-") or "topic"
    record = {
        "schemaVersion": 1,
        "checkedAt": checked_at,
        "query": args.query,
        "summary": summary,
        "posts": analyses,
        "failures": failures,
    }
    json_path = HERE / f"brief-{slug}.json"
    md_path = HERE / f"brief-{slug}.md"
    json_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        f"# 네이버 블로그 레퍼런스 브리프: {args.query}",
        "",
        f"- 확인 시각: {checked_at}",
        f"- 분석 게시물: {len(analyses)}개",
        f"- 제목 중앙값: {summary['medianTitleLength']}자",
        f"- 본문 중앙값: {summary['medianTextLength']}자",
        f"- 이미지 중앙값: {summary['medianImageCount']}개",
        f"- 문단 중앙값: {summary['medianParagraphCount']}개",
        "",
        "## 현재 노출 게시물",
        "",
    ]
    for index, post in enumerate(analyses, 1):
        search = post["search"]
        lines.extend(
            [
                f"### {index}. {post['title']}",
                "",
                f"- 검색 순위: {search['rank']}",
                f"- 작성자/시점: {search['author']} / {search['created']}",
                f"- 본문·이미지: {post['textLength']}자 / {post['imageCount']}개",
                f"- 제목 장치: {', '.join(post['titleTypes']) or '-'}",
                f"- 도입 장치: {', '.join(post['hookTypes']) or '-'}",
                f"- 주요 구조 신호: {', '.join(key for key, enabled in post['signals'].items() if enabled) or '-'}",
                f"- URL: {search['href']}",
                "",
            ]
        )
    lines.extend(
        [
            "## 집필 전에 채울 것",
            "",
            "- 검색 의도 한 문장",
            "- 독자가 겪는 구체적 상황",
            "- 직접 확인 가능한 증거 또는 명시적 자료 출처",
            "- 장점뿐 아니라 구매를 말려야 할 조건",
            "- 비교 기준 3~5개",
            "- 추천 대상 / 비추천 대상",
            "- 광고·제휴 고지",
            "- CTA 전에 독자의 결정을 끝내주는 요약",
            "",
        ]
    )
    md_path.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"completed": True, "json": str(json_path), "markdown": str(md_path), **summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
