from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

import requests
from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[2]
RADAR_ROOT = ROOT / "research" / "community-radar"
EVIDENCE = RADAR_ROOT / "evidence"
PROFILES = RADAR_ROOT / "profiles"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36"
)


ISSUES = {
    "heat": [r"발열", r"뜨겁", r"열이", r"핫팩"],
    "case_compatibility": [r"케이스", r"범퍼", r"단자가.*안", r"꽂히지"],
    "actual_capacity": [r"충전.*퍼센트", r"몇.*프로", r"50프로", r"실제.*용량", r"한 번.*충전"],
    "charging_method": [r"충전방법", r"어댑터", r"콘센트", r"어떻게.*충전"],
    "port_strain": [r"단자", r"유격", r"흔들", r"부러", r"무게가.*실"],
    "charging_speed": [r"고속", r"속도", r"느리", r"출력"],
    "usability": [r"타이핑", r"촬영", r"사용.*불편", r"손목", r"들고.*사용"],
    "durability": [r"고장", r"불량", r"내구", r"교환", r"AS", r"파손"],
    "travel_airline": [r"기내", r"비행기", r"여행", r"항공"],
    "display_convenience": [r"잔량", r"디스플레이", r"LED"],
}

DEFAULT_SUFFIXES = [
    "",
    " 발열",
    " 단점",
    " 케이스",
    " 충전방법",
    " 실제 충전량",
    " 고장",
    " 기내",
]

DEFAULT_QUESTIONS = {
    "heat": "도킹 충전 중 발열이 특정 출력·케이스·사용 중 충전 조건에서 반복되는가",
    "case_compatibility": "두꺼운 케이스를 장착한 상태에서 단자가 끝까지 들어가는가",
    "actual_capacity": "약 5,000mAh가 실제 스마트폰에서 어느 정도 충전되는가",
    "charging_method": "보조배터리 본체 충전 방식과 어댑터 직결 사용이 공식 설명과 일치하는가",
    "port_strain": "휴대폰 단자에 무게가 실리거나 유격·파손 불만이 반복되는가",
    "charging_speed": "상품명에 적힌 고속충전 주장과 실제 출력 조건이 무엇인가",
    "usability": "충전 중 타이핑·촬영·통화가 불편하다는 의견이 반복되는가",
    "durability": "단자·배터리·표시창 관련 초기 불량과 장기 내구 불만이 반복되는가",
    "travel_airline": "기내반입·여행 중 보관과 사용에서 반복되는 질문이 무엇인가",
    "display_convenience": "잔량 표시가 실제 선택과 사용에 유용하다는 의견이 반복되는가",
}


def clean(value: str | None) -> str:
    text = str(value or "").replace("새 창 열림", " ").replace("\u200b", " ")
    return " ".join(text.split())


def canonical_cafe_url(raw: str) -> str | None:
    try:
        parsed = urlparse(raw)
    except Exception:
        return None
    if parsed.hostname not in {"cafe.naver.com", "m.cafe.naver.com"}:
        return None
    match = re.fullmatch(r"/([^/]+)/([0-9]+)", parsed.path.rstrip("/"))
    if not match:
        return None
    return f"https://cafe.naver.com/{match.group(1)}/{match.group(2)}"


def request_search(query: str) -> tuple[list[dict], dict]:
    url = "https://search.naver.com/search.naver?where=article&query=" + quote(query)
    response = requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9"},
        timeout=25,
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "lxml")
    results = []
    for item in soup.select('[data-template-id="ugcItem"]'):
        title_anchor = None
        for anchor in item.select("a[href]"):
            href = canonical_cafe_url(anchor.get("href", ""))
            if href and anchor.select_one(".sds-comps-text-type-headline1"):
                title_anchor = anchor
                break
        if title_anchor is None:
            continue
        href = canonical_cafe_url(title_anchor.get("href", ""))
        if not href:
            continue
        title = clean(title_anchor.get_text(" ", strip=True))
        snippet = ""
        for anchor in item.select("a[href]"):
            if canonical_cafe_url(anchor.get("href", "")) == href and "fds-ugc-ellipsis3" in (anchor.get("class") or []):
                snippet = clean(anchor.get_text(" ", strip=True))
                break
        community_node = item.select_one(".sds-comps-profile-info-title-text")
        date_node = item.select_one(".sds-comps-profile-info-subtext")
        results.append(
            {
                "url": href,
                "title": title[:180],
                "snippet": snippet[:600],
                "community": clean(community_node.get_text(" ", strip=True) if community_node else "")[:120],
                "dateLabel": clean(date_node.get_text(" ", strip=True) if date_node else "")[:60],
            }
        )
    receipt = {
        "method": "GET",
        "origin": "https://search.naver.com",
        "path": "/search.naver",
        "queryFields": ["where", "query"],
        "httpStatus": response.status_code,
        "mime": (response.headers.get("content-type") or "").split(";")[0],
        "bytes": len(response.content),
        "browserUsed": False,
    }
    return results, receipt


