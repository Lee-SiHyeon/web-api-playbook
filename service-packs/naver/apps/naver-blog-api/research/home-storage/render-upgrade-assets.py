from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
BASE_PATH = HERE / "render-assets.py"
SPEC = importlib.util.spec_from_file_location("home_storage_base_assets", BASE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("render_assets_import_failed")
base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)


def save_gap_formula(data: dict, out: Path) -> None:
    image, draw, y = base.canvas("실측 공식", "12cm 표기보다 설치 여유가 먼저입니다")
    y = max(y + 35, 340)
    items = [
        ("빈 공간 실측", "앞·중간·뒤 중 가장 좁은 폭"),
        ("돌출부 확인", "걸레받이·배관·손잡이·몰딩"),
        ("이동 여유", "앞으로 꺼낼 동선과 문턱"),
    ]
    box_w = 265
    gap = 35
    start_x = 85
    for index, (title, body) in enumerate(items):
        x = start_x + index * (box_w + gap)
        draw.rounded_rectangle((x, y, x + box_w, y + 430), radius=28, fill="#FAF7F1", outline=base.LINE, width=2)
        draw.ellipse((x + 82, y + 35, x + 182, y + 135), fill=base.ACCENT if index == 0 else base.GREEN)
        draw.text((x + 116, y + 57), str(index + 1), font=base.font(40, True), fill=base.PAPER)
        draw.text((x + 28, y + 175), title, font=base.font(28, True), fill=base.INK)
        base.draw_wrapped(draw, (x + 28, y + 235), body, base.font(24), base.MUTED, box_w - 56, line_gap=8, max_lines=4)
    draw.rounded_rectangle((95, y + 500, base.WIDTH - 95, y + 730), radius=28, fill="#EFE4D4", outline=base.ACCENT, width=3)
    base.draw_wrapped(
        draw,
        (135, y + 545),
        "제품 표시 폭만 보고 주문하지 말고, 실제 진입 폭과 이동 여유까지 한 번에 확인하세요.",
        base.font(31, True),
        base.INK,
        base.WIDTH - 270,
        line_gap=12,
        max_lines=4,
    )
    base.footer(draw)
    image.save(out)


def save_load_balance(data: dict, out: Path) -> None:
    image, draw, y = base.canvas("적재 기준", "가벼운 생활용품과 무거운 병은 다르게 봐야 합니다")
    y = max(y + 25, 340)
    columns = [
        (95, "잘 맞는 수납", ["키친타월·랩·봉투", "세탁망·집게", "여분 휴지·수건", "가벼운 리필 용품"], base.GREEN),
        (560, "다른 제품도 비교", ["생수·대용량 세제", "유리병·통조림 다량", "상단 집중 적재", "공식 하중이 꼭 필요한 용도"], base.WARN),
    ]
    for x, title, items, color in columns:
        draw.rounded_rectangle((x, y, x + 425, y + 705), radius=30, fill="#FAF7F1", outline=base.LINE, width=2)
        draw.text((x + 35, y + 40), title, font=base.font(34, True), fill=color)
        yy = y + 135
        for item in items:
            draw.ellipse((x + 38, yy + 13, x + 60, yy + 35), fill=color)
            yy = base.draw_wrapped(draw, (x + 82, yy), item, base.font(27), base.INK, 300, line_gap=7, max_lines=3) + 35
    draw.text((100, y + 760), "판매 화면에서 공식 최대 하중은 확인하지 못했습니다.", font=base.font(25, True), fill=base.WARN)
    base.footer(draw)
    image.save(out)


def save_room_map(data: dict, out: Path) -> None:
    image, draw, y = base.canvas("공간별 배치", "주방·욕실·세탁실에서 역할이 달라집니다")
    y = max(y + 25, 335)
    for index, item in enumerate(data["useCases"]):
        top = y + index * 275
        draw.rounded_rectangle((90, top, base.WIDTH - 90, top + 245), radius=26, fill="#FAF7F1", outline=base.LINE, width=2)
        draw.rounded_rectangle((120, top + 35, 280, top + 105), radius=22, fill=base.ACCENT if index == 0 else base.GREEN)
        draw.text((165, top + 50), item["place"], font=base.font(30, True), fill=base.PAPER)
        draw.text((330, top + 30), "추천", font=base.font(25, True), fill=base.GREEN)
        draw.text((330, top + 75), " · ".join(item["good"]), font=base.font(24), fill=base.INK)
        draw.text((330, top + 135), "주의", font=base.font(25, True), fill=base.WARN)
        base.draw_wrapped(draw, (330, top + 178), " · ".join(item["avoid"]), base.font(23), base.MUTED, 620, line_gap=6, max_lines=2)
    base.footer(draw)
    image.save(out)


