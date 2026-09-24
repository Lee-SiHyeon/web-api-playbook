# Naver Blog API-only

`https://blog.naver.com/4053103`의 관리·통계 요청을 관측한 기록과 통계 조회 API-only 클라이언트입니다.

**2026-09-13: 4053103 재로그인 후 통계 GET 55개를 관측·구현했고, 22개는 별도 Node CLI 프로세스에 로그인 세션을 전달해 HTTP 200·응답 상태 200·통계 구조를 검증했습니다.** [실호출 증거](evidence/live-replays-2026-09-13.json), [작업별 상태](references/implemented-operations.json), [전체 범위](discovery/coverage.json)를 구분해 확인하세요.

사용자 요청에 따라 **화면 탐색은 중단하고 독립 HTTP 탐색으로 전환**합니다. HTML·iframe·JavaScript 탐색기는 [별도 도구](docs/non-browser-discovery.md)로 분리했습니다. 기존 CLI 호출은 종료됐고, 세션을 계속 보관할 새 HTTP 전용 실행기로의 일회성 전달은 Chrome 연결 승인 시간 초과로 미완료입니다. 이 새 도구의 라이브 재귀 탐색 완료를 주장하지 않습니다. 전체 관리 영역 탐색도 미완료입니다. 최신 상태는 [session-status.json](discovery/session-status.json), 원본과 재개 대기열은 [frontier.json](discovery/frontier.json)에 있습니다.

## 구현 및 검증 범위

| 항목 | 상태 |
|---|---|
| 초기 재귀 탐색 | 관리 화면 43개, 관측 계약 23개 |
| 수집 연결 복구 후 | 통계 루트와 하위 화면 총 24개 방문, JSON 경로 21개 관측 |
| 과거 독립 HTTP 검증 | 복구 후 통계 API 10개가 HTTP 200·상태 코드 200·예상 결과 존재 조건 통과; 이전 일일 통계 검증도 별도 보관 |
| 재사용 코드 | 현재 관측 통계 GET 55개용 `client.mjs`와 CLI; 11개 오프라인 테스트 통과 |
| 현재 세션 검증 | 재로그인 후 22개 별도 CLI 실호출 성공; 새 HTTP 전용 실행기 세션 전달은 연결 승인 시간 초과 |
| 이번 통계 메뉴 관측 | URL을 가진 통계 문서 72개와 iframe 24개 확인; 모든 필터·다른 관리 영역 완료를 의미하지 않음 |
| 로그인 | Chrome 로그인 확인; 독립 HTTP 로그인·세션 갱신 미구현 |
| 글·설정 쓰기 | 작성·삭제·설정 변경 미검증 |

과거 통계 10개 재현 성공, 현재 코드 55개 구현, 이번 독립 실검증 22개는 서로 다른 상태입니다. 전체 재귀 탐색은 미완료입니다. 대기열은 iframe·메뉴·JavaScript 컨트롤을 포함하므로 실제 기능 개수와 동일하지 않습니다. 화면에서 본 경로를 독립 HTTP 검증 완료로 자동 승격하지 않았습니다.

## 인증과 기록 취급

일반 API 실행은 유효한 로그인 쿠키를 실행 프로세스의 환경변수로 받습니다. 탐색 도구에는 명시적으로 승인된 Chrome 세션의 일회성 전달 기능도 있지만, 해당 도구의 라이브 세션 전달은 아직 검증되지 않았습니다. 독립 로그인·세션 갱신은 미구현입니다. 자격증명은 Git에 저장하지 말고 실행 시에만 전달하세요. 사용자가 관리하는 대상에 대해서만 요청합니다.

이 저장소에는 코드, 관측한 필드·타입, 탐색 지도, 과거 검증 메타데이터가 포함됩니다. 브라우저 프로필, 쿠키, 비밀번호, 환경 파일, 원문 요청·응답, 누적 네트워크 로그는 포함하지 않습니다. 검색어·이메일·민감한 쿼리값은 반출본에서 제거했습니다. 지도에 있는 `[redacted]` 또는 그 URL 인코딩 값은 실제 요청값이 아니며 실행 전에 현재 관측값으로 대체해야 합니다.

`stat-replay.json`과 `resumed-replays.json`은 **2026-09-06 당시 결과**입니다. `live-replays-2026-09-13.json`은 재로그인 후 별도 Node 프로세스의 실제 HTTP 검증입니다. 과거 성공 기록으로 새로운 프로세스의 세션 보유나 계속 실행 중임을 보장하지 않습니다.

## 실행 환경

Node.js 24 이상, 추가 npm 의존성 없음. 아래 예시는 유효한 인증 환경변수가 이미 실행 프로세스에 공급되어 있다는 전제입니다. 인증정보를 명령문·출력·Git 기록에 넣지 마세요.

## 사용법

