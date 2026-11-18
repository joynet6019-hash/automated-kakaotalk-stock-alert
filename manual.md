# 주식 시세 카카오톡 자동 알림 구축·운영 매뉴얼

이 문서는 `stock-kakao-alert`와 유사한 프로젝트를 Windows에서 처음 구축하여 운영 알림을
받기까지의 전체 순서와, 마지막에 **수동 발송은 성공하지만 예약 알림이 계속 오지 않았던 문제를
진단하고 Supabase Cron 외부 트리거로 해결한 과정**을 정리한 재현용 매뉴얼이다.

예시의 키, 토큰, 프로젝트 참조값, 저장소 소유자 이름은 모두 자리표시자다. 실제 값을 소스코드,
README, 터미널 캡처, GitHub 커밋 또는 채팅에 붙여 넣지 않는다.

## 1. 완성 구조

```text
Supabase Cron 또는 GitHub schedule
              │
              ▼
GitHub Actions stock-alert.yml
              │
       ┌──────┴──────┐
       ▼             ▼
KIS 실전 시세      Supabase
3종목 순차 조회    가격·실행·암호화 토큰
       │             │
       └──────┬──────┘
              ▼
카카오톡 나와의 채팅 1건
```

기본 종목은 다음 세 개다.

- SK하이닉스 `000660`
- 삼성전자 `005930`
- 대한항공 `003490`

운영 원칙은 다음과 같다.

- 주문·매수·매도 API는 사용하지 않는다.
- 실제 시세 조회 실패 시 Mock으로 자동 전환하지 않는다.
- 세 종목을 모두 조회한 뒤 카카오 메시지 한 건을 보낸다.
- 카카오 성공 응답을 확인한 뒤에만 직전 정상 알림 가격을 확정한다.
- Supabase 장애, KIS 장애, 휴장일, 중복 슬롯이면 발송하지 않는다.
- 카카오 요청 결과가 불확실하면 자동 재발송하지 않는다.
- `.env`, 토큰 파일, 키와 암호화 키는 Git에 올리지 않는다.

## 2. 준비물

- Windows 10/11와 PowerShell
- Python 3.12
- Git 및 GitHub 저장소
- 한국투자증권 Open API 실전 App Key와 App Secret
- Kakao Developers 애플리케이션
- Supabase 프로젝트

모든 PowerShell 명령은 저장소 루트에서 실행한다. 경로가 다르면 먼저 이동한다.

```powershell
cd C:\Projects\stock-kakao-alert
```

`C:\Users\user` 같은 다른 폴더에서 명령을 실행하면 `not a git repository`, 스크립트 파일 없음,
다른 가상환경 사용 등의 오류가 발생한다.

## 3. 프로젝트와 Python 환경 준비

새 사용자는 저장소를 먼저 복제한다. 이미 GitHub Desktop으로 복제했다면 이 단계는 생략한다.

```powershell
git clone https://github.com/<OWNER>/stock-kakao-alert.git C:\Projects\stock-kakao-alert
```

```powershell
cd C:\Projects\stock-kakao-alert
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pytest -q
```

반드시 프로젝트의 가상환경 Python을 사용한다. 다음 명령은 시스템 Python에 `pytest`가 없으면
실패할 수 있다.

```powershell
# 권장하지 않음
python -m pytest -q
```

현재 프로젝트 전체 테스트의 기준 결과는 다음과 같다.

```text
253 passed
```

`.gitignore`에는 최소한 아래 항목이 있어야 한다.

```gitignore
.env
.env.*
!.env.example
.local/
.venv/
kis_tokens*.json
kis_tokens*.lock
tokens*.json
credentials*.json
*.pem
*.key
```

## 4. 로컬 환경변수 작성

```powershell
Copy-Item .env.example .env
```

`.env`에 아래 이름을 사용한다. 값은 예시 자리표시자 대신 직접 입력한다.