def save_value_balance(data: dict, out: Path) -> None:
    product = data["selectedProduct"]
    image, draw, y = base.canvas("가격과 조건", "싸다는 말보다 어떤 조건에서 값어치가 있는지 봅니다")
    y = max(y + 25, 340)
    facts = [
        ("폭", "12cm", "비교 후보 중 가장 좁은 옵션"),
        ("단수", "3단", "4단보다 수납량은 적음"),
        ("확인가", product["priceLabel"], "와우 조건과 일반가를 구분"),
        ("상품평", f"{product['reviewCount']}개", "후기 수는 품질 보증이 아님"),
    ]
    for index, (label, value, note) in enumerate(facts):
        top = y + index * 205
        draw.rounded_rectangle((90, top, base.WIDTH - 90, top + 175), radius=24, fill="#FAF7F1", outline=base.LINE, width=2)
        draw.text((125, top + 40), label, font=base.font(28, True), fill=base.ACCENT)
        base.draw_wrapped(draw, (300, top + 27), value, base.font(32, True), base.INK, 380, line_gap=8, max_lines=2)
        base.draw_wrapped(draw, (700, top + 35), note, base.font(22), base.MUTED, 270, line_gap=7, max_lines=3)
    base.footer(draw)
    image.save(out)


def save_final_check(data: dict, out: Path) -> None:
    image, draw, y = base.canvas("구매 전 5초 점검", "아래 다섯 항목이 맞을 때 VELMENT가 후보입니다")
    y = max(y + 20, 320)
    checks = [
        "가장 좁은 실측 폭이 12cm보다 여유 있다",
        "걸레받이·배관·손잡이 간섭이 없다",
        "가벼운 생활용품 중심으로 수납한다",
        "3단 오픈형 수납이 목적에 맞다",
        "현재 옵션·가격·배송 조건을 다시 확인했다",
    ]
    for index, text in enumerate(checks):
        top = y + index * 150
        draw.rounded_rectangle((100, top, base.WIDTH - 100, top + 120), radius=24, fill="#FAF7F1", outline=base.LINE, width=2)
        draw.rounded_rectangle((130, top + 28, 190, top + 88), radius=16, fill=base.GREEN)
        number = str(index + 1)
        bbox = draw.textbbox((0, 0), number, font=base.font(31, True))
        draw.text((160 - (bbox[2] - bbox[0]) / 2, top + 39), number, font=base.font(31, True), fill=base.PAPER)
        base.draw_wrapped(draw, (225, top + 29), text, base.font(28, True), base.INK, 700, line_gap=8, max_lines=2)
    draw.rounded_rectangle((120, y + 790, base.WIDTH - 120, y + 930), radius=28, fill="#EFE4D4", outline=base.ACCENT, width=3)
    base.draw_wrapped(draw, (165, y + 823), "조건이 맞으면 아래 상품 카드에서 현재 옵션과 가격을 확인하세요.", base.font(29, True), base.INK, base.WIDTH - 330, line_gap=9, max_lines=3)
    base.footer(draw)
    image.save(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output_dir")
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    outputs = {
        "gapFormula": out / "09-gap-fit-formula.png",
        "loadBalance": out / "10-load-balance.png",
        "roomMap": out / "11-room-map.png",
        "valueBalance": out / "12-value-balance.png",
        "finalCheck": out / "13-final-check.png",
    }
    save_gap_formula(data, outputs["gapFormula"])
    save_load_balance(data, outputs["loadBalance"])
    save_room_map(data, outputs["roomMap"])
    save_value_balance(data, outputs["valueBalance"])
    save_final_check(data, outputs["finalCheck"])
    print(json.dumps({"completed": True, "outputs": {key: str(value) for key, value in outputs.items()}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
