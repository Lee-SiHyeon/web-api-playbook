# 인포크 기능 탐색과 제휴 발행 준비

2026-10-04에 현재 계정의 홈·링크 관리·링크/텍스트/이미지/컬렉션 생성 화면을 확인했다.
브라우저는 계약 탐색에만 사용했으며, 로그인 외 모든 Inpock POST/PUT/PATCH/DELETE를 전송 전에 차단했다.
링크 추가 요청도 브라우저가 준비한 필드만 관측하고 중단했다.
후속 2026-10-05에는 사용자 지시로 실제 공개 카드 한 개를 HTTP로 등록하고 아래 발행 검증을 추가했다.

## 현재 확인 범위

| 기능 | 확인 내용 | 증거 수준 |
|---|---|---|
| 로그인·계정 대조 | multipart 비밀번호 로그인, 보호 owner와 numeric ID 고정, 같은 프로세스 세션 재사용 | 실제 HTTP 실행 |
| 블록 목록 | `/v2/blocks`, `blocks,has_next,next_cursor`; 현재 0개, 첫 페이지에서 서버 종료 | UI XHR + 실제 HTTP 실행 |
| 공개 프로필 | `/v2/users/{username}/public`; 보호 owner의 ID/username과 공개 user 대조 | UI XHR + 실제 HTTP 실행 |
| 방문 통계 | `/stats/mini?username=…`, today/accumulated/realtime/subscribers | UI XHR + 실제 HTTP 실행 |
| 링크 카드 | 제목·URL·공개 여부; 현재 simple 공개 카드 생성·익명 공개 조회 확인 | 실제 POST 201 + 관리/익명 public API + 공개 웹 렌더링 |
| 텍스트 블록 | 줄바꿈을 포함한 내용, UI 500자 제한 | 실제 UI + 소스 계약 후보 |
| 이미지 블록 | 이미지·제목·외부 URL, UI 최대 30장 표시 | 실제 UI + 소스 계약 후보 |
| 컬렉션 | 제목과 2열/3열 상품 그리드 | 실제 UI + 소스 계약 후보 |
| 예약 공개·스티커 | 링크 화면에 PRO 표시 | UI/소스 관측; 권한·동작 미검증 |
| 수정·공개 전환·순서·보관·삭제 | source의 block 관리 mutation family | 소스 후보; 쓰기 미실행 |
| 이미지 업로드 | 별도 `upload-image.inpock.co.kr` multipart file, 소스의 10MiB 제한 | 소스 후보; 업로드 미실행 |

홈에는 매니저·파트너스·딜·채팅·AI·마켓 메뉴도 있다. 이번 범위는 제휴 콘텐츠의 링크 발행 준비이며,
이 메뉴 전체나 메시지/딜 업무를 재귀 탐색했다고 주장하지 않는다.
다중 페이지 cursor 동작은 소스와 회귀 테스트로 확인했다. 실제 계정은 목록이 비어 있어 두 번째 페이지는 미실행이다.

## API-only 실행

```bash
# 승인된 공급자가 {username,password} JSON을 stdin으로 전달한다.
node scripts/inpock.mjs blocks --credentials-stdin
node scripts/inpock.mjs public --credentials-stdin
node scripts/inpock.mjs stats --credentials-stdin
node scripts/inpock.mjs inventory --credentials-stdin
```

실제 사업 데이터를 소비할 때는 `createInpockReadClient({auth})`를 사용한다.
일반 CLI는 목록 원문이나 개인정보 대신 count·페이지 종료·상태·검증 영수증을 출력한다.
자격정보 입력과 Windows 보호 저장 사용법은 [로그인 안내](inpock-login.md)를 따른다.

## 글과 제휴 링크를 가져오는 연결점

인포크 링크 카드는 글 전체 본문을 받는 게시물 API가 아니다. 기본 후보는 원문 글 또는 제휴 상품으로 연결되는 카드다.
장문을 텍스트 블록 500자에 강제로 줄여 넣거나 블로그 본문을 링크 제목으로 옮기지 않는다.

`affiliate-content-operations`의 기본 main에는 최신 기능이 모두 모여 있지 않다.
현재 이 저장소의 pinned Naver publisher와 루트 Brand Connect client를 함께 확인했다.

| 원본 | 실제 연결점 | 준비 후보 |
|---|---|---|
| 공개 네이버 글 | `NaverEditorClient.#publicationReceipt`, full job/jobGate/resultGate 및 public readback | job.title + 실제 발행 글 URL |
| 그 글의 Coupang 제휴 링크 | publisher의 affiliate gate, 정확 account/product/item/vendor, 실제 redirect 증거 | 같은 제목 + 검증된 link.coupang.com URL |
| Brand Connect 쇼핑 링크 | 루트 createShoppingLink 결과와 owner-scoped shoppingLinks 관리목록의 상품/link ID·URL 대사 | 명시 제목 + 검증된 naver.me URL |