```dotenv
APP_MODE=mock
STATE_PATH=.local/mock_state.json

KIS_ENV=real
KIS_APP_KEY=<KIS_APP_KEY>
KIS_APP_SECRET=<KIS_APP_SECRET>

KAKAO_REST_API_KEY=<KAKAO_REST_API_KEY>
KAKAO_CLIENT_SECRET=<사용할 때만 입력>
KAKAO_CLIENT_SECRET_ENABLED=true
KAKAO_REDIRECT_URI=http://localhost:8000/callback
KAKAO_MESSAGE_LINK_URL=https://<카카오에 등록한 도메인>

STORAGE_BACKEND=local
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TOKEN_ENCRYPTION_KEY=

ENABLE_SCHEDULED_SEND=false
MAX_SCHEDULE_LATENESS_MINUTES=20
```

카카오 앱에서 Client Secret을 사용하지 않으면 다음과 같이 맞춘다.

```dotenv
KAKAO_CLIENT_SECRET=
KAKAO_CLIENT_SECRET_ENABLED=false
```

프로세스 환경변수가 `.env`보다 우선한다. 오래된 PowerShell 환경변수가 남아 있으면 `.env`를
고쳐도 다른 값이 사용될 수 있다.

## 5. Mock과 오프라인 테스트

실제 API 키 없이 먼저 프로그램 구조를 검증한다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\test_kis.py --mode mock
.\.venv\Scripts\python.exe -X utf8 scripts\stock_alert.py --mode mock
.\.venv\Scripts\python.exe -m pytest -q
```

Mock 실행은 실제 KIS·카카오 API를 호출하지 않고 알림 이력을 확정하지 않는다.

## 6. 한국투자증권 KIS 실전 조회 연결

1. 한국투자증권 Open API에서 실전투자 App Key와 App Secret을 발급한다.
2. `.env`에 `KIS_ENV=real`과 두 키를 입력한다.
3. 실제 조회만 실행한다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\test_kis.py --mode live
```

성공하면 세 종목의 현재가, 전일 종가, 전일 대비 금액·등락률, 조회 완료 시각과
`출처: kis_api`가 표시된다. 이 명령은 카카오 메시지를 보내지 않는다.

프로젝트의 KIS 안전장치는 다음과 같다.

- 동일 실행에서 종목별 한 번씩 순차 조회
- 요청 시작 사이 기본 1.5초 간격
- 유효한 접근 토큰 로컬/Supabase 캐시 재사용
- `EGW00201`에만 2초, 4초, 8초 지수 백오프
- 인증 오류와 다른 API 오류는 무조건 재시도하지 않음
- 키, Secret, 접근 토큰 원문은 로그에 표시하지 않음

`HTTP 403`이 반복되면 App Key 환경, `KIS_ENV`, 실전/모의 서버 조합과 토큰 캐시를 확인한다.
`EGW00201`이면 같은 키를 사용하는 다른 프로그램을 중지하고 동시에 여러 테스트를 실행하지 않는다.

## 7. 카카오 OAuth와 나와의 채팅 연결

Kakao Developers에서 다음을 설정한다.

1. 애플리케이션 생성
2. REST API 키 확인
3. Redirect URI에 `http://localhost:8000/callback` 등록
4. 카카오 로그인 동의항목에서 `talk_message` 권한 사용
5. 제품 링크 관리에 `KAKAO_MESSAGE_LINK_URL`의 도메인 등록
6. Client Secret을 켰다면 `.env`의 Secret과 `KAKAO_CLIENT_SECRET_ENABLED=true`를 일치시킴

최초 OAuth 인증은 사용자 승인 후에만 실행한다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\kakao_auth.py --authorize
```

브라우저에서 로그인과 `talk_message` 동의를 마치면 localhost 콜백이 `state`를 검증하고 토큰을
로컬 안전 저장소에 저장한다. 인가 코드와 토큰 원문은 출력하지 않는다.

실제 테스트 메시지 한 건은 다음 명령으로만 보낸다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\test_kakao.py --send
```

`HTTP 401`, `KOE010`이면 대부분 Client Secret 사용 설정과 값이 다르다. 앱 설정, `.env`의
`KAKAO_CLIENT_SECRET_ENABLED`, `KAKAO_CLIENT_SECRET`, 기존 프로세스 환경변수를 함께 확인한 후
OAuth를 다시 실행한다.

## 8. KIS와 카카오 통합 알림 로컬 검증

실제 KIS 시세를 조회하되 카카오를 보내지 않는 기본 미리보기다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\stock_alert.py --mode live
```

XKRX 거래일에 사용자 승인을 거쳐 실제 한 건을 보낼 때만 `--send`와 슬롯을 함께 사용한다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\stock_alert.py --mode live --send --slot 09:30
```

