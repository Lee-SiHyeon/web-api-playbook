# Web API Playbook

**한국어** | [English](README.en.md)

[![GitHub stars](https://img.shields.io/github/stars/Lee-SiHyeon/web-api-playbook?style=social)](https://github.com/Lee-SiHyeon/web-api-playbook/stargazers)
[![Offline Node checks](https://github.com/Lee-SiHyeon/web-api-playbook/actions/workflows/offline-checks.yml/badge.svg?branch=main)](https://github.com/Lee-SiHyeon/web-api-playbook/actions/workflows/offline-checks.yml)
[![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](#빠른-시작)

**공식 API가 없는 웹사이트도 API처럼 호출해서 자동화할 수 있게 만드는 도구와 노하우 모음입니다.**

브라우저가 화면 뒤에서 주고받는 요청(XHR·Fetch·Document)을 관측하고, 그 요청을 브라우저 없이
재현 가능한 HTTP 작업으로 바꿉니다. 로그인 세션을 안전하게 저장·재사용하고, 결과가 실제로
반영됐는지 다시 읽어서 확인합니다.

```text
브라우저에서 요청 관측 (HAR·HTML·번들)
  → 요청 계약 정리 (origin·필드·응답 형태)
  → 세션을 붙인 독립 HTTP 실행 (CLI·MCP)
  → 응답 검증과 readback으로 실제 결과 확인
```

## 무엇을 자동화할 수 있나

이 방식으로 실제 구현한 예입니다. 범위와 한계는 서비스마다 다르며 링크된 문서에 적혀 있습니다.

| 분야 | 예시 |
|---|---|
| 블로그 발행 | [네이버 블로그](service-packs/naver/README.md), [티스토리](service-packs/tistory/README.md) 로그인·조회·이미지/영상 업로드·발행 |
| 쇼핑·가격 수집 | 쿠팡, 아마존, 라쿠텐·야후쇼핑, 알리익스프레스, 에이블리, 올리브영 검색·상세·옵션·리뷰 |
| 제휴 링크 | 쿠팡 파트너스, 네이버 브랜드커넥트, 마이리얼트립, 애드픽, 링크프라이스 상품 검색·링크 발급 |
| 여행 | 아고다 날짜별 요금·행사, 쿠팡 트래블, 마이리얼트립 투어·티켓 검색 |
| SNS·크리에이터 | [X·Reddit](service-packs/social-x/README.md), [Threads](service-packs/threads/README.md), 인포크 프로필·카드 발행, YouTube Studio 업로드 |
| 운영 | Gabia 도메인·DNS 조회 |

전체 목록은 [상세 가이드](docs/guide.md#무엇이-들어-있나)와 `npm run services`로 볼 수 있습니다.

## 빠른 시작

Node.js 24 이상, npm, Git이 필요합니다. 아래 예제는 저장소의 합성 파일만 처리하므로 브라우저·네트워크·로그인이 필요 없습니다.

```sh
git clone https://github.com/Lee-SiHyeon/web-api-playbook.git
cd web-api-playbook
npm ci --ignore-scripts
npm run doctor

node scripts/har-to-contracts.mjs --input=examples/sanitized.har.json
node scripts/discover-html.mjs --input=examples/navigation.html --base=https://example.invalid/
node scripts/playbook.mjs describe --profile=templates/profile-v2.example.json
```

- `har-to-contracts`: HAR에서 요청 필드·응답 타입·상태 코드를 뽑은 계약 목록. 토큰과 본문 값은 출력하지 않습니다.
- `discover-html`: 저장된 HTML에서 찾은 링크·iframe·스크립트 후보.
- `playbook describe`: profile에 정의된 작업과 입력 형식.

## 새 사이트를 API로 만드는 순서

1. **관측:** 권한이 있는 계정으로 브라우저에서 원하는 동작을 하고 HAR을 저장합니다. 원본 HAR은 Git 밖에 둡니다.
2. **계약 정리:** `har-to-contracts`로 요청 목록을 만들고, [profile 템플릿](templates/profile-v2.example.json)에 허용 origin·작업·입력·기대 응답을 적습니다.
3. **세션 연결:** 쿠키·토큰을 stdin으로 넘겨 보호 저장하고, 계정 소유를 확인하는 읽기 요청으로 세션을 검증합니다.
4. **실행:** `playbook run`·`collect`(재개 가능)로 CLI에서 쓰거나, `playbook mcp`로 AI 에이전트에 도구로 붙입니다.
5. **확인:** 쓰기는 저널을 남기고, 서버 응답이 아니라 다시 읽은 실제 상태로 완료를 판정합니다.

단계별 명령과 옵션은 [상세 가이드 4장](docs/guide.md#4-새-서비스를-http로-전환할-때), 작업 정의는 [공통 기능 실행기](references/operation-runtime.md)에 있습니다.

## 이미 만든 서비스 쓰기

```sh
npm run services                                       # 연결된 서비스와 작업 목록 (네트워크 요청 없음)
node scripts/playbook.mjs run --service=ably --operation=categories
```

서비스별 로그인·실행법은 [서비스 공통 CLI](references/service-cli.md)와 [서비스 pack 목록](service-packs/README.md)을 보세요.
AI 에이전트(Codex 등)에서 쓰려면 [SKILL.md](SKILL.md)를 읽히거나 `npm run install:skill`로 설치합니다.

## 세션 저장

계정 비밀번호·쿠키·토큰·브라우저 프로필은 저장소에 들어 있지 않습니다. clone한다고 인증이 옮겨 가지 않습니다.

| 방식 | 설명 |
|---|---|
| Windows DPAPI | Windows 기본값. 현재 Windows 사용자에 묶여 저장됩니다. |
| 암호화 파일 | macOS/Linux에서 `PROTECTED_STORE_PROVIDER=file`. AES-256-GCM 봉인 파일입니다. |
| stdin·메모리 | `--session-stdin`. 해당 프로세스 동안만 유지됩니다. |

## 원칙

- **HTTP 200은 성공이 아닙니다.** 응답 형태·계정 소유·실제 반영 결과를 따로 확인합니다.
- **쓰기는 재전송하지 않습니다.** 응답이 끊기면 저널과 readback으로 대사합니다.
- **관측 범위를 기록합니다.** 한 카테고리를 본 것을 사이트 전체 탐색으로 세지 않습니다.
- **한계를 숨기지 않습니다.** 최초 로그인이나 일부 단계에 브라우저가 필요한 경우 그대로 표시합니다. 모든 사이트·CAPTCHA를 지원한다고 주장하지 않습니다.

## 문서

| 문서 | 내용 |
|---|---|
| [상세 가이드](docs/guide.md) | 전체 기능 표, 서비스별 실행법, 전환 절차, 오류 코드 대응, 테스트 준비 |
| [SKILL.md](SKILL.md) | 에이전트가 따르는 전환 절차와 증거 기준 |
| [references](references/) | 서비스별 요청 계약, 페이지네이션·백오프·봇 차단·세션 갱신 패턴 |
| [사례](case-studies/README.md) | 성공·실패 사례와 다른 서비스에 적용할 교훈 |
| [verification](verification/README.md) · [checklists](checklists/README.md) | 실측 증거와 기능별 구현 범위 |

## 테스트

```sh
npm run test:operations
npm run test:services
npm test   # 전체 회귀. Python 3 필요
```

[offline CI](.github/workflows/offline-checks.yml)는 Ubuntu·Node 24에서 설치·doctor·회귀 테스트를 실행합니다. 실제 서비스 로그인은 실행하지 않습니다. Python 경로 지정 등은 [상세 가이드](docs/guide.md#전체-회귀-검사-준비)를 보세요.

## 기여

기능 추가·개선 [PR](https://github.com/Lee-SiHyeon/web-api-playbook/pulls)과 [Discussions](https://github.com/Lee-SiHyeon/web-api-playbook/discussions)는 언제든 환영합니다. 기대하는 동작과 재현 절차·예시를 함께 남겨 주세요.

## 라이선스

[MIT](LICENSE): 개인·상업적 용도 모두 자유롭게 쓰고, 고치고, 재배포하셔도 됩니다. 저작권 표시만 남겨 주세요. 사용에 따른 결과는 사용자 책임입니다.

`node_modules`로 설치되는 타사 라이브러리와 [provenance](provenance/README.md)에 출처가 적힌 외부 자료는 각 원저작자의 라이선스를 따릅니다. 자동화하는 각 사이트의 이용약관도 직접 확인하고 쓰세요. 자세한 내용은 [NOTICE](NOTICE.md)에 있습니다.