인증 환경변수: `NAVER_COOKIE`.

```powershell
node scripts/cli.mjs --list
'{"url":"https://blog.stat.naver.com/api/blog/daily/cv?timeDimension=<관측값>&startDate=<관측값>&exclude=<관측값>&_=<관측값>"}' | node scripts/stat-client.mjs
'{"operation":"visit/cv","query":{"timeDimension":"<관측값>","startDate":"<관측값>","exclude":"<관측값>","_":"<관측값>"}}' | node scripts/cli.mjs
```

`<관측값>`을 현재 허용된 세션에서 실제로 관측한 값으로 바꿔야 합니다. 위 예시는 입력 구조이며 그대로 실행하는 샘플 URL이 아닙니다. 실제 값을 추정하거나 인증값을 붙여 넣은 예제를 저장소에 기록하지 않습니다.

클라이언트는 실제 관측된 `blog.stat.naver.com/api/blog/`의 55개 GET 경로만 허용합니다. 쿼리 필드는 각 계약에 관측된 이름을 모두 공급해야 하며 추가·중복 필드는 거절합니다. 경로에 따라 `hour`, `size`, `deviceType` 등이 추가로 필요합니다. 실제 선택자 값을 추정하지 않습니다.

HTTP 200, JSON MIME, 숫자형 `statusCode === 200`, `result.statDataList` 배열을 확인한 뒤 상태·길이·해시·타입을 출력합니다. 실제 통계 데이터가 필요한 경우 `--data`를 추가하세요. 실패 응답의 본문·인증값·리다이렉트 대상은 오류 로그에 출력하지 않습니다. 기본 요청 제한은 20초·5 MiB, 일시적인 429/502/503/504 재시도는 최대 1회입니다. 긴 Retry-After는 보류하며 로그인 실패·403·리다이렉트는 재시도하지 않습니다. 자동 로그인과 세션 갱신은 별도 미구현 기능입니다.

오프라인 검사와 대기열 상태:

```powershell
node --test
node tools/discovery/frontier.mjs
```

`frontier.mjs`는 큐 관리 도구이며 자동 브라우저 탐색기나 실행 중인 수집기가 아닙니다. 현재 공통 실패 경계가 기록되어 있어 CLI의 실행 가능한 다음 노드 목록은 비어 있습니다. 복구 전에는 API·네트워크 관측 상태를 성공으로 바꾸지 않습니다.

## 파일 안내

- `scripts/client.mjs`, `scripts/cli.mjs`: 독립 HTTP 조회 55개와 CLI.
- `scripts/stat-client.mjs`: 기존 stdin `{url}` 호출 형식의 진입점.
- `tests/`: 합성 응답으로 검증하는 오프라인 테스트; 라이브 검증 아님.
- `references/api-catalog.json`: 최초 관측 계약 23개.
- `references/resumed-contracts.json`: 연결 복구 뒤 추가 관측 21개(JSONL 메타데이터를 JSON 배열로 변환).
- `references/current-contracts.json`: 이번 로그인에서 관측한 통계 계약 55개.
- `references/implemented-operations.json`: 구현·인증 전달·실검증 상태를 구분한 작업 목록.
- `evidence/stat-replay.json`, `evidence/resumed-replays.json`: 당시 검증 기록.
- `evidence/live-replays-2026-09-13.json`: 이번 독립 CLI 검증 22개.
- `discovery/stat-navigation-2026-09-13.json`: 화면 탐색 중단 전 관측한 통계 문서와 부모 관계.
- `discovery/frontier.json`, `discovery/coverage.json`: 재개 대기열, 부모 관계, 현재 공통 실패 경계.
- `tools/discovery/`: 정상 HTTP 실행과 분리된 큐/관측 병합 코드.
- `discovery/`의 나머지 파일: 원본 탐색 지도와 당시 수집 상태.
- `docs/history-2026-09-06.md`: 시간순 원본 작업 기록.

`discovery/resume-status.json`의 `collectorActive: true`는 2026-09-06 시점의 기록입니다. 현재 작동 상태가 아닙니다. 지속 실행 가능한 네이버 전용 수집기 소스는 원본 산출물에 없었습니다. Chrome 프로필이나 세션을 이 저장소에 포함하지 않습니다.

`IMPORT.json`의 파일 해시는 최초 Git 반입 시점의 기록입니다. 이후 구현 변경으로 현재 파일 해시와 다를 수 있습니다.

## 남은 작업

HTTP 전용 실행기의 일회성 세션 전달과 실제 탐색 검증, 추가 33개 API 독립 재현, 남은 관리 메뉴·iframe·컨트롤의 HTTP 탐색, 미관측 읽기 계약 추가, 로그인·세션 갱신. 글·설정 쓰기는 요청 대상과 내용을 별도로 확정한 경우에만 검증합니다.