발송 성공 후에만 로컬 이력에 세 종목 가격이 저장된다. 최초 성공 발송은 직전 이력이 없으므로
`비교 데이터 없음`으로 표시되고 다음 정상 발송부터 직전 알림 대비 변동률이 표시된다.

## 9. Supabase 스키마 설치

1. Supabase에서 새 프로젝트를 만든다.
2. 프로젝트 URL과 서버용 secret 또는 legacy `service_role` 키를 확인한다.
3. SQL Editor에서 `supabase/schema.sql` **파일 내용 전체**를 실행한다.

Windows에서 SQL 내용을 클립보드로 복사하려면 다음 명령을 **PowerShell에서** 실행한다.

```powershell
cd C:\Projects\stock-kakao-alert
Get-Content -Raw .\supabase\schema.sql | Set-Clipboard
```

그다음 Supabase SQL Editor에서 `Ctrl+V` 후 Run을 누른다. 다음 PowerShell 명령 자체를 SQL
Editor에 붙여 넣으면 `syntax error at or near "Get"` 또는 `"supabase"` 오류가 난다.

```text
Get-Content -Raw ... | Set-Clipboard   ← SQL이 아니므로 SQL Editor에서 실행하지 않음
```

기존 프로젝트를 단계적으로 업그레이드할 때는 필요한 마이그레이션을 파일 순서대로 적용한다.

```text
supabase/migrations/20261015_execution_status.sql
supabase/migrations/20261109_fix_execution_status_coalesce.sql
supabase/migrations/20261109_add_test_alert_slots.sql
```

각 파일도 `Get-Content -Raw <파일> | Set-Clipboard`는 PowerShell에서 실행하고, 클립보드에 복사된
SQL 본문만 SQL Editor에 붙여 넣는다.

## 10. Supabase 암호화 키와 연결 설정

암호화 키는 프로그램이 `.env`에 직접 기록하게 한다. 원문을 터미널에 출력하지 않는다.

```powershell
.\.venv\Scripts\python.exe scripts\create_encryption_key.py --write
```

`.env`를 다음과 같이 바꾼다.

```dotenv
STORAGE_BACKEND=supabase
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-secret-or-service-role-key>
TOKEN_ENCRYPTION_KEY=<생성된 기존 값 유지>
```

암호화 키를 잃거나 바꾸면 Supabase의 기존 카카오·KIS 토큰을 복호화할 수 없다. 운영 중 새 키를
무작정 만들지 말고 안전하게 백업한다.

## 11. Supabase 실제 통합 테스트

