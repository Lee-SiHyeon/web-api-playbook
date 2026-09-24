from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib import font_manager


def font_name() -> str | None:
    preferred = ["Malgun Gothic", "맑은 고딕", "NanumGothic", "Noto Sans CJK KR"]
    available = {font.name for font in font_manager.fontManager.ttflist}
    return next((name for name in preferred if name in available), None)


def short_title(title: str, limit: int = 25) -> str:
    value = " ".join(str(title).rstrip(", ").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()

    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    products = data["comparisonProducts"][:6]
    labels = [short_title(product["title"]) for product in products]
    prices = [product.get("salePriceKrw") or 0 for product in products]

    selected_font = font_name()
    if selected_font:
        plt.rcParams["font.family"] = selected_font
    plt.rcParams["axes.unicode_minus"] = False

    figure, axis = plt.subplots(figsize=(12, 6.75))
    bars = axis.barh(labels[::-1], prices[::-1])
    axis.set_title("도킹형 보조배터리 현재 가격 비교")
    axis.set_xlabel("가격(원) — 2026-09-19 쿠팡 파트너스 검색 기준")
    axis.grid(axis="x", alpha=0.25)
    maximum = max(prices) if prices else 1
    axis.set_xlim(0, maximum * 1.22)
    for bar, price in zip(bars, prices[::-1]):
        axis.text(bar.get_width() + maximum * 0.015, bar.get_y() + bar.get_height() / 2,
                  f"{price:,}원", va="center", fontsize=10)
    figure.text(0.01, 0.01, "가격·옵션·재고는 변동될 수 있습니다. 상품명상의 용량·출력 표기는 실측값이 아닙니다.", fontsize=9)
    figure.tight_layout(rect=(0, 0.04, 1, 1))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output, dpi=160, bbox_inches="tight")
    plt.close(figure)
    print(json.dumps({"completed": True, "output": str(output), "products": len(products)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
