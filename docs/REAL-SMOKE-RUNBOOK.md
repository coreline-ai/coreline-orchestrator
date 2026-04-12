# Manual Real-Worker Smoke Runbook

## 목적

이 문서는 `bun run ops:smoke:real`를 운영자/개발자가 반복 실행할 때 필요한 preflight, 기록 방식, 성공/실패 판정 기준을 고정한다.

## 대상 명령

```bash
bun run ops:smoke:real:preflight
bun run ops:smoke:real
```

## 사전 조건

- `codexcode` binary가 PATH에 존재해야 한다.
- `command -v codexcode && codexcode --help`가 성공해야 한다.
- CodexCode 로그인 또는 provider 인증이 이미 유효해야 한다.
- 실행 머신이 allowlisted repo 접근 정책과 충돌하지 않아야 한다.
- 결과는 [`docs/REAL-SMOKE-REPORT-TEMPLATE.md`](./REAL-SMOKE-REPORT-TEMPLATE.md) 형식으로 남긴다.

## 권장 절차

1. preflight 실행

```bash
bun run ops:smoke:real:preflight
```

2. binary/help 확인

```bash
command -v codexcode && codexcode --help
```

3. 실제 smoke 실행

```bash
bun run ops:smoke:real
```

4. 결과를 report template에 기록

## 결과 판정

### success

- smoke JSON이 정상 출력된다.
- `jobStatus=completed` 또는 기대 terminal status로 끝난다.
- `workerStatus=finished` 또는 기대 terminal status로 끝난다.
- operator가 명시적인 auth/path 관련 blocker를 보지 않았다.

### failure

- binary 또는 auth 문제로 smoke가 시작되지 않는다.
- smoke command가 non-zero로 종료된다.
- expected result/log/artifact 조회가 실패한다.

### flaky

- 재실행 시 성공/실패가 번갈아 나타난다.
- 외부 provider 응답 지연/timeout 때문에 결과가 불안정하다.
- same input인데 latency/terminal outcome 편차가 크게 발생한다.

## 운영자 기록 규칙

- stdout/stderr 일부를 남긴다.
- job/worker/session terminal 상태를 적는다.
- flaky면 최소 2회 이상 재실행 여부를 같이 적는다.
- follow-up issue가 있으면 repro command와 관측 시간을 적는다.