다음 명령은 테스트 전용 테이블에만 고유 UUID 데이터를 INSERT/SELECT/DELETE한다. 운영 가격 이력과
실제 카카오 토큰은 변경하지 않고 카카오 메시지를 보내지 않는다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\test_supabase.py --live
```

검증 항목은 다음과 같다.

- Supabase 연결과 운영 이력 읽기
- RLS 활성화 및 anon/authenticated 직접 접근 차단
- 테스트 전용 가격 INSERT/SELECT/DELETE
- 직전 알림 가격 조회와 변동률 계산
- 동일 거래일·슬롯 중복 claim 차단
- 합성 카카오 형식 토큰 암호화 저장·복구
- 테스트 종료 후 운영 이력 불변 확인

## 12. 운영 토큰을 Supabase로 이전

로컬 OAuth와 KIS 토큰이 정상이고 Supabase 테스트가 끝난 뒤 명시적으로 업로드한다.

```powershell
.\.venv\Scripts\python.exe scripts\sync_tokens.py --upload
```

토큰은 `TOKEN_ENCRYPTION_KEY`로 암호화된 상태로 저장되며 기존 원격 토큰은 덮어쓰지 않는다.
운영 카카오 토큰을 읽기 전용으로 확인한다.

```powershell
.\.venv\Scripts\python.exe scripts\check_kakao_token.py
```

이 명령은 토큰을 갱신하거나 메시지를 보내지 않고 사용 가능 여부만 표시한다.

## 13. GitHub Actions 설정

워크플로 파일은 `.github/workflows/stock-alert.yml`이다. 기본 브랜치에 반영해야 `Run workflow`와
`schedule` 이벤트가 동작한다.

### 13.1 Repository Secrets

GitHub 저장소에서 **Settings → Secrets and variables → Actions → Secrets → New repository secret**로
다음을 등록한다.

| 이름 | 용도 |
|---|---|
| `KIS_APP_KEY` | KIS 실전 시세 인증 |
| `KIS_APP_SECRET` | KIS 실전 시세 인증 |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 Supabase RPC |
| `TOKEN_ENCRYPTION_KEY` | 로컬 토큰 업로드 때 사용한 동일한 Fernet 키 |
| `KAKAO_REST_API_KEY` | 토큰을 발급한 카카오 앱 REST 키 |
| `KAKAO_CLIENT_SECRET` | 카카오 Client Secret을 사용하는 경우만 |

URL 값을 Secret으로 관리하려면 `SUPABASE_URL`, `KAKAO_REDIRECT_URI`,
`KAKAO_MESSAGE_LINK_URL`도 같은 이름으로 등록할 수 있다. 보통 URL은 Variables가 편리하다.

### 13.2 Repository Variables

**Settings → Secrets and variables → Actions → Variables**에 등록한다.

| 이름 | 권장 값 |
|---|---|
| `KIS_ENV` | `real` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `KAKAO_CLIENT_SECRET_ENABLED` | `true` 또는 `false` |
| `KAKAO_REDIRECT_URI` | `http://localhost:8000/callback` |
| `KAKAO_MESSAGE_LINK_URL` | 카카오 제품 링크 관리에 등록한 URL |
| `ENABLE_SCHEDULED_SEND` | 검증 중 `false`, 운영 시 `true` |
| `MAX_SCHEDULE_LATENESS_MINUTES` | `20` |

KIS·카카오 액세스 토큰이나 리프레시 토큰은 GitHub Secrets에 직접 등록하지 않는다. Supabase에
암호문으로 저장하고 Actions 실행 중에만 복호화한다.

## 14. GitHub Actions 수동 검증

코드를 기본 브랜치에 Push한 후 기존 실패 실행의 **Re-run jobs**를 누르지 않는다. Actions에서
**Stock alert → Run workflow**를 눌러 새 실행을 만든다.

### 안전한 dry-run

- Branch: 기본 브랜치 `main`
- `delivery_mode`: `dry-run`
- `approve_send`: 체크하지 않음
- `slot`: 점검할 슬롯

dry-run은 KIS 실전 시세와 Supabase 연결을 확인하지만 카카오를 보내거나 가격 이력을 확정하지 않는다.

### 실제 수동 발송

XKRX 거래일에만 다음 두 승인을 함께 사용한다.

- `delivery_mode=send`
- `approve_send=true`

Job Summary에서 녹색 `Success`만 보지 말고 다음을 확인한다.

```text
최종 delivery = sent
사유 = sent_and_state_committed
KRX 상태 = open
```

`Success`는 워크플로가 오류 없이 끝났다는 뜻일 뿐, 휴장·중복·지연 정책으로 실제 발송을 생략한
경우에도 나타날 수 있다.

## 15. GitHub 기본 예약 실행

한국은 UTC+9이고 일광절약시간을 사용하지 않는다.

| KST | UTC cron |
|---|---|
| 09:30 | `30 0 * * 1-5` |
| 12:30 | `30 3 * * 1-5` |
| 15:20 | `20 6 * * 1-5` |

프로젝트에는 전달 문제를 관찰하기 위해 `11:30`, `13:30`, `14:30`, `15:00` 임시 슬롯도 추가했던
이력이 있다. 유사 프로젝트의 정상 운영에는 원래 세 슬롯만 사용하는 것을 권장한다.

예약 실행은 다음을 모두 통과해야 한다.

- 기본 브랜치의 workflow `schedule`
- `ENABLE_SCHEDULED_SEND=true`
- XKRX 정상 거래일
- 슬롯부터 `MAX_SCHEDULE_LATENESS_MINUTES` 이내
- Supabase에 같은 날짜·슬롯의 완료/미확정 claim 없음
- KIS 세 종목 조회 성공
- Supabase 및 카카오 토큰 사용 가능

## 16. 실행 상태와 누락 진단

