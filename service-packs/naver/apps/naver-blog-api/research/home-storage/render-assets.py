from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1080
HEIGHT = 1350
BG = "#F6F1E7"
PAPER = "#FFFDF8"
INK = "#24302A"
MUTED = "#667069"
ACCENT = "#B27B52"
GREEN = "#71806D"
LINE = "#D9CFBF"
WARN = "#9A5B4B"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "malgunbd.ttf" if bold else "malgun.ttf"
    return ImageFont.truetype(str(Path("C:/Windows/Fonts") / name), size=size)


def lines_for(draw: ImageDraw.ImageDraw, text: str, fnt: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    words = str(text).split()
    if not words:
        return [""]
    output: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if draw.textbbox((0, 0), candidate, font=fnt)[2] <= max_width:
            current = candidate
        else:
            output.append(current)
            current = word
    output.append(current)
    return output


def draw_wrapped(draw, xy, text, fnt, fill, max_width, line_gap=12, max_lines=None):
    x, y = xy
    lines = lines_for(draw, text, fnt, max_width)
    if max_lines:
        lines = lines[:max_lines]
    line_height = draw.textbbox((0, 0), "가A", font=fnt)[3]
    for line in lines:
        draw.text((x, y), line, font=fnt, fill=fill)
        y += line_height + line_gap
    return y


def canvas(kicker: str, title: str, subtitle: str | None = None):
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((55, 50, WIDTH - 55, HEIGHT - 50), radius=34, fill=PAPER, outline=LINE, width=3)
    draw.text((90, 90), kicker, font=font(28, True), fill=ACCENT)
    y = draw_wrapped(draw, (90, 145), title, font(58, True), INK, WIDTH - 180, line_gap=18)
    if subtitle:
        y = draw_wrapped(draw, (90, y + 25), subtitle, font(30), MUTED, WIDTH - 180, line_gap=12)
    return image, draw, y


def footer(draw, text="판매 화면·공개 검색 자료 기준 · 직접 사용 후기 아님"):
    draw.line((90, HEIGHT - 125, WIDTH - 90, HEIGHT - 125), fill=LINE, width=2)
    draw.text((90, HEIGHT - 98), text, font=font(22), fill=MUTED)


def draw_trolley(draw, x: int, y: int, width: int = 250, height: int = 500):
    pole = 16
    tray_h = 90
    draw.rounded_rectangle((x, y, x + width, y + height), radius=26, outline=GREEN, width=10)
    for level in range(3):
        top = y + 55 + level * 145
        draw.rounded_rectangle((x + 25, top, x + width - 25, top + tray_h), radius=18, fill="#E9E2D4", outline=ACCENT, width=4)
        draw.line((x + 45, top + 28, x + width - 45, top + 28), fill="#C6B69F", width=4)
    draw.ellipse((x + 25, y + height - 8, x + 75, y + height + 42), fill=INK)
    draw.ellipse((x + width - 75, y + height - 8, x + width - 25, y + height + 42), fill=INK)


def save_cover(data: dict, out: Path):
    product = data["selectedProduct"]
    image, draw, y = canvas(
        "12CM 틈새 수납",
        data["title"],
        "냉장고·세탁기·세면대 옆 자투리 공간을 쓰기 전, 폭부터 확인하세요.",
    )
    draw_trolley(draw, 700, 520, 230, 520)
    facts = [
        f"옵션  {product['variant']}",
        f"색상  {product['color']}",
        f"현재가  {product['priceLabel']}",
        f"상품평  {product['reviewCount']}개",
    ]
    box_y = max(y + 45, 500)
    draw.rounded_rectangle((90, box_y, 630, box_y + 420), radius=28, fill="#F2EADB", outline=LINE, width=2)
    draw.text((125, box_y + 35), "판매 화면에서 확인한 핵심", font=font(32, True), fill=INK)
    fy = box_y + 100
    for item in facts:
        draw.ellipse((125, fy + 10, 143, fy + 28), fill=ACCENT)
        draw.text((165, fy), item, font=font(30), fill=INK)
        fy += 70
    draw.rounded_rectangle((680, 1080, 950, 1145), radius=22, fill=GREEN)
    draw.text((735, 1095), "비교 가이드", font=font(28, True), fill=PAPER)
    footer(draw)
    image.save(out)


def save_measurement(data: dict, out: Path):
    image, draw, y = canvas("구매 전 체크", "12cm라고 적혀 있어도 네 군데를 재세요")
    cards = data["measurementChecklist"]
    y = max(y + 35, 330)
    for index, item in enumerate(cards, 1):
        h = 180
        draw.rounded_rectangle((90, y, WIDTH - 90, y + h), radius=26, fill="#F7F2E8", outline=LINE, width=2)
        draw.ellipse((115, y + 45, 195, y + 125), fill=ACCENT)
        n = str(index)
        nb = draw.textbbox((0, 0), n, font=font(36, True))
        draw.text((155 - (nb[2] - nb[0]) / 2, y + 62), n, font=font(36, True), fill=PAPER)
        draw.text((230, y + 30), item["title"], font=font(34, True), fill=INK)
        draw_wrapped(draw, (230, y + 85), item["body"], font(27), MUTED, 690, line_gap=9, max_lines=3)
        y += h + 22
    footer(draw)
    image.save(out)


def save_comparison(data: dict, out: Path):
    image, draw, y = canvas("현재 판매 화면 비교", "12·13·15cm 틈새 트롤리 5개")
    rows = data["comparisonProducts"]
    y = max(y + 35, 320)
    headers = [(100, "폭·단수"), (330, "상품"), (770, "현재가")]
    for x, label in headers:
        draw.text((x, y), label, font=font(26, True), fill=MUTED)
    y += 50
    for row in rows:
        selected = row.get("selected", False)
        fill = "#EFE4D4" if selected else "#FAF7F1"
        draw.rounded_rectangle((85, y, WIDTH - 85, y + 140), radius=22, fill=fill, outline=ACCENT if selected else LINE, width=3 if selected else 2)
        draw_wrapped(draw, (110, y + 25), row["spec"], font(26, True), ACCENT if selected else INK, 185, line_gap=5, max_lines=2)
        draw_wrapped(draw, (325, y + 20), row["name"], font(24, selected), INK, 390, line_gap=6, max_lines=3)
        draw.text((775, y + 30), row["price"], font=font(29, True), fill=INK)
        draw.text((775, y + 78), f"리뷰 {row['reviews']}개", font=font(21), fill=MUTED)
        if selected:
            draw.rounded_rectangle((110, y + 92, 245, y + 126), radius=13, fill=GREEN)
            draw.text((132, y + 97), "선택 제품", font=font(19, True), fill=PAPER)
        y += 153
    draw_wrapped(draw, (100, y + 3), "가격·옵션·리뷰 수는 확인 시점의 판매 화면 기준이며 변동될 수 있습니다.", font(20), WARN, WIDTH - 200, line_gap=5, max_lines=2)
    footer(draw)
    image.save(out)


def save_strengths(data: dict, out: Path):
    image, draw, y = canvas("왜 매력적인가", "VELMENT 12cm 3단의 정확한 포지션")
    y = max(y + 20, 310)
    sections = [
        ("잘 맞는 이유", data["strengths"], GREEN),
        ("다른 제품이 더 나은 조건", data["tradeoffs"], WARN),
    ]
    for title, items, color in sections:
        draw.text((100, y), title, font=font(30, True), fill=color)
        y += 48
        for item in items:
            draw.rounded_rectangle((100, y, WIDTH - 100, y + 82), radius=20, fill="#FAF7F1", outline=LINE, width=2)
            draw.ellipse((125, y + 31, 143, y + 49), fill=color)
            draw_wrapped(draw, (165, y + 17), item, font(23), INK, WIDTH - 285, line_gap=5, max_lines=2)
            y += 93
        y += 10
    footer(draw)
    image.save(out)


def save_use_cases(data: dict, out: Path):
    image, draw, y = canvas("공간별 사용", "무엇을 넣고, 무엇은 피해야 할까")
    y = max(y + 30, 325)
    cols = [110, 395, 680]
    for x, item in zip(cols, data["useCases"]):
        draw.rounded_rectangle((x, y, x + 245, y + 720), radius=28, fill="#FAF7F1", outline=LINE, width=2)
        draw.text((x + 28, y + 35), item["place"], font=font(34, True), fill=ACCENT)
        draw.text((x + 28, y + 105), "추천 수납", font=font(24, True), fill=GREEN)
        yy = y + 150
        for value in item["good"]:
            draw.ellipse((x + 30, yy + 9, x + 44, yy + 23), fill=GREEN)
            yy = draw_wrapped(draw, (x + 58, yy), value, font(23), INK, 160, line_gap=6, max_lines=3) + 15
        draw.line((x + 25, y + 445, x + 220, y + 445), fill=LINE, width=2)
        draw.text((x + 28, y + 475), "주의", font=font(24, True), fill=WARN)
        yy = y + 520
        for value in item["avoid"]:
            draw.ellipse((x + 30, yy + 9, x + 44, yy + 23), fill=WARN)
            yy = draw_wrapped(draw, (x + 58, yy), value, font(23), INK, 160, line_gap=6, max_lines=3) + 15
    footer(draw)
    image.save(out)


def save_decision(data: dict, out: Path):
    image, draw, y = canvas("선택 트리", "이 제품이 맞는 집은 따로 있습니다")
    y = max(y + 20, 310)
    for item in data["decisionTree"]:
        color = GREEN if item["result"] == "후보" else ACCENT if item["result"] == "비교" else WARN
        draw.rounded_rectangle((95, y, WIDTH - 95, y + 145), radius=25, fill="#FAF7F1", outline=LINE, width=2)
        draw_wrapped(draw, (125, y + 22), item["question"], font(26, True), INK, 600, line_gap=5, max_lines=2)
        draw.rounded_rectangle((760, y + 35, 925, y + 101), radius=22, fill=color)
        label = item["result"]
        lb = draw.textbbox((0, 0), label, font=font(27, True))
        draw.text((842 - (lb[2] - lb[0]) / 2, y + 51), label, font=font(27, True), fill=PAPER)
        draw_wrapped(draw, (125, y + 96), item["detail"], font(21), MUTED, 585, line_gap=5, max_lines=2)
        y += 162
    draw.rounded_rectangle((95, y + 3, WIDTH - 95, y + 175), radius=26, fill="#EFE4D4", outline=ACCENT, width=3)
    draw_wrapped(draw, (130, y + 27), data["conclusion"], font(25, True), INK, WIDTH - 260, line_gap=7, max_lines=4)
    footer(draw)
    image.save(out)


def save_questions(data: dict, out: Path):
    image, draw, y = canvas("커뮤니티 질문", "구매 전에 실제로 많이 막히는 지점")
    y = max(y + 25, 325)
    questions = [
        ("치수", "표기 폭만 재면 될까? 걸레받이와 배관은?"),
        ("하중", "세제·통조림을 올려도 선반이 휘지 않을까?"),
        ("바퀴", "타일 줄눈과 문턱에서 잘 움직이고 빠지지 않을까?"),
        ("청소", "욕실 물때와 좁은 칸의 먼지를 닦기 쉬울까?"),
        ("조립", "결합부가 빡빡하거나 파손되는 문제는 없을까?"),
    ]
    for index, (label, question) in enumerate(questions, 1):
        draw.rounded_rectangle((95, y, WIDTH - 95, y + 145), radius=24, fill="#FAF7F1", outline=LINE, width=2)
        draw.rounded_rectangle((120, y + 33, 260, y + 105), radius=20, fill=ACCENT if index <= 2 else GREEN)
        draw.text((155, y + 51), label, font=font(27, True), fill=PAPER)
        draw_wrapped(draw, (300, y + 33), question, font(28, True), INK, 620, line_gap=7, max_lines=2)
        y += 162
    draw_wrapped(draw, (105, y + 10), "공개 카페 검색 23개 문서의 질문 신호입니다. 제품 결함률이나 전체 구매자의 합의를 의미하지 않습니다.", font(22), WARN, WIDTH - 210, line_gap=6, max_lines=3)
    footer(draw)
    image.save(out)


def save_evidence(data: dict, out: Path):
    image, draw, y = canvas("정보 범위", "확인한 것과 아직 모르는 것을 나눴습니다")
    y = max(y + 25, 330)
    sections = [
        ("판매 화면에서 확인", ["12cm·3단·아이보리 옵션", "와우 12,380원 / 일반 14,900원", "바퀴 있음·상판 플라스틱 표기", "상품평 259개"], GREEN),
        ("확인하지 못함", ["공식 최대 하중", "제품 전체 높이·깊이 실측", "장기 사용 내구성", "욕실 사용 시 배수·물때 성능"], WARN),
    ]
    for title, items, color in sections:
        draw.rounded_rectangle((95, y, WIDTH - 95, y + 370), radius=28, fill="#FAF7F1", outline=LINE, width=2)
        draw.text((130, y + 35), title, font=font(34, True), fill=color)
        yy = y + 105
        for item in items:
            draw.ellipse((135, yy + 10, 153, yy + 28), fill=color)
            draw.text((180, yy), item, font=font(27), fill=INK)
            yy += 62
        y += 400
    draw_wrapped(draw, (105, y + 5), "모르는 항목은 후기처럼 채우지 않고 구매 전 확인 사항으로 남깁니다.", font(24, True), INK, WIDTH - 210, line_gap=7, max_lines=2)
    footer(draw)
    image.save(out)



def save_clearance(data: dict, out: Path):
    image, draw, y = canvas(
        "설치 여유",
        "표기 12cm와 실제 12cm는 다릅니다",
        "걸레받이·배관·손잡이까지 포함한 가장 좁은 지점을 기준으로 보세요.",
    )
    y = max(y + 12, 320)
    cards = [
        ("정확히 12cm", "위험", "제품 돌출부와 바퀴 이동 여유가 없어 들어가지 않을 수 있습니다.", WARN),
        ("13~14cm", "확인", "걸레받이와 배관이 없다면 후보가 되지만 실제 진입 폭을 다시 재세요.", ACCENT),
        ("15cm 이상", "여유", "12cm 옵션을 넣고 당겨 쓰기 위한 공간을 확보하기 쉽습니다.", GREEN),
    ]
    for label, result, body, color in cards:
        draw.rounded_rectangle((95, y, WIDTH - 95, y + 165), radius=26, fill="#FAF7F1", outline=color, width=3)
        draw.text((125, y + 28), label, font=font(35, True), fill=INK)
        draw.rounded_rectangle((710, y + 24, 925, y + 91), radius=22, fill=color)
        result_box = draw.textbbox((0, 0), result, font=font(27, True))
        draw.text((818 - (result_box[2] - result_box[0]) / 2, y + 39), result, font=font(27, True), fill=PAPER)
        draw_wrapped(draw, (125, y + 90), body, font(22), MUTED, 790, line_gap=4, max_lines=2)
        y += 184
    draw.rounded_rectangle((95, y + 5, WIDTH - 95, y + 135), radius=24, fill="#F2EADB", outline=LINE, width=2)
    draw_wrapped(
        draw,
        (125, y + 27),
        "상품 폭은 판매 화면의 옵션명 기준입니다. 실제 외형 전체 치수는 구매 전에 다시 확인하세요.",
        font(22, True),
        WARN,
        WIDTH - 250,
        line_gap=5,
        max_lines=2,
    )
    footer(draw)
    image.save(out)


def save_load_guide(data: dict, out: Path):
    image, draw, y = canvas(
        "적재 가이드",
        "무거운 물건은 아래, 가벼운 물건은 위",
        "공식 최대 하중을 확인하지 못했으므로 보수적으로 배치하는 기준입니다.",
    )
    y = max(y + 15, 340)
    draw_trolley(draw, 110, y + 30, 300, 540)
    labels = [
        ("위칸", "휴지·수건·봉투", GREEN, y + 82),
        ("중간칸", "양념·세면용품", ACCENT, y + 215),
        ("아래칸", "리필 세제·무거운 병", WARN, y + 348),
    ]
    for title, body, color, yy in labels:
        draw.line((430, yy + 40, 535, yy + 40), fill=color, width=5)
        draw.rounded_rectangle((535, yy, 950, yy + 100), radius=24, fill="#FAF7F1", outline=color, width=3)
        draw.text((565, yy + 16), title, font=font(27, True), fill=color)
        draw.text((565, yy + 57), body, font=font(24), fill=INK)
    note_y = y + 620
    draw.rounded_rectangle((100, note_y, WIDTH - 100, note_y + 128), radius=26, fill="#F2EADB", outline=LINE, width=2)
    draw_wrapped(
        draw,
        (135, note_y + 27),
        "생수 박스나 유리병이 중심이라면, 최대 하중이 명시된 철제 수납장도 함께 비교하세요.",
        font(22, True),
        INK,
        WIDTH - 270,
        line_gap=5,
        max_lines=2,
    )
    footer(draw)
    image.save(out)


def save_cleaning(data: dict, out: Path):
    image, draw, y = canvas("관리 동선", "좁은 틈새 수납은 청소까지 생각해야 합니다")
    y = max(y + 12, 315)
    steps = [
        ("01", "주 1회 꺼내기", "바퀴를 이용해 앞으로 당기고 바닥 먼지와 머리카락을 정리합니다."),
        ("02", "선반 닦기", "주방 기름때·욕실 물때는 오래 두지 말고 마른 천으로 마무리합니다."),
        ("03", "완전 건조", "젖은 수건과 세제를 오래 밀폐하지 말고 통풍 뒤 다시 넣습니다."),
        ("04", "바퀴 확인", "타일 줄눈과 문턱에서 이물질이 끼거나 바퀴가 빠지지 않는지 봅니다."),
    ]
    for num, title, body in steps:
        draw.rounded_rectangle((95, y, WIDTH - 95, y + 180), radius=28, fill="#FAF7F1", outline=LINE, width=2)
        draw.rounded_rectangle((120, y + 42, 245, y + 135), radius=28, fill=GREEN)
        draw.text((153, y + 62), num, font=font(31, True), fill=PAPER)
        draw.text((285, y + 28), title, font=font(32, True), fill=INK)
        draw_wrapped(draw, (285, y + 82), body, font(24), MUTED, 650, line_gap=6, max_lines=3)
        y += 202
    footer(draw)
    image.save(out)


def save_fit_matrix(data: dict, out: Path):
    image, draw, y = canvas("공간 적합도", "주방·욕실·세탁실, 같은 제품도 조건이 다릅니다")
    y = max(y + 10, 340)
    rows = [
        ("주방", "양념·랩·키친타월", "열원·기름때", GREEN),
        ("욕실", "휴지·수건·세면용품", "직접 물 닿는 자리", ACCENT),
        ("세탁실", "세탁망·집게·리필 세제", "문턱·대용량 세제", WARN),
    ]
    draw.text((110, y), "공간", font=font(25, True), fill=MUTED)
    draw.text((335, y), "잘 맞는 수납", font=font(25, True), fill=MUTED)
    draw.text((720, y), "주의", font=font(25, True), fill=MUTED)
    y += 55
    for place, good, avoid, color in rows:
        draw.rounded_rectangle((90, y, WIDTH - 90, y + 170), radius=26, fill="#FAF7F1", outline=LINE, width=2)
        draw.rounded_rectangle((115, y + 30, 285, y + 140), radius=26, fill=color)
        draw.text((155, y + 63), place, font=font(30, True), fill=PAPER)
        draw_wrapped(draw, (335, y + 32), good, font(25, True), INK, 330, line_gap=6, max_lines=3)
        draw_wrapped(draw, (720, y + 32), avoid, font(23), WARN, 240, line_gap=6, max_lines=3)
        y += 187
    note_y = HEIGHT - 300
    draw.rounded_rectangle((95, note_y, WIDTH - 95, note_y + 150), radius=26, fill="#EFE4D4", outline=ACCENT, width=3)
    draw_wrapped(
        draw,
        (130, note_y + 28),
        "가벼운 소모품을 자주 꺼내는 용도에는 잘 맞지만, 무거운 물건·완전 방수·먼지 차단이 우선이면 다른 구조를 비교하세요.",
        font(23, True),
        INK,
        WIDTH - 260,
        line_gap=7,
        max_lines=4,
    )
    footer(draw)
    image.save(out)


def save_final_checklist(data: dict, out: Path):
    image, draw, y = canvas("주문 직전 체크", "이 다섯 가지를 통과하면 후보입니다")
    y = max(y + 25, 330)
    items = [
        "가장 좁은 폭이 제품 전체 외형보다 넓다",
        "걸레받이·배관·콘센트가 진입을 막지 않는다",
        "당길 때 문·매트·문턱과 부딪히지 않는다",
        "무거운 물건보다 가벼운 생활용품이 중심이다",
        "현재 가격·옵션·배송 조건을 다시 확인했다",
    ]
    for index, item in enumerate(items, 1):
        draw.rounded_rectangle((95, y, WIDTH - 95, y + 108), radius=24, fill="#FAF7F1", outline=GREEN if index < 5 else ACCENT, width=3)
        draw.ellipse((125, y + 20, 193, y + 88), fill=GREEN if index < 5 else ACCENT)
        draw.text((148, y + 34), str(index), font=font(28, True), fill=PAPER)
        draw_wrapped(draw, (230, y + 23), item, font(25, True), INK, 705, line_gap=5, max_lines=2)
        y += 124
    draw.rounded_rectangle((95, y + 5, WIDTH - 95, y + 125), radius=24, fill="#F2EADB", outline=LINE, width=2)
    draw_wrapped(
        draw,
        (130, y + 27),
        "하나라도 애매하면 먼저 실측하거나, 더 좁은 제품·하중이 명시된 제품·서랍형 제품을 비교하세요.",
        font(22, True),
        INK,
        WIDTH - 260,
        line_gap=5,
        max_lines=2,
    )
    footer(draw)
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
        "cover": out / "01-cover.png",
        "measurement": out / "02-measurement-checklist.png",
        "comparison": out / "03-width-price-comparison.png",
        "strengths": out / "04-positioning.png",
        "useCases": out / "05-use-cases.png",
        "decision": out / "06-decision-tree.png",
        "questions": out / "07-community-questions.png",
        "evidence": out / "08-evidence-boundary.png",
        "clearance": out / "09-clearance-guide.png",
        "loadGuide": out / "10-load-placement.png",
        "cleaning": out / "11-cleaning-flow.png",
        "fitMatrix": out / "12-room-fit-matrix.png",
        "finalChecklist": out / "13-final-checklist.png",
    }
    save_cover(data, outputs["cover"])
    save_measurement(data, outputs["measurement"])
    save_comparison(data, outputs["comparison"])
    save_strengths(data, outputs["strengths"])
    save_use_cases(data, outputs["useCases"])
    save_decision(data, outputs["decision"])
    save_questions(data, outputs["questions"])
    save_evidence(data, outputs["evidence"])
    save_clearance(data, outputs["clearance"])
    save_load_guide(data, outputs["loadGuide"])
    save_cleaning(data, outputs["cleaning"])
    save_fit_matrix(data, outputs["fitMatrix"])
    save_final_checklist(data, outputs["finalChecklist"])
    print(json.dumps({"completed": True, "outputs": {key: str(value) for key, value in outputs.items()}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