def load_profile(name: str) -> dict:
    if name == "power-bank":
        return {
            "name": name,
            "issues": ISSUES,
            "suffixes": DEFAULT_SUFFIXES,
            "questions": DEFAULT_QUESTIONS,
        }
    target = PROFILES / f"{name}.json"
    data = json.loads(target.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1:
        raise ValueError("profile_schema_version")
    issues = data.get("issues")
    suffixes = data.get("suffixes")
    questions = data.get("questions")
    if not isinstance(issues, dict) or not issues:
        raise ValueError("profile_issues_missing")
    if not isinstance(suffixes, list) or not suffixes:
        raise ValueError("profile_suffixes_missing")
    if not isinstance(questions, dict):
        raise ValueError("profile_questions_missing")
    return {
        "name": name,
        "issues": issues,
        "suffixes": suffixes,
        "questions": questions,
    }


def classify(text: str, issues: dict[str, list[str]]) -> list[str]:
    return [name for name, patterns in issues.items() if any(re.search(pattern, text, re.I) for pattern in patterns)]


def build_queries(seed: str, suffixes: list[str]) -> list[str]:
    return [seed + suffix for suffix in suffixes]


def markdown(record: dict) -> str:
    lines = [
        f"# 커뮤니티 이슈 레이더: {record['seed']}",
        "",
        f"- 확인 시각: {record['checkedAt']}",
        f"- 검색 쿼리: {len(record['queries'])}개",
        f"- 중복 제거 공개 카페 글: {record['articleCount']}개",
        "- 개인 닉네임·댓글 전문·로그인 정보는 수집하지 않음",
        "",
        "## 반복 이슈",
        "",
        "| 이슈 | 문서 수 | 대표 질문·상황 |",
        "|---|---:|---|",
    ]
    for issue in record["issueSummary"]:
        examples = "; ".join(issue["exampleTitles"][:3]) or "-"
        lines.append(f"| {issue['issue']} | {issue['articleCount']} | {examples} |")
    lines.extend(
        [
            "",
            "## 글에 반영할 검증 질문",
            "",
            *[f"- {question}" for question in record["editorialQuestions"]],
            "",
            "## 해석 주의",
            "",
            "- 검색 결과 제목·스니펫은 반복 질문을 찾는 신호이며 제품 결함의 통계적 증명은 아니다.",
            "- 후기 신호는 공식 사양·실측·안전 문서와 구분해 작성한다.",
            "- 직접 사용하지 않은 내용을 내 경험처럼 표현하지 않는다.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Public Naver Cafe issue radar for editorial research.")
    parser.add_argument("seed")
    parser.add_argument("--profile", default="power-bank")
    parser.add_argument("--delay", type=float, default=0.35)
    args = parser.parse_args()

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    profile = load_profile(args.profile)
    queries = build_queries(args.seed, profile["suffixes"])
    by_url: dict[str, dict] = {}
    receipts = []
    failures = []
    for query in queries:
        try:
            results, receipt = request_search(query)
            receipts.append({"query": query, **receipt})
            for rank, result in enumerate(results, 1):
                entry = by_url.setdefault(result["url"], {**result, "appearances": []})
                entry["appearances"].append({"query": query, "rank": rank})
        except Exception as error:
            failures.append({"query": query, "error": type(error).__name__})
        time.sleep(args.delay)

    issue_docs: dict[str, set[str]] = defaultdict(set)
    issue_examples: dict[str, list[str]] = defaultdict(list)
    articles = []
    for entry in by_url.values():
        text = clean(f"{entry['title']} {entry['snippet']}")
        issues = classify(text, profile["issues"])
        for issue in issues:
            issue_docs[issue].add(entry["url"])
            if entry["title"] not in issue_examples[issue]:
                issue_examples[issue].append(entry["title"])
        articles.append({**entry, "issues": issues})

    issue_summary = [
        {
            "issue": issue,
            "articleCount": len(urls),
            "exampleTitles": issue_examples[issue][:5],
        }
        for issue, urls in issue_docs.items()
    ]
    issue_summary.sort(key=lambda item: (-item["articleCount"], item["issue"]))

    questions = profile["questions"]

    checked_at = datetime.now(timezone.utc)
    record = {
        "schemaVersion": 1,
        "checkedAt": checked_at.isoformat().replace("+00:00", "Z"),
        "mode": "public_community_search_metadata_only",
        "seed": args.seed,
        "profile": profile["name"],
        "queries": queries,
        "queryCount": len(queries),
        "querySuccessCount": len(receipts),
        "articleCount": len(articles),
        "issueSummary": issue_summary,
        "editorialQuestions": [questions[item["issue"]] for item in issue_summary if item["issue"] in questions],
        "articles": articles,
        "receipts": receipts,
        "failures": failures,
        "sourceState": {
            "captured": True,
            "client_exists": True,
            "remnant_free": True,
            "credential_propagated": "not_applicable_public",
            "live_replay": bool(receipts),
        },
        "browserUsed": False,
        "credentialsPersisted": False,
        "personalUsernamesCaptured": False,
        "fullCommentsCaptured": False,
    }
    stamp = checked_at.strftime("%Y%m%dT%H%M%SZ")
    evidence_name = f"community-radar-{stamp}.json"
    (EVIDENCE / evidence_name).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (RADAR_ROOT / "latest.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (RADAR_ROOT / "latest.md").write_text(markdown(record), encoding="utf-8")
    print(
        json.dumps(
            {
                "completed": True,
                "seed": args.seed,
                "articleCount": len(articles),
                "issueCount": len(issue_summary),
                "topIssues": [item["issue"] for item in issue_summary[:5]],
                "evidenceFile": evidence_name,
                "browserUsed": False,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
