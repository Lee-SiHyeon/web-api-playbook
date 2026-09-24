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
RAW = RESEARCH / "raw"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36"
)

QUERIES = [
    "보조배터리 추천",
    "도킹형 보조배터리",
    "미니 보조배터리 추천",
    "여행용 보조배터리",
    "가성비 보조배터리",
    "보조배터리 내돈내산",
    "쿠팡 꿀템",
    "생활용품 추천",
]


def clean(value: str | None) -> str:
    text = str(value or "")
    text = text.replace("새 창 열림", " ").replace("\u200b", " ").replace("\ufeff", " ")
    return " ".join(text.split())


def median(values: list[int | float]) -> float | None:
    return statistics.median(values) if values else None


def safe_int(value: str | None) -> int | None:
    try:
        return int(str(value).strip())
    except Exception:
        return None


def request(url: str, timeout: int = 25) -> requests.Response:
    response = requests.get(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    return response


@dataclass
class SearchResult:
    query: str
    rank: int
    title: str
    href: str
    author: str
    created: str
    image_count_hint: int | None
    snippet: str


def search_query(query: str) -> list[SearchResult]:
    url = "https://search.naver.com/search.naver?where=blog&query=" + quote(query)
    response = request(url)
    soup = BeautifulSoup(response.text, "lxml")
    results: list[SearchResult] = []

    for item in soup.select('[data-template-id="ugcItem"]'):
        title_anchor = None
        for anchor in item.select("a[href]"):
            href = anchor.get("href", "")
            if not re.fullmatch(r"https://blog\.naver\.com/[^/]+/\d+", href):
                continue
            if anchor.select_one(".sds-comps-text-type-headline1"):
                title_anchor = anchor
                break
        if not title_anchor:
            continue

        href = title_anchor.get("href", "")
        title = clean(title_anchor.get_text(" ", strip=True))
        snippet = ""
        for anchor in item.select("a[href]"):
            classes = set(anchor.get("class") or [])
            if anchor.get("href") == href and "fds-ugc-ellipsis3" in classes:
                snippet = clean(anchor.get_text(" ", strip=True))
                break

        author_node = item.select_one(".sds-comps-profile-info-title-text")
        date_node = item.select_one(".sds-comps-profile-info-subtext")
        badge = item.select_one('[data-sds-comp="ThumbnailTextBadge"]')

        if href not in {result.href for result in results}:
            results.append(
                SearchResult(
                    query=query,
                    rank=len(results) + 1,
                    title=title,
                    href=href,
                    author=clean(author_node.get_text(" ", strip=True) if author_node else ""),
                    created=clean(date_node.get_text(" ", strip=True) if date_node else ""),
                    image_count_hint=safe_int(badge.get_text(strip=True) if badge else None),
                    snippet=snippet,
                )
            )
    return results[:12]


def paragraph_font_size(node) -> int | None:
    sizes: list[int] = []
    for element in [node, *node.select("[class]")]:
        for class_name in element.get("class") or []:
            match = re.fullmatch(r"se-fs(\d+)", class_name)
            if match:
                sizes.append(int(match.group(1)))
    return max(sizes) if sizes else None


def classify_title(title: str) -> list[str]:
    patterns = {
        "recommendation": r"추천|BEST|베스트",
        "review": r"후기|리뷰|써보니|사용기",
        "comparison": r"비교|vs|VS|\d+종|한눈에",
        "question": r"\?|어떤|뭘 사|고를까|괜찮을까",
        "pain_or_caveat": r"후회|주의|단점|아쉬|발열|모르면|꼭 확인",
        "audience_or_scenario": r"여행|기내|출퇴근|아이폰|갤럭시|노트북|캠핑|육아",
        "proof": r"직접|내돈내산|실사용|테스트",
        "numbers": r"\d+(?:W|mAh|개|종|위|만원|%)",
    }
    return [name for name, pattern in patterns.items() if re.search(pattern, title, re.I)]


def hook_types(text: str) -> list[str]:
    intro = text[:450]
    patterns = {
        "problem_scene": r"하다 보면|번거|불편|부족|간당|고민|귀찮|놓치|후회",
        "first_person": r"저는|저도|제가|직접|써보|사용해|챙기는 편",
        "question": r"\?|어떤|고민되|찾고 있|필요하",
        "specific_scenario": r"여행|출퇴근|육아|사진|영상|지도|출장|캠핑|외출",
        "numeric_proof": r"\d+(?:W|mAh|g|mm|개|종|시간|분|%)",
        "contrarian": r"무조건|아무거나|단순히|생각보다|의외|오히려",
    }
    return [name for name, pattern in patterns.items() if re.search(pattern, intro, re.I)]


def analyze_post(url: str) -> dict:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise ValueError("unsupported_blog_url")
    blog_id, log_no = parts[-2], parts[-1]
    mobile_url = f"https://m.blog.naver.com/{blog_id}/{log_no}"
    response = request(mobile_url)
    soup = BeautifulSoup(response.text, "lxml")
    main = soup.select_one(".se-main-container")
    if main is None:
        raise ValueError("smart_editor_body_missing")

    page_title = clean((soup.select_one('meta[property="og:title"]') or {}).get("content") if soup.select_one('meta[property="og:title"]') else "")
    if not page_title and soup.title:
        page_title = clean(soup.title.get_text(" ", strip=True).replace(": 네이버 블로그", ""))

    paragraphs: list[str] = []
    heading_candidates: list[dict] = []
    for paragraph in main.select(".se-text-paragraph"):
        text = clean(paragraph.get_text(" ", strip=True))
        if not text:
            continue
        paragraphs.append(text)
        font_size = paragraph_font_size(paragraph)
        if len(text) <= 90 and font_size and font_size >= 19:
            heading_candidates.append({"text": text, "fontSize": font_size})

    components = Counter()
    for component in main.select(".se-component"):
        classes = set(component.get("class") or [])
        known = [
            "se-text", "se-image", "se-imageStrip", "se-table", "se-quotation",
            "se-video", "se-oglink", "se-shopping-connect", "se-sticker",
            "se-horizontalLine", "se-map", "se-code", "se-file",
        ]
        matched = False
        for name in known:
            if name in classes:
                components[name] += 1
                matched = True
        if not matched:
            components["other"] += 1

    body_text = "\n".join(paragraphs)
    links = [anchor.get("href", "") for anchor in main.select("a[href]")]
    unique_images = {
        image.get("data-lazy-src") or image.get("src")
        for image in main.select("img")
        if image.get("data-lazy-src") or image.get("src")
    }

    signals = {
        "disclosure": bool(re.search(r"파트너스 활동|제품을 제공받|원고료|광고|협찬|소정의 수수료|경제적 대가", body_text)),
        "coupangAffiliateLink": any("link.coupang.com" in link for link in links) or "link.coupang.com" in body_text,
        "directExperience": bool(re.search(r"직접|실제로|써보|사용해|며칠|일주일|한 달|내돈내산", body_text)),
        "prosCons": bool(re.search(r"장점|단점|아쉬|좋았|불편|다만|주의", body_text)),
        "whoFor": bool(re.search(r"이런 분|추천 대상|추천합니다|어울리는 분|잘 맞", body_text)),
        "comparison": bool(re.search(r"비교|vs|VS|차이|한눈에|표로", body_text)),
        "checklist": bool(re.search(r"체크|확인하세요|구매 전|고를 때|선택 기준", body_text)),
        "cta": bool(re.search(r"구매|상품 상세|보러가기|확인해 보|링크|가격 확인", body_text)),
        "specs": bool(re.search(r"mAh|\d+W|무게|사이즈|크기|포트|충전 속도|출력", body_text, re.I)),
        "freshnessMarker": bool(re.search(r"정보 확인일|기준일|업데이트|현재 가격|시점에 따라", body_text)),
    }

    first_paragraphs = paragraphs[:6]
    intro_text = " ".join(first_paragraphs)
    return {
        "url": url,
        "mobileUrl": mobile_url,
        "blogId": blog_id,
        "logNo": log_no,
        "title": page_title,
        "titleLength": len(page_title),
        "titleTypes": classify_title(page_title),
        "textLength": len(clean(body_text)),
        "paragraphCount": len(paragraphs),
        "medianParagraphLength": median([len(paragraph) for paragraph in paragraphs]),
        "imageCount": len(unique_images),
        "linkCount": len(links),
        "headingCount": len(heading_candidates),
        "headingCandidates": heading_candidates[:20],
        "componentCounts": dict(components),
        "introParagraphs": first_paragraphs,
        "hookTypes": hook_types(intro_text),
        "signals": signals,
        "sampleText": clean(body_text)[:1000],
    }


def aggregate(posts: list[dict]) -> dict:
    signal_counts = Counter()
    title_type_counts = Counter()
    hook_counts = Counter()
    component_counts = Counter()
    for post in posts:
        signal_counts.update(name for name, enabled in post["signals"].items() if enabled)
        title_type_counts.update(post["titleTypes"])
        hook_counts.update(post["hookTypes"])
        component_counts.update(post["componentCounts"])

    return {
        "postCount": len(posts),
        "medianTitleLength": median([post["titleLength"] for post in posts]),
        "medianTextLength": median([post["textLength"] for post in posts]),
        "medianParagraphCount": median([post["paragraphCount"] for post in posts]),
        "medianParagraphLength": median([post["medianParagraphLength"] for post in posts if post["medianParagraphLength"] is not None]),
        "medianImageCount": median([post["imageCount"] for post in posts]),
        "medianHeadingCount": median([post["headingCount"] for post in posts]),
        "signalCounts": dict(signal_counts.most_common()),
        "titleTypeCounts": dict(title_type_counts.most_common()),
        "hookTypeCounts": dict(hook_counts.most_common()),
        "componentCounts": dict(component_counts.most_common()),
    }


def main() -> None:
    RESEARCH.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    search_results: list[SearchResult] = []
    query_counts: dict[str, int] = {}
    for query in QUERIES:
        try:
            results = search_query(query)
        except Exception as error:
            results = []
            print(json.dumps({"query": query, "error": type(error).__name__}, ensure_ascii=False))
        search_results.extend(results)
        query_counts[query] = len(results)
        time.sleep(0.35)

    by_url: dict[str, dict] = {}
    for result in search_results:
        entry = by_url.setdefault(
            result.href,
            {
                "href": result.href,
                "title": result.title,
                "author": result.author,
                "created": result.created,
                "imageCountHint": result.image_count_hint,
                "snippet": result.snippet,
                "appearances": [],
            },
        )
        entry["appearances"].append({"query": result.query, "rank": result.rank})

    unique_results = list(by_url.values())
    unique_results.sort(
        key=lambda item: (
            min(appearance["rank"] for appearance in item["appearances"]),
            -len(item["appearances"]),
            item["href"],
        )
    )

    selected = unique_results[:42]
    posts: list[dict] = []
    failures: list[dict] = []
    for index, result in enumerate(selected, 1):
        try:
            analysis = analyze_post(result["href"])
            analysis["search"] = result
            posts.append(analysis)
        except Exception as error:
            failures.append({"href": result["href"], "error": type(error).__name__})
        print(json.dumps({"progress": index, "total": len(selected), "posts": len(posts), "failures": len(failures)}))
        time.sleep(0.30)

    corpus = {
        "schemaVersion": 1,
        "checkedAt": checked_at,
        "source": "current_naver_blog_search_and_public_mobile_posts",
        "queries": QUERIES,
        "queryResultCounts": query_counts,
        "searchResultCount": len(search_results),
        "uniqueSearchResultCount": len(unique_results),
        "selectedPostCount": len(selected),
        "analyzedPostCount": len(posts),
        "failureCount": len(failures),
        "aggregate": aggregate(posts),
        "posts": posts,
        "failures": failures,
    }

    output = RESEARCH / "naver-blog-reference-corpus-2026-09-19.json"
    output.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"completed": True, "output": str(output), **corpus["aggregate"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
