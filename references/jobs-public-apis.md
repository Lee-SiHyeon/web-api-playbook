# 공개 채용공고 읽기와 변경 비교

이 기능 묶음은 Greenhouse, Lever, Ashby의 공개 회사 공고 게시판, 일본 개발자를 위한 TokyoDev 공개 공고 문서, Remotive의 공개 원격 채용 API, 그리고 호출자가 제공한 키로 조회하는 Reed UK Jobseeker API를 지원합니다. 연결 서비스가 있다는 사실과 각 소스의 라이브 조회가 증명됐다는 사실은 별개입니다. 보관된 영수증과 현재 코드 해시가 연결되기 전까지 구현된 기능은 `pending_live`로 봅니다.

## 빠른 시작

```bash
node scripts/jobs.mjs greenhouse list --board=greenhouse --output=work/greenhouse.json
node scripts/jobs.mjs lever collect --board=spotify --limit=20 --max-pages=5 --output=work/lever.json
node scripts/jobs.mjs ashby list --board=Ashby --output=work/ashby.json
node scripts/jobs.mjs tokyodev list --output=work/tokyodev.json
node scripts/jobs.mjs tokyodev detail --url=https://www.tokyodev.com/companies/SLUG/jobs/SLUG --output=work/tokyodev-detail.json
node scripts/jobs.mjs remotive list --query=typescript --output=work/remotive.json
node scripts/jobs.mjs snapshot --input=work/greenhouse.json --output=work/greenhouse.snapshot.json
node scripts/jobs.mjs diff --before=work/greenhouse.before.json --after=work/greenhouse.snapshot.json
```

`--board`는 회사 게시판 식별자입니다. 여러 회사를 검색하는 전역 채용 검색어로 해석하지 않습니다. Lever는 global 또는 EU 보드를 지원합니다. Reed는 공식 API 키가 필요하며 키는 서비스 태그를 확인하는 숨김 stdin JSON으로만 받습니다. 저장소 환경변수, URL, 로그, 저널에 키를 전달하지 않습니다. 명령별 지원 옵션은 `node scripts/jobs.mjs --help`를 확인하세요.

## 공급자별 경계

