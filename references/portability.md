# 다른 환경에서 사용하기

## 이식 단위

공통 도구는 Node 24 ESM과 잠긴 npm 의존성(`parse5`, `tough-cookie`)을 사용합니다. 실행 경로는 `import.meta.url` 또는 명시적으로 받은 입력 경로를 기준으로 해석합니다. 원래 사용자의 `Documents` 폴더나 monorepo 설치에 의존하지 않습니다.

서비스 pack은 고정 시점의 별도 제품 코드입니다. 루트 의존성을 설치했다고 모든 pack 의존성이 설치되는 것은 아닙니다. 각 pack 루트의 `npm ci --ignore-scripts`를 따르세요. 네이버의 headless SDK가 필요한 작업은 해당 README에 따라 별도 브라우저 런타임도 준비해야 합니다.

| 기능 | Windows | macOS/Linux |
|---|---|---|
| HAR/HTML 정규화, frontier | Node 24 | Node 24 설계; 이 패키징에서 실행 여부는 verification 확인 |
| origin 제한 HTTP, JSON profile | Node 24 | Node 24 설계 |
| DPAPI 지속 저장 | 현재 Windows 사용자 | 사용할 수 없음 |
| stdin 메모리 세션 | 지원 | 지원 설계 |
| journal/lock | 로컬 파일시스템 | 로컬 파일시스템 설계 |
| Windows PowerShell 기반 pack 런처 | pack별 조건 | 대체 provider/런처 필요 |

## 인증은 코드와 별도로 이전

DPAPI CurrentUser 저장은 실행한 Windows 사용자 컨텍스트에 묶입니다. 일반적인 다른 PC/사용자 clone 절차에서는 정상 로그인/승인된 공급자로 인증을 새로 준비합니다. 인증 파일을 Git에 넣거나 기본 브라우저 프로필 전체를 복사하는 방식은 설치 기능에 포함하지 않습니다.

저장 위치를 변경할 때는 소비자와 공급자가 같은 `--store-dir`를 사용해야 합니다. 사용자 홈 기반 경로이므로 사용자 이름이 달라도 자동으로 계산됩니다. 보호 저장소와 그 잠금 폴더는 소스 저장소 밖에 두세요. 같은 PC의 작업 프로세스끼리만 lock을 공유하며 네트워크 분산 잠금을 제공하지 않습니다.

macOS/Linux의 core request는 provider가 stdin으로 JSON을 전달할 수 있습니다. 반복 실행 및 회전된 값의 재사용에는 OS Keychain/Secret Service 등 기존 보관함 adapter가 필요합니다. 이 저장소에는 해당 OS의 지속 저장 구현을 추가했다고 주장하지 않습니다. `ProtectedStore({provider:'memory'})`는 같은 프로세스 동안만 유지됩니다.

## 인코딩과 프로세스

- JSON은 UTF-8로 작성합니다. core profile/session 입력은 BOM을 제거합니다. 서비스 pack의 오래된 입력기는 서로 다를 수 있으므로 UTF-8 no-BOM이 가장 단순합니다.
- PowerShell 5의 기본 코드페이지는 Node의 UTF-8 stdout과 다를 수 있습니다. 새 DPAPI helper는 stdout을 UTF-8로 고정하고 입력은 base64 바이트를 stdin으로 받아 한글 손상을 줄입니다. base64 자체가 암호화는 아니며 디스크 저장은 DPAPI가 담당합니다.
- 비밀을 명령 인수에 넣지 않습니다. 다른 프로세스에 전달할 때 필요한 값만 stdin/승인된 보관함 인터페이스로 넘깁니다.
- CLI 파이프가 끊기거나 결과 필터가 빈 객체를 돌려도 로그인 만료로 단정하지 않습니다. status/type/필수 필드 존재 여부를 별도로 점검합니다.
- 숨은 PowerShell/helper 창은 `windowsHide` 등으로 처리합니다. 상호작용이 실제로 필요한 로그인만 보이게 열어야 합니다.

## 설치본 갱신

`install-skill.mjs`는 존재하는 폴더를 덮어쓰지 않습니다. 설치본에 사용자 변경이 있을 수 있기 때문입니다. 새 폴더에 버전 사본을 설치하고 비교한 뒤 에이전트의 스킬 경로를 갱신합니다. `.git`, `node_modules`, 인증·runtime 폴더는 복사하지 않으므로 새 위치에서 npm 설치가 필요합니다.

최신 서비스를 다시 묶을 때는 source commit과 파일 hash를 갱신하고 이식 변경을 따로 기록하세요. source hash와 packaged hash를 동일한 것으로 기록하면 수정 provenance를 잃습니다.