현재 Naver 상업 publisher의 제휴 gate는 Coupang과 별도 MyRealTrip 경로를 지원한다.
Brand Connect 링크 발급 구현이 있다고 Brand Connect 글의 자동 발행까지 연결됐다고 해석하지 않는다.
기존 E2E `publish-package`의 `publishAuthorized:false`도 공개 Inpock 트리거로 사용할 수 없다.

## 오프라인 후보 만들기

```bash
node scripts/inpock-prepare.mjs --help
node scripts/inpock-prepare.mjs < SOURCE.json
```

입력 최상위는 `{destination:"article"|"affiliate",is_open:boolean,source:{kind,...}}`다.
원문 글 카드와 직접 제휴 링크 카드를 반드시 명시적으로 선택한다.

- `source.kind:"naver-publication"`: 실제 full `job`, `jobGate`, `publicationReceipt` artifact.
- `source.kind:"brandconnect-shopping-link"`: 명시 `title`, 원래 `input:{affiliateProductId}`,
  실제 `linkResult`와 `managementResult`.

출력 후보는 관측된 `POST /blocks` 필드다.

```json
{
  "block_type": "link",
  "url": "<검증된 원문 또는 제휴 URL>",
  "title": "<원래 제목, 최대 150자>",
  "style": "simple",
  "image": "",
  "button_text": "",
  "is_open": false
}
```

준비 도구는 source identity와 변경 감지 fingerprint를 반환하며 HTTP 요청을 하지 않는다.
`prepared_only`, `publicationPerformed:false`, `networkUsed:false`가 실행 결과에 기록된다.
이미지는 실제 Inpock 업로드/readback 계약을 아직 검증하지 않아 후보에서 생략한다.
사용자가 제공한 영수증의 일관성을 검사하며 그 진위와 현재 원격 상태를 인증하는 도구는 아니다.
실제 발행은 현재 source 재검증 후 아래 publisher로 실행한다.
여행 링크는 기존 결과에 원래 상품 URL의 안전한 결합 증거가 부족해 이 helper에서 미지원 처리한다.

읽기 실측은 [inventory 영수증](../verification/inpock-inventory-2026-10-04.json),
탐색 단계와 미실행 범위는 [기능 탐색 영수증](../verification/inpock-features-2026-10-04.json)에 있다.

## 실제 카드 발행

```bash
node scripts/inpock.mjs publish --input=CARD.json --credentials-stdin
```

자격정보는 stdin에만 전달한다. `CARD.json`에는 비밀 없이
`{confirm:true,ownerUsername,sourceIdentity,payload}`를 넣는다.
`sourceIdentity`는 원본 channel/blogId/logNo/destination 같은 안정된 문자열 식별자다.
현재 writer는 정확한 `link/simple`, 빈 image/button_text, `is_open:true` 후보만 지원한다.

동일 인증 잠금에서 보호 owner 확인 → 완전한 관리 목록 → source/owner 기반 저널 예약 →
POST 한 번 → ACK ID 저장 → 관리 목록과 **쿠키 없는** public endpoint의 전체 필드 대조를 수행한다.
현재 성공 응답은 실제 관측한 `{block:{id,...}}` envelope다.
같은 source의 payload가 바뀌면 충돌로 종료하고, 이전 reserved/결과 불명확/실패 기록이 있으면
POST를 다시 보내지 않는다. 기존 원격 카드도 완전 일치할 때만 대사 성공으로 처리한다.
원문·이미지 수정과 숨김 카드 생성은 아직 이 writer의 범위 밖이다.

실증 카드의 원문은 현재 공개되어 있는 보조배터리 글이며, 최신 공개 HTTP와 쿠팡 첫 redirect를 확인했다.
원본 full publisher artifact가 로컬에 없어 기존 gate를 합성하지 않았다.
사용자의 명시적 카드 발행 지시와 현재 공개 원문 검증으로 별도 직접 입력을 확정했다.

첫 요청은 POST 201, 카드 ID는 독립 readback에서 7818106으로 확인했다.
첫 parser는 `{block:...}` ACK envelope를 아직 분류하지 못했으며 그 최초 영수증을 그대로 보존했다.
관측한 envelope를 코드·테스트에 반영했고, 같은 실제 의도를 새 프로세스에서 다시 호출하면
`already_verified`, `postAttempts:0`, 관리·익명 public 모두 한 개였다.
별도의 쿠키 없는 desktop/mobile 브라우저에서도 정확한 제목·글 href와 새로고침 후 유지가 확인됐다.

상세는 [발행 종합 영수증](../verification/inpock-publication-proof-2026-10-05.json),
[최초 POST 기록](../verification/inpock-publication-first-attempt-2026-10-05.json),
[중복 방지 재실행 기록](../verification/inpock-publication-2026-10-05.json)을 참고한다.