하루 전체 슬롯을 읽기 전용으로 검사한다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\check_alert_status.py
```

특정 날짜와 슬롯을 검사한다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\check_alert_status.py --date 2026-11-18 --slot 09:30
```

환경, XKRX, 연결, 인증, DB 객체와 상태 RPC를 단계별로 진단한다.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\check_alert_status.py --diagnose --date 2026-11-18
```

주요 상태의 의미는 다음과 같다.

| 상태 | 의미 |
|---|---|
| `pending` | 발송 처리 중 또는 미완료 |
| `sent` | 카카오 성공과 가격 이력 확정 완료 |
| `skipped` | 휴장·지연·중복 정책에 따라 미발송 |
| `failed` | 설정/API/DB 오류로 미발송 |
| `not_due` | 아직 해당 슬롯 시각 전 |

Supabase 실행 상태 SQL이 오래되어 `pg_catalog.coalesce` 관련 오류가 나면
`20261109_fix_execution_status_coalesce.sql`을 적용한다. SQL 적용 전후에 운영 행을 임의로 삭제하지 않는다.

## 17. 중요 장애 사례: 수동 발송은 되지만 예약 알림이 계속 안 온 문제

이 절은 실제 완료 과정에서 가장 중요했던 장애 처리 기록이다.

### 17.1 관찰된 증상

1. 로컬 KIS 실전 조회 성공
2. 로컬 및 GitHub Actions 수동 카카오 발송 성공
3. Supabase 통합 테스트와 토큰 점검 성공
4. GitHub Actions 예약 실행 화면은 일부 `Success`
5. 12:30 실행은 다음 로그와 함께 미발송

   ```text
   [안전 건너뜀] 예약 시각의 허용 지연 범위를 벗어나 실행을 건너뜁니다.
   ```

6. 다음 거래일 09:30에는 GitHub 예약 실행 자체가 보이지 않거나 알림이 오지 않음
7. 수동 승인 발송은 계속 정상

### 17.2 원인 분리

- 12:30 미발송은 runner가 시작될 때 이미 기본 20분 지연 한도를 넘어서 안전 차단된 경우였다.
- 09:30 미수신 중 일부는 GitHub `schedule` 이벤트 자체가 생성되지 않은 경우였다.
- GitHub Actions의 예약 이벤트는 부하로 지연될 수 있고, 부하가 충분히 크면 대기 작업이 누락될 수 있다.
- `schedule` 이벤트가 아예 생성되지 않으면 프로젝트 내부 Python, Supabase 상태 기록, Job Summary도
  실행되지 않으므로 내부 코드만으로는 그 누락을 감지하거나 복구할 수 없다.
- 녹색 `Success`는 실제 발송 성공과 동일하지 않았다. Job Summary의 `final delivery=sent` 확인이 필요했다.

GitHub 공식 문서도 예약 이벤트가 고부하 시 지연되거나 일부 대기 작업이 누락될 수 있고, 기본
브랜치에 있는 workflow만 예약 실행된다고 명시한다.

### 17.3 처음 시도한 외부 트리거가 동작하지 않았던 이유

Supabase SQL Editor에서 다음 조회가 실패했다.

```sql
select * from cron.job;
```

```text
ERROR: relation "cron.job" does not exist
```

이는 Job이 없는 상태가 아니라 **`pg_cron` 확장 자체가 활성화되지 않은 상태**다. Supabase Dashboard의
Integrations 또는 Database Extensions에서 Cron/`pg_cron`을 먼저 활성화해야 한다.

활성화 후 조회가 `0 rows`이면 확장은 설치됐지만 등록된 Job이 하나도 없다는 뜻이다.

```sql
select jobid, jobname, schedule, active
from cron.job
order by jobname;
```

Vault 조회가 `0 rows`이면 함수 URL과 공유 Secret이 아직 저장되지 않은 것이다.

```sql
select name, created_at
from vault.secrets
where name in ('stock_alert_function_url', 'stock_alert_cron_secret')
order by name;
```

Edge Function 화면에 기본 `Hello` 예제만 있거나 Custom secrets가 비어 있으면 GitHub API 호출 코드와
인증정보가 아직 배포되지 않은 상태다. 이 세 가지가 모두 준비되어야 외부 트리거가 완성된다.

## 18. 최종 해결: Supabase Cron → Edge Function → GitHub workflow_dispatch

GitHub 내부 예약과 다른 독립 스케줄러인 Supabase Cron이 정해진 시각에 Edge Function을 호출하고,
Edge Function이 GitHub의 `workflow_dispatch` API를 호출하도록 구성했다.

```text
Supabase pg_cron
  → private.dispatch_stock_alert(slot)
  → pg_net HTTPS POST
  → Supabase Edge Function
  → GitHub workflow_dispatch
  → 기존 KRX/KIS/Supabase/Kakao 안전장치
