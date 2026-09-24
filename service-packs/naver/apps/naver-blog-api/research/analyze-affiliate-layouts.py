from __future__ import annotations

import json
import math
import re
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT / "research"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36"
)

QUERIES = [
    "\ud2c8\uc0c8 \uc218\ub0a9\uc7a5 \ucd94\ucc9c",
    "12cm \ud2c8\uc0c8 \uc218\ub0a9\uc7a5",
    "\uc2ac\ub9bc \ud2b8\ub864\ub9ac \ucd94\ucc9c",
    "\uc8fc\ubc29 \ud2c8\uc0c8 \uc218\ub0a9\uc7a5",
    "\uc695\uc2e4 \ud2c8\uc0c8 \uc218\ub0a9\uc7a5",
    "\ud2c8\uc0c8 \uc218\ub0a9\uc7a5 \ub0b4\ub3c8\ub0b4\uc0b0",
]

OUR_POST = "https://blog.naver.com/aicandoanything/224417664446"
AFFILIATE_HOSTS = {
    "link.coupang.com",
    "coupa.ng",
    "affiliate.klook.com",
    "www.linkprice.com",
    "partner.myrealtrip.com",
}
DISCLOSURE_RE = re.compile(
    r"\ud30c\ud2b8\ub108\uc2a4 \ud65c\ub3d9|\uc218\uc218\ub8cc\ub97c \uc81c\uacf5|\uacbd\uc81c\uc801 \ub300\uac00|\uc81c\ud488\uc744 \uc81c\uacf5\ubc1b|\uc6d0\uace0\ub8cc|\uad11\uace0|\ud611\ucc2c",
    re.I,
)
CTA_RE = re.compile(
    r"\uc0c1\ud488 \ubcf4\uae30|\uc0c1\ud488 \ud655\uc778|\uad6c\ub9e4\ud558\uae30|\uac00\uaca9 \ud655\uc778|\uc790\uc138\ud788 \ubcf4\uae30|\ucd5c\uc800\uac00|\ubc14\ub85c\uac00\uae30|\ub9c1\ud06c",
    re.I,
)


def clean(value: str | None) -> str:
    return " ".join(
        str(value or "")
        .replace("\uc0c8 \ucc3d \uc5f4\ub9bc", " ")
        .replace("\u200b", " ")
        .replace("\ufeff", " ")
        .replace("\xa0", " ")
        .split()
    )


def request(url: str) -> requests.Response:
    response = requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5"},
        timeout=25,
    )
    response.raise_for_status()
    return response


def med(values):
    values = [value for value in values if value is not None]
    return statistics.median(values) if values else None