- **Greenhouse:** Job Board API의 공개 GET을 사용합니다. `content=true`는 설명·부서·사무실을 함께 받습니다. 공개 게시판에 나타난 공고 전수와 `meta.total`이 일치할 때만 완전 조회로 봅니다. 지원 제출 POST와 사내 후보자·면접 데이터는 이 리더 범위에 없습니다. [공식 API 안내](https://docs.greenhouse.io/job-board.html)
- **Lever:** 공개 게시글만 제공하는 global/EU Postings API를 사용합니다. 목록 제한과 `skip`으로 페이지를 넘깁니다. 결과가 페이지 제한에 꽉 찼으면 다음 페이지가 없다고 추정하지 않습니다. [공식 Postings API 문서](https://github.com/lever/postings-api)
- **Ashby:** 게시판 공개 채용공고 API에서 `isListed=true`인 항목만 반환합니다. 선택적 보상 정보에는 회사가 설정한 티어·지역·조건을 보존합니다. 계약 내용을 하나의 급여 범위로 합치거나 시간 단위를 연봉으로 추정하지 않습니다. [공식 API 안내](https://developers.ashbyhq.com/docs/public-job-posting-api)
- **TokyoDev (일본):** `GET /jobs` 공개 HTML에서 페이지에 보이는 공고 카드를 읽고, 회사가 표시한 Japanese skill·Japan residency·apply-from-abroad·근무형태 태그를 `sourceFacts`로 보존합니다. 페이지의 전체 공고 광고 수와 화면 카드 수가 맞아야 목록을 완전하다고 표시합니다. 상세는 사용자가 전달한 TokyoDev 정규 공고 URL 하나만 열고 canonical URL·JSON-LD ID·제목·회사명이 일치하는지 확인합니다. 급여 단위·지역 요구를 추정하거나 일본 비자 후원을 만들어내지 않습니다. [TokyoDev 공고](https://www.tokyodev.com/jobs)
- **Remotive:** 공식 공개 원격 채용 API를 사용합니다. 데이터는 최대 약 24시간 지연될 수 있고, Remotive는 출처 표기와 원본 공고 링크를 요구하며 하루 4회 이하 호출을 권고합니다. `salary`는 API 원문 문자열로 보존하며 통화·지급 주기를 만들어내지 않습니다. [공식 API 문서](https://github.com/remotive-com/remote-jobs-api)
- **Reed:** 공식 Jobseeker Search API에는 발급받은 키를 Basic 인증으로 넣습니다. API 문서와 검색 계약은 존재하지만 이 저장소에서 키 발급·실 계정 권한은 수행하지 않았습니다. 회사 필터, 지역, 고용 형태, 급여 기준으로 공고를 읽을 수 있습니다. 문서가 canonical URL이나 급여 단위를 주지 않으면 생성하지 않습니다. [Reed API 문서](https://www.reed.co.uk/developers/jobseeker)

## 비교 스냅샷 읽기

스냅샷은 서비스·게시판·지역·필터 조합이 같은 두 목록만 비교합니다. `added`는 새로 관측된 ID, `changed`는 정규화된 필드의 이전/현재 값이며, 급여·위치·근무형태 변경도 그대로 드러납니다. 이전과 최신 목록이 모두 완전하다고 공급자 계약상 확인될 때만 `missingFromLatest`를 표시합니다. 이 값은 공고 종료를 증명하지 않습니다. 자동으로 `closed` 상태를 만들지 않습니다. 한쪽이라도 부분 목록이면 누락 비교를 건너뜁니다.

조회 응답에는 범위·페이지 수·이어받을 위치가 포함됩니다. 페이지가 비어 있다는 사실은 검색 결과가 없다는 관측입니다. 요청 실패, 차단 페이지, 잘못된 MIME·JSON·응답 스키마를 빈 목록으로 변환하지 않습니다. 반복적인 대량 폴링이나 제한 우회를 하지 않습니다.

공개 공고 API는 지원자 개인의 지원 상태나 고용주 ATS의 비공개 후보자 기록을 돌려주지 않습니다. Greenhouse, Lever, Ashby의 회사 자격 증명 API는 별도 관리 범위이며, 공개 게시판 응답에서 지원 여부·면접 결과를 추론하지 않습니다. LinkedIn 개인 계정 클라이언트도 이 변경에 추가하지 않았습니다.

## 확인된 실행과 미확인 상태

[2026-10-23 실행 기록](../verification/jobs-freelance-2026-10-23/README.md)은 실제 CLI 결과와 현재 구현 해시를 연결합니다. Greenhouse 19개, Ashby 69개, Lever 2페이지 79개, Remotive 9개의 공개 공고를 해당 게시판에서 읽었습니다. Greenhouse·Lever·Ashby는 선택한 공고를 공통 실행기에서 다시 읽어 정확한 ID를 대조했습니다. 이 수치는 전체 플랫폼의 공고 수가 아닙니다.

TokyoDev는 현재 Node HTTP와 작업용 브라우저에서 Cloudflare 403을 반환합니다. 정상 브라우저 세션의 쿠키 전달은 아직 검증하지 못했습니다. 저장된 원본 HTML의 공고 142개를 다음 명령으로 네트워크 없이 파싱할 수 있으며, 결과는 `offline`·`liveReplay:false`·`liveCurrentness:unknown`으로 표시됩니다.

```bash
node scripts/jobs.mjs tokyodev parse --input=work/tokyodev.html --url=https://www.tokyodev.com/jobs
```

Reed의 실제 API 키 조회는 미확인입니다. Remotive 데이터는 공급자가 명시한 지연과 출처 표기 조건을 유지하며, 검증을 위해 반복 폴링하지 않습니다. `npm run verify:jobs-freelance`는 기록된 증거를 오프라인 검증합니다. 현재 원격 응답이나 개인 지원 상태를 새로 확인하는 명령이 아닙니다.