```

### 18.1 GitHub 외부 호출용 토큰

GitHub에서 fine-grained token을 만든다.

- Repository access: 대상 저장소만
- Repository permissions: `Actions: Read and write`
- 가능한 짧은 만료기간 설정 후 주기적으로 교체

GitHub의 workflow dispatch API는 fine-grained token에 Actions write 권한을 요구한다.

### 18.2 Edge Function Secrets

Supabase **Edge Functions → Secrets**에 다음 값을 저장한다.

| 이름 | 값 |
|---|---|
| `GH_ACTIONS_TOKEN` | 위 fine-grained GitHub token |
| `GH_OWNER` | GitHub 저장소 소유자 |
| `GH_REPO` | 저장소 이름 |
| `GH_WORKFLOW_FILE` | `stock-alert.yml` |
| `GH_REF` | `main` |
| `STOCK_ALERT_CRON_SECRET` | 임의의 긴 공유 Secret |

Secret 원문은 함수 로그나 응답에 출력하지 않는다.

### 18.3 Edge Function 코드

함수 이름 예시는 `swift-responder`다. 이름이 다르면 이후 URL도 같은 이름으로 바꾼다.

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_SLOTS = new Set(["09:30", "12:30", "15:20"]);
const MAX_LATENESS_MS = 20 * 60 * 1000;

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function insideKstWindow(slot: string, now = new Date()): boolean {
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const [hour, minute] = slot.split(":").map(Number);
  const scheduled = Date.UTC(
    kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(),
    hour, minute, 0, 0,
  );
  const delay = kstNow.getTime() - scheduled;
  return delay >= 0 && delay <= MAX_LATENESS_MS;
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

    const expected = required("STOCK_ALERT_CRON_SECRET");
    const received = req.headers.get("x-stock-alert-secret") ?? "";
    if (!received || received !== expected) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    let payload: { slot?: string; delivery_mode?: string };
    try {
      payload = await req.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const slot = payload.slot ?? "";
    const mode = payload.delivery_mode === "dry-run" ? "dry-run" : "send";
    if (!ALLOWED_SLOTS.has(slot)) {
      return json({ ok: false, error: "invalid_slot" }, 400);
    }
    if (mode === "send" && !insideKstWindow(slot)) {
      return json({ ok: false, error: "outside_lateness_window" }, 409);
    }

    const owner = required("GH_OWNER");
    const repo = required("GH_REPO");
    const workflow = required("GH_WORKFLOW_FILE");
    const ref = required("GH_REF");
    const token = required("GH_ACTIONS_TOKEN");
    const endpoint = `https://api.github.com/repos/${owner}/${repo}` +
      `/actions/workflows/${workflow}/dispatches`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({
        ref,
        inputs: {
          delivery_mode: mode,
          approve_send: mode === "send",
          slot,
        },
      }),
    });

    if (!response.ok) {
      return json({ ok: false, error: "github_dispatch", status: response.status }, 502);
    }
    return json({ ok: true, mode, slot });
  },
};
```

함수 설정에서 **Verify JWT with legacy secret는 OFF**로 두고 위의 공유 Secret 헤더 검증을 사용한다.
외부에 공개된 함수 URL만으로는 호출할 수 없도록 반드시 `x-stock-alert-secret`을 검사한다.

주의: 외부 호출은 GitHub에서 `workflow_dispatch`로 보인다. 현재 Python의 20분 지연 검사는 GitHub
`schedule` 이벤트에만 적용되므로, 위 Edge Function에서도 동일한 20분 지연 창을 적용했다.

### 18.4 필요한 Supabase 확장

Dashboard에서 Cron/`pg_cron`, `pg_net`, Vault가 활성화되어 있는지 확인한다. SQL로 확인할 수 있다.

```sql
select extname
from pg_extension
where extname in ('pg_cron', 'pg_net', 'supabase_vault')
order by extname;
```

### 18.5 Vault 값 저장

다음 두 값을 Supabase Vault에 저장한다.

- `stock_alert_function_url`:
  `https://<project-ref>.supabase.co/functions/v1/swift-responder`