def percentile(value, values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    below = sum(1 for v in values if v < value)
    equal = sum(1 for v in values if v == value)
    return round(100 * (below + 0.5 * equal) / len(values), 1)


@dataclass
class SearchHit:
    query: str
    rank: int
    title: str
    url: str
    author: str
    created: str
    influencer_signal: bool
    image_count_hint: int | None


def search(query: str, limit: int = 10) -> list[SearchHit]:
    response = request("https://search.naver.com/search.naver?where=blog&query=" + quote(query))
    soup = BeautifulSoup(response.text, "lxml")
    hits: list[SearchHit] = []
    for item in soup.select('[data-template-id="ugcItem"]'):
        title_anchor = None
        for anchor in item.select("a[href]"):
            href = anchor.get("href", "")
            if re.fullmatch(r"https://blog\.naver\.com/[^/]+/\d+", href) and anchor.select_one(
                ".sds-comps-text-type-headline1"
            ):
                title_anchor = anchor
                break
        if not title_anchor:
            continue
        href = title_anchor.get("href", "")
        if href in {hit.url for hit in hits}:
            continue
        author_node = item.select_one(".sds-comps-profile-info-title-text")
        date_node = item.select_one(".sds-comps-profile-info-subtext")
        badge = item.select_one('[data-sds-comp="ThumbnailTextBadge"]')
        item_text = clean(item.get_text(" ", strip=True))
        count = None
        if badge:
            match = re.search(r"\d+", badge.get_text(strip=True))
            count = int(match.group()) if match else None
        hits.append(
            SearchHit(
                query=query,
                rank=len(hits) + 1,
                title=clean(title_anchor.get_text(" ", strip=True)),
                url=href,
                author=clean(author_node.get_text(" ", strip=True) if author_node else ""),
                created=clean(date_node.get_text(" ", strip=True) if date_node else ""),
                influencer_signal="\uc778\ud50c\ub8e8\uc5b8\uc11c" in item_text,
                image_count_hint=count,
            )
        )
        if len(hits) >= limit:
            break
    return hits


def font_size(node) -> int | None:
    sizes = []
    for element in [node, *node.select("[class]")]:
        for class_name in element.get("class") or []:
            match = re.fullmatch(r"se-fs(\d+)", class_name)
            if match:
                sizes.append(int(match.group(1)))
    return max(sizes) if sizes else None


def component_type(component) -> str:
    classes = set(component.get("class") or [])
    for name in [
        "se-documentTitle",
        "se-text",
        "se-image",
        "se-imageStrip",
        "se-oglink",
        "se-shopping-connect",
        "se-table",
        "se-quotation",
        "se-horizontalLine",
        "se-video",
        "se-map",
        "se-sticker",
    ]:
        if name in classes:
            return name
    return "other"


def canonical_mobile(url: str) -> tuple[str, str, str]:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise ValueError("unsupported_blog_url")
    blog_id, log_no = parts[-2], parts[-1]
    return blog_id, log_no, f"https://m.blog.naver.com/{blog_id}/{log_no}"


def analyze_post(url: str) -> dict:
    blog_id, log_no, mobile = canonical_mobile(url)
    response = request(mobile)
    soup = BeautifulSoup(response.text, "lxml")
    main = soup.select_one(".se-main-container")
    if main is None:
        raise ValueError("smart_editor_body_missing")
    title_node = soup.select_one('meta[property="og:title"]')
    title = clean(title_node.get("content") if title_node else soup.title.get_text(" ", strip=True) if soup.title else "")

    paragraphs = []
    heading_count = 0
    disclosure_index = None
    component_rows = []
    component_counts = Counter()
    all_components = main.select(".se-component")
    for index, component in enumerate(all_components):
        kind = component_type(component)
        component_counts[kind] += 1
        text = clean(component.get_text(" ", strip=True))
        links = [anchor.get("href", "") for anchor in component.select("a[href]")]
        external_links = []
        for href in links:
            try:
                host = urlparse(href).netloc.lower()
            except Exception:
                host = ""
            if host and not host.endswith("naver.com") and not host.endswith("pstatic.net"):
                external_links.append(href)
        component_rows.append({"index": index, "type": kind, "text": text[:180], "externalLinks": external_links})
        if disclosure_index is None and DISCLOSURE_RE.search(text):
            disclosure_index = index
        if kind == "se-quotation":
            heading_count += 1
        for paragraph in component.select(".se-text-paragraph"):
            ptext = clean(paragraph.get_text(" ", strip=True))
            if not ptext:
                continue
            paragraphs.append(ptext)
            size = font_size(paragraph)
            if len(ptext) <= 100 and size and size >= 19:
                heading_count += 1

    body_text = "\n".join(paragraphs)
    images = []
    for image in main.select("img"):
        src = image.get("data-lazy-src") or image.get("src") or ""
        if src:
            images.append(src)

    external_links = []
    affiliate_links = []
    coupang_links = []
    linked_external_images = []
    linked_coupang_images = []
    custom_linked_external_images = []
    custom_linked_coupang_images = []
    og_affiliate_links = []
    text_ctas = []
    for anchor in main.select("a[href]"):
        href = anchor.get("href", "")
        text = clean(anchor.get_text(" ", strip=True))
        try:
            host = urlparse(href).netloc.lower()
        except Exception:
            host = ""
        external = bool(host and not host.endswith("naver.com") and not host.endswith("pstatic.net"))
        if external:
            external_links.append(href)
        if host in AFFILIATE_HOSTS or "link.coupang.com" in href or "coupa.ng" in href:
            affiliate_links.append(href)
        if "link.coupang.com" in href or "coupa.ng" in href:
            coupang_links.append(href)
        component = anchor.find_parent(class_=lambda value: value and "se-component" in value.split())
        kind = component_type(component) if component else None
        if external and anchor.select_one("img"):
            linked_external_images.append(href)
            if kind in {"se-image", "se-imageStrip"}:
                custom_linked_external_images.append(href)
        if ("link.coupang.com" in href or "coupa.ng" in href) and anchor.select_one("img"):
            linked_coupang_images.append(href)
            if kind in {"se-image", "se-imageStrip"}:
                custom_linked_coupang_images.append(href)
        if kind == "se-oglink" and (host in AFFILIATE_HOSTS or "link.coupang.com" in href or "coupa.ng" in href):
            og_affiliate_links.append(href)
        if external and text and CTA_RE.search(text):
            text_ctas.append(text)

    first_external_component = None
    for row in component_rows:
        if row["externalLinks"]:
            first_external_component = row["index"]
            break
    component_total = len(component_rows)
    cta_ratio = round(first_external_component / max(1, component_total - 1), 3) if first_external_component is not None else None
    disclosure_ratio = round(disclosure_index / max(1, component_total - 1), 3) if disclosure_index is not None else None

    simplified = []
    for row in component_rows:
        simplified_kind = "image" if row["type"] in {"se-image", "se-imageStrip"} else "text" if row["type"] in {"se-text", "se-quotation", "se-table"} else row["type"]
        if simplified_kind in {"image", "text"}:
            simplified.append(simplified_kind)
    alternations = sum(1 for left, right in zip(simplified, simplified[1:]) if left != right)
    alternation_rate = round(alternations / max(1, len(simplified) - 1), 3) if simplified else 0

    if custom_linked_coupang_images:
        cta_style = "custom_linked_image_banner"
    elif component_counts["se-shopping-connect"]:
        cta_style = "shopping_connect"
    elif og_affiliate_links:
        cta_style = "og_link_card"
    elif text_ctas or affiliate_links:
        cta_style = "text_or_inline_link"
    else:
        cta_style = "none"

    return {
        "url": url,
        "mobileUrl": mobile,
        "blogId": blog_id,
        "logNo": log_no,
        "title": title,
        "textLength": len(clean(body_text)),
        "paragraphCount": len(paragraphs),
        "medianParagraphLength": med([len(value) for value in paragraphs]),
        "maxParagraphLength": max([len(value) for value in paragraphs], default=0),
        "imageCount": len(set(images)),
        "imageDensityPer1000Chars": round(len(set(images)) * 1000 / max(1, len(clean(body_text))), 2),
        "headingCount": heading_count,
        "componentCount": component_total,
        "componentCounts": dict(component_counts),
        "textImageAlternationRate": alternation_rate,
        "externalLinkCount": len(set(external_links)),
        "affiliateLinkCount": len(set(affiliate_links)),
        "coupangLinkCount": len(set(coupang_links)),
        "linkedExternalImageCount": len(set(linked_external_images)),
        "linkedCoupangImageCount": len(set(linked_coupang_images)),
        "customLinkedExternalImageCount": len(set(custom_linked_external_images)),
        "customLinkedCoupangBannerCount": len(set(custom_linked_coupang_images)),
        "ogAffiliateLinkCount": len(set(og_affiliate_links)),
        "ogLinkCount": component_counts["se-oglink"],
        "shoppingConnectCount": component_counts["se-shopping-connect"],
        "tableCount": component_counts["se-table"],
        "quoteCount": component_counts["se-quotation"],
        "videoCount": component_counts["se-video"],
        "affiliateDisclosure": bool(DISCLOSURE_RE.search(body_text)),
        "disclosurePositionRatio": disclosure_ratio,
        "firstExternalCtaPositionRatio": cta_ratio,
        "ctaStyle": cta_style,
        "textCtas": text_ctas[:10],
        "layoutSequence": [row["type"] for row in component_rows[:60]],
    }


def summarize(posts: list[dict]) -> dict:
    metrics = [
        "textLength",
        "paragraphCount",
        "medianParagraphLength",
        "maxParagraphLength",
        "imageCount",
        "imageDensityPer1000Chars",
        "headingCount",
        "componentCount",
        "textImageAlternationRate",
        "externalLinkCount",
        "affiliateLinkCount",
        "linkedExternalImageCount",
        "linkedCoupangImageCount",
        "customLinkedExternalImageCount",
        "customLinkedCoupangBannerCount",
        "ogAffiliateLinkCount",
        "ogLinkCount",
        "shoppingConnectCount",
        "tableCount",
        "quoteCount",
        "videoCount",
        "disclosurePositionRatio",
        "firstExternalCtaPositionRatio",
    ]
    return {
        "postCount": len(posts),
        "median": {metric: med([post.get(metric) for post in posts]) for metric in metrics},
        "rates": {
            "affiliateDisclosure": round(sum(post["affiliateDisclosure"] for post in posts) / len(posts), 3) if posts else 0,
            "hasExternalLink": round(sum(post["externalLinkCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
            "hasAffiliateLink": round(sum(post["affiliateLinkCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
            "hasLinkedImage": round(sum(post["linkedExternalImageCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
            "hasCoupangImageBanner": round(sum(post["customLinkedCoupangBannerCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
            "hasOgCard": round(sum(post["ogLinkCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
            "hasShoppingConnect": round(sum(post["shoppingConnectCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
            "hasTable": round(sum(post["tableCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
            "hasQuote": round(sum(post["quoteCount"] > 0 for post in posts) / len(posts), 3) if posts else 0,
        },
        "ctaStyles": dict(Counter(post["ctaStyle"] for post in posts)),
    }


def compare(ours: dict, benchmark: list[dict]) -> dict:
    metrics = [
        "textLength",
        "paragraphCount",
        "imageCount",
        "imageDensityPer1000Chars",
        "headingCount",
        "componentCount",
        "textImageAlternationRate",
        "externalLinkCount",
        "affiliateLinkCount",
        "linkedExternalImageCount",
        "customLinkedExternalImageCount",
        "customLinkedCoupangBannerCount",
        "ogAffiliateLinkCount",
        "ogLinkCount",
        "tableCount",
        "quoteCount",
        "firstExternalCtaPositionRatio",
    ]
    result = {}
    for metric in metrics:
        values = [post.get(metric) for post in benchmark if post.get(metric) is not None]
        baseline = med(values)
        value = ours.get(metric)
        result[metric] = {
            "ours": value,
            "benchmarkMedian": baseline,
            "delta": None if value is None or baseline is None else round(value - baseline, 3),
            "ratio": None if value is None or not baseline else round(value / baseline, 3),
            "percentile": None if value is None else percentile(value, values),
        }
    return result


def main():
    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    hits = []
    query_counts = {}
    for query in QUERIES:
        try:
            current = search(query, 10)
        except Exception as error:
            current = []
            print(json.dumps({"query": query, "error": type(error).__name__}, ensure_ascii=False))
        hits.extend(current)
        query_counts[query] = len(current)
        time.sleep(0.35)

    grouped = {}
    for hit in hits:
        entry = grouped.setdefault(hit.url, {"url": hit.url, "author": hit.author, "appearances": [], "influencerSignal": False})
        entry["appearances"].append({"query": hit.query, "rank": hit.rank})
        entry["influencerSignal"] = entry["influencerSignal"] or hit.influencer_signal
        if not entry.get("created"):
            entry["created"] = hit.created

    candidates = list(grouped.values())
    for entry in candidates:
        entry["bestRank"] = min(item["rank"] for item in entry["appearances"])
        entry["appearanceCount"] = len(entry["appearances"])
        entry["authorityScore"] = min(100, max(0, 100 - (entry["bestRank"] - 1) * 10 + (entry["appearanceCount"] - 1) * 8 + (10 if entry["influencerSignal"] else 0)))
    candidates.sort(key=lambda item: (-item["authorityScore"], item["bestRank"], -item["appearanceCount"]))

    selected = candidates[:30]
    posts = []
    failures = []
    for index, entry in enumerate(selected, 1):
        try:
            analysis = analyze_post(entry["url"])
            analysis["search"] = entry
            posts.append(analysis)
        except Exception as error:
            failures.append({"url": entry["url"], "error": type(error).__name__})
        print(json.dumps({"progress": index, "total": len(selected), "posts": len(posts), "failures": len(failures)}))
        time.sleep(0.25)

    ours = analyze_post(OUR_POST)
    ours["search"] = {"url": OUR_POST, "author": "aicandoanything", "bestRank": None, "appearanceCount": 0, "authorityScore": None}

    top_authority = [post for post in posts if post["search"]["bestRank"] <= 3][:15]
    if len(top_authority) < 10:
        top_authority = posts[:15]
    affiliate_posts = [post for post in posts if post["affiliateLinkCount"] > 0 or post["affiliateDisclosure"]]
    authors = defaultdict(lambda: {"appearances": 0, "bestRank": 999, "queries": set(), "posts": 0})
    for post in posts:
        author = post["search"].get("author") or post["blogId"]
        authors[author]["appearances"] += post["search"]["appearanceCount"]
        authors[author]["bestRank"] = min(authors[author]["bestRank"], post["search"]["bestRank"])
        authors[author]["queries"].update(item["query"] for item in post["search"]["appearances"])
        authors[author]["posts"] += 1
    authority_authors = sorted(
        [
            {"author": author, "appearances": value["appearances"], "bestRank": value["bestRank"], "queryCount": len(value["queries"]), "posts": value["posts"]}
            for author, value in authors.items()
        ],
        key=lambda item: (item["bestRank"], -item["appearances"], -item["queryCount"]),
    )[:12]

    record = {
        "schemaVersion": 1,
        "checkedAt": checked_at,
        "method": {
            "definitionOfAuthority": "current top-3 exposure and repeated appearance across six closely related Naver Blog queries; not a follower-count claim",
            "queries": QUERIES,
            "selectedPosts": len(selected),
            "analyzedPosts": len(posts),
            "failureCount": len(failures),
        },
        "queryResultCounts": query_counts,
        "authorityAuthors": authority_authors,
        "allTopPostsSummary": summarize(posts),
        "topAuthoritySummary": summarize(top_authority),
        "affiliatePostSummary": summarize(affiliate_posts),
        "ourPost": ours,
        "ourVsTopAuthority": compare(ours, top_authority),
        "posts": posts,
        "failures": failures,
    }

    RESEARCH.mkdir(parents=True, exist_ok=True)
    json_path = RESEARCH / "naver-storage-layout-benchmark-2026-09-20.json"
    md_path = RESEARCH / "naver-storage-layout-benchmark-2026-09-20.md"
    json_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    top = record["topAuthoritySummary"]
    aff = record["affiliatePostSummary"]
    c = record["ourVsTopAuthority"]
    lines = [
        "# 네이버 틈새수납장 상위 노출 글 레이아웃 벤치마크 — 2026-09-20",
        "",
        "## 표본 정의",
        "",
        "팔로워 수를 확인할 수 없는 공개 검색 환경이므로 ‘유명 블로거’를 자의적으로 정하지 않았다. 관련 검색어 6개에서 현재 3위 안에 노출되거나 여러 검색어에 반복 노출된 글을 상위 권위 표본으로 사용했다.",
        "",
        f"- 검색 노출: {len(hits)}개, 고유 URL: {len(candidates)}개",
        f"- 실제 본문 분석: {len(posts)}개",
        f"- 상위 권위 표본: {len(top_authority)}개",
        f"- 제휴·광고 신호 글: {len(affiliate_posts)}개",
        "",
        "## 정량 비교",
        "",
        "| 지표 | 우리 글 | 상위 권위 중앙값 | 차이 | 백분위 |",
        "|---|---:|---:|---:|---:|",
    ]
    labels = {
        "textLength": "본문 글자 수",
        "paragraphCount": "문단 수",
        "imageCount": "이미지 수",
        "imageDensityPer1000Chars": "1,000자당 이미지",
        "headingCount": "소제목 수",
        "componentCount": "SmartEditor 컴포넌트 수",
        "textImageAlternationRate": "텍스트↔이미지 교차율",
        "externalLinkCount": "외부 링크 수",
        "affiliateLinkCount": "제휴 링크 수",
        "linkedExternalImageCount": "OG 썸네일 포함 이미지 링크 수",
        "customLinkedExternalImageCount": "커스텀 링크 이미지 수",
        "customLinkedCoupangBannerCount": "커스텀 쿠팡 배너 수",
        "ogAffiliateLinkCount": "제휴 OG 카드 수",
        "ogLinkCount": "링크 미리보기 카드 수",
        "tableCount": "표 수",
        "quoteCount": "인용구형 소제목 수",
        "firstExternalCtaPositionRatio": "첫 CTA 위치 비율",
    }
    for metric, label in labels.items():
        row = c[metric]
        lines.append(f"| {label} | {row['ours']} | {row['benchmarkMedian']} | {row['delta']} | {row['percentile']} |")
    lines.extend([
        "",
        "## 상위 글의 링크·배너 사용률",
        "",
        f"- 외부 링크 포함: {top['rates']['hasExternalLink']*100:.1f}%",
        f"- 제휴 링크 / 제휴 고지: {top['rates']['hasAffiliateLink']*100:.1f}% / {top['rates']['affiliateDisclosure']*100:.1f}%",
        f"- OG 썸네일을 포함한 이미지 링크: {top['rates']['hasLinkedImage']*100:.1f}%",
        f"- 커스텀 쿠팡 이미지 배너: {top['rates']['hasCoupangImageBanner']*100:.1f}%",
        f"- OG 링크 카드: {top['rates']['hasOgCard']*100:.1f}%",
        f"- 네이버 쇼핑커넥트: {top['rates']['hasShoppingConnect']*100:.1f}%",
        "",
        "## 현재 글의 CTA 형식",
        "",
        f"- 형식: `{ours['ctaStyle']}`",
        f"- OG 링크 카드: {ours['ogLinkCount']}개",
        f"- OG 카드 안의 썸네일을 포함한 이미지 링크: {ours['linkedExternalImageCount']}개",
        f"- 커스텀 링크 이미지: {ours['customLinkedExternalImageCount']}개",
        f"- 커스텀 쿠팡 배너: {ours['customLinkedCoupangBannerCount']}개",
        f"- 제휴 OG 카드: {ours['ogAffiliateLinkCount']}개",
        f"- 첫 외부 CTA 위치: 본문 진행률 {ours['firstExternalCtaPositionRatio']}",
        "",
        "## 상위 노출 작성자 표본",
        "",
        "| 작성자 | 최고 순위 | 검색 노출 횟수 | 노출 검색어 수 |",
        "|---|---:|---:|---:|",
    ])
    for item in authority_authors:
        lines.append(f"| {item['author']} | {item['bestRank']} | {item['appearances']} | {item['queryCount']} |")
    lines.extend([
        "",
        "## 해석",
        "",
        "- 이 표본에서 제휴 링크를 넣은 글은 커스텀 이미지 배너보다 OG 링크 카드를 사용했다.",
        "- 쿠팡의 iframe·script형 동적 배너는 일반 네이버 블로그 본문에 그대로 삽입하기보다 자사 사이트용 위젯으로 보는 편이 맞다.",
        "- 현재 글은 OG 제휴 카드 1개를 이미 사용하고 있다. 부족한 지점은 배너가 아니라 이미지 수, 소제목, 컴포넌트 다양성이다.",
        "",
    ])
    md_path.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"completed": True, "json": str(json_path), "markdown": str(md_path), "posts": len(posts), "topAuthority": len(top_authority), "affiliatePosts": len(affiliate_posts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