- `stock_alert_cron_secret`: Edge Function의 `STOCK_ALERT_CRON_SECRET`과 동일한 값

예시는 다음과 같다.

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/swift-responder',
  'stock_alert_function_url'
);

select vault.create_secret(
  '<EDGE_FUNCTION과 동일한 긴 공유 Secret>',
  'stock_alert_cron_secret'
);
```

Secret 원문이 포함된 SQL을 캡처하거나 공유하지 않는다. 같은 이름을 반복 생성하지 말고, 교체할 때는
기존 Vault 항목을 확인하여 update/rotate 절차를 사용한다.

### 18.6 DB 전달 함수 생성

```sql
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.dispatch_stock_alert(p_slot text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  if p_slot not in ('09:30', '12:30', '15:20') then
    raise exception 'Invalid stock alert slot';
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'stock_alert_function_url'
  limit 1;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'stock_alert_cron_secret'
  limit 1;

  if v_url is null or v_secret is null then
    raise exception 'Stock alert trigger secret is not configured';
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-stock-alert-secret', v_secret
    ),
    body := jsonb_build_object(
      'slot', p_slot,
      'delivery_mode', 'send'
    ),
    timeout_milliseconds := 10000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function private.dispatch_stock_alert(text)
from public, anon, authenticated;
```

### 18.7 운영 Cron 등록

Supabase Cron도 UTC 기준으로 등록한다.

```sql
select cron.schedule(
  'stock-alert-0930',
  '30 0 * * 1-5',
  $$select private.dispatch_stock_alert('09:30');$$
);

select cron.schedule(
  'stock-alert-1230',
  '30 3 * * 1-5',
  $$select private.dispatch_stock_alert('12:30');$$
);

select cron.schedule(
  'stock-alert-1520',
  '20 6 * * 1-5',
  $$select private.dispatch_stock_alert('15:20');$$
);
```

진단 중 임시로 추가했던 `11:30`, `13:30`, `14:30`, `15:00` 슬롯은 전달 경로 확인용이었다.
운영 목표가 원래 세 슬롯이면 임시 Job을 제거하고 위 세 개만 유지한다.

### 18.8 외부 트리거 검증

Cron 등록 상태:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname like 'stock-alert-%'
order by jobname;
```

정상이라면 세 행과 `active=true`가 보인다. Job 실행 이력:

```sql
select jobid, status, return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 20;
```

Edge Function 로그에서 호출 성공 여부를 확인하고, GitHub Actions에는 이벤트가 `workflow_dispatch`
또는 `Manually run`으로 나타나는 것이 정상이다. Job Summary의 `최종 delivery=sent`와 실제 카카오
수신을 함께 확인한다.

실제 완료 과정에서는 `cron.job`에 등록한 Job들이 `active=true`로 확인됐고, Edge Function 호출 뒤
새 GitHub workflow run이 생성됐으며 최종적으로 예약 카카오 알림 수신까지 확인했다. 이 세 단계가
모두 확인되어야 “Cron 등록 완료”가 아니라 “종단 간 자동 발송 완료”로 판정한다.

수동으로 `private.dispatch_stock_alert('09:30')`를 실행하면 실제 발송 승인 workflow가 시작될 수
있으므로 단순 연결 점검 용도로 실행하지 않는다. Edge Function 자체를 시험할 때는 본문의
`delivery_mode=dry-run`을 사용한다.

## 19. 두 스케줄러를 함께 둘 때의 주의사항

GitHub `schedule`과 Supabase Cron을 모두 켜면 같은 슬롯에 두 실행이 생성될 수 있다. Supabase의
`stock_alert_runs` 고유키가 실제 중복 발송을 차단하지만, 두 실행이 KIS 조회까지 동시에 진행하면
불필요한 API 호출과 `EGW00201` 위험이 생긴다.

운영 권장안은 다음 중 하나다.

1. Supabase Cron을 주 스케줄러로 사용하고 GitHub `schedule`을 주석 처리한다.
2. GitHub `schedule`을 주 스케줄러로 두고 Supabase Cron은 발송이 아닌 읽기 전용 watchdog으로 쓴다.
3. 둘을 이중화하려면 서로 다른 지연 시간과 명시적인 선행 상태 확인을 추가한다.

`ENABLE_SCHEDULED_SEND`는 GitHub의 `schedule` 경로만 제어한다. Supabase Edge Function이 보내는
`workflow_dispatch`는 `delivery_mode=send`와 `approve_send=true`를 직접 전달하므로 이 Variable이
`false`여도 별도 승인 경로로 동작한다. 외부 Cron을 끄려면 Supabase Cron Job도 비활성화해야 한다.

## 20. 최종 정상 판정 체크리스트

- [ ] `.env`, 토큰, 키가 Git 추적에 포함되지 않음
- [ ] `python -m pytest -q` 전체 통과
- [ ] KIS 세 종목 실전 조회 성공
- [ ] 카카오 OAuth 및 테스트 메시지 성공
- [ ] 통합 알림 미리보기 성공
- [ ] Supabase 격리 통합 테스트 성공
- [ ] 운영 카카오 토큰 읽기 전용 점검 성공
- [ ] GitHub 새 dry-run 성공
- [ ] 수동 승인 발송의 Job Summary가 `sent`
- [ ] XKRX 휴장일 차단 확인
- [ ] 같은 날짜·슬롯 두 번째 발송 차단 확인
- [ ] Supabase Cron Job이 `active=true`
- [ ] Edge Function 호출 뒤 새 GitHub workflow run 생성 확인
- [ ] 실제 예약 시각에 카카오 수신 확인
- [ ] 첫 정상 발송 뒤 다음 발송에서 직전 알림 대비 값 표시

## 21. 자주 발생한 오류 요약

| 증상 | 원인과 처리 |
|---|---|
| `No module named pytest` | 시스템 Python이 아니라 `.\.venv\Scripts\python.exe` 사용 |
| `not a git repository` | `cd C:\Projects\stock-kakao-alert` 후 실행 |
| 스크립트 파일 없음 | 프로젝트 루트가 아닌 폴더에서 실행함 |
| `KOE010` | 카카오 Client Secret 사용 설정·값·환경변수 우선순위 확인 후 재인증 |
| KIS HTTP 403 | 실전/모의 키와 `KIS_ENV`, 토큰 캐시, 발급 제한 확인 |
| `EGW00201` | 병렬 실행 중지, 순차 조회와 백오프 유지 |
| Supabase 401/403 | anon 키가 아닌 서버 키, RLS/RPC 권한, URL 확인 |
| RPC 404/42883 | 최신 schema/migration 적용, Data API reload 확인 |
| SQL syntax near `Get`/`supabase` | PowerShell 명령을 SQL Editor에 붙임. 복사된 SQL 본문만 실행 |
| `relation cron.job does not exist` | `pg_cron` 미활성. Supabase Cron 확장 활성화 |
| `cron.job` 조회가 0 rows | 확장은 있으나 Job 미등록. `cron.schedule` 실행 |
| Vault 조회가 0 rows | 함수 URL/공유 Secret 미생성 |
| Actions가 녹색인데 알림 없음 | Job Summary의 `delivery`, 휴장·지연·중복 사유 확인 |
| Actions 실행 자체가 없음 | GitHub schedule 누락 가능. 독립 Supabase Cron/외부 watchdog 사용 |
| `not_due` | 아직 슬롯 시각 전이므로 정상 |
| `reserved`가 계속 남음 | 발송 여부 불확실. 카카오 수신부터 확인하고 자동 삭제·재발송 금지 |

## 22. 참고 문서

- [한국투자증권 Open API 공식 저장소](https://github.com/koreainvestment/open-trading-api)
- [카카오 기본 메시지 템플릿](https://developers.kakao.com/docs/ko/message-template/default)
- [GitHub workflow_dispatch REST API](https://docs.github.com/en/rest/actions/workflows)
- [GitHub Actions 이벤트와 schedule 제약](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [Supabase Edge Function 예약 실행](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase Edge Function Secrets](https://supabase.com/docs/guides/functions/secrets)

