# Mini Redis

해시 테이블을 직접 구현한 인메모리 키-값 저장소입니다. HTTP로 JSON 값을 저장하고 조회하며, TTL 또는 `DELETE`로 무효화할 수 있습니다. Python 3.10 이상과 표준 라이브러리만 필요합니다.

## 실행

저장소 루트에서 서버를 실행합니다. 기본 주소는 `127.0.0.1:8000`입니다. 다른 호스트에서 접근하는 실습 환경에서는 `--host 0.0.0.0`으로 실행할 수 있습니다.

```powershell
python -m mini_redis
```

다른 PowerShell 창에서 값을 저장하고 조회한 뒤 삭제합니다.

```powershell
$key = 'http://127.0.0.1:8000/v1/keys/demo'
Invoke-RestMethod -Method Put -Uri $key -ContentType 'application/json' -Body '{"value":{"count":1},"ttl_seconds":30}'
Invoke-RestMethod -Method Get -Uri $key
Invoke-RestMethod -Method Delete -Uri $key
```

| 요청 | 동작 | 응답 |
| --- | --- | --- |
| `PUT /v1/keys/{key}` | `value`를 저장하고 `ttl_seconds`로 만료를 설정합니다. | 생성 `201`, 덮어쓰기 `204` |
| `GET /v1/keys/{key}` | 현재 값을 `{"value": ...}`로 반환합니다. | 성공 `200`, 키 없음 또는 만료 `404` |
| `DELETE /v1/keys/{key}` | 현재 키를 즉시 무효화합니다. | 삭제 `204`, 키 없음 또는 만료 `404` |

키는 비어 있지 않은 UTF-8 문자열을 URL의 한 경로 세그먼트로 인코딩합니다. 예를 들어 `a/b`는 `a%2Fb`로 요청합니다. `PUT`은 최대 1 MiB의 UTF-8 JSON 본문을 받습니다. `value`는 `null`을 포함한 JSON 값이며 `ttl_seconds`는 양의 유한한 초 단위 숫자입니다. TTL을 생략하거나 `null`로 저장하면 만료 없이 유지됩니다. 덮어쓰기는 값과 만료 시각을 함께 교체합니다.

## 해시 테이블과 동시성

- `_HashTable`은 빈 버킷 8개로 시작합니다. `hash(key) % 버킷 수`로 버킷을 선택하고, 같은 버킷에 배정된 키는 리스트에 함께 둡니다. 버킷 안에서 키를 비교하므로 해시가 충돌해도 값을 구별할 수 있습니다.
- `_HashTable.get`은 선택한 버킷을 검색합니다. `_HashTable.set`은 해당 키의 항목을 교체하거나 새 항목을 추가합니다. 저장 항목 수가 버킷 수의 75%를 넘으면 `_grow`가 버킷 수를 두 배로 늘리고 기존 항목을 재배치합니다. `_HashTable.delete`는 키를 찾아 항목을 제거하고 항목 수를 줄입니다.
- 해시가 고르게 분포하면 조회·삭제의 평균과 삽입의 분할 상환 평균은 키 해시·비교 비용을 제외하고 `O(1)`입니다. 키가 한 버킷에 몰리거나 테이블을 확장하는 연산은 `O(n)`까지 걸릴 수 있습니다.
- HTTP 서버는 여러 요청을 스레드에서 처리합니다. 공유 `Store`의 단일 잠금이 각 연산의 검색, 수정, 만료 판정과 확장을 보호합니다. 본문 읽기와 응답 전송은 잠금 밖에서 처리합니다. 별개의 HTTP 요청을 묶는 트랜잭션은 제공하지 않습니다.
- `Store.set`은 단조 시계로 만료 시각을 정합니다. `Store.get`은 만료 시각에 도달한 항목을 같은 잠금 안에서 제거하고 키가 없다고 응답합니다. `Store.delete`는 만료된 항목도 제거하며, API 응답은 `404`입니다.

## 예제 API와 성능 비교

Mini Redis를 실행해 둔 상태에서 다른 터미널에서 예제 API를 실행합니다.

```powershell
python -m examples.report_api
```

`GET http://127.0.0.1:8001/v1/report`의 첫 호출은 50ms 지연을 둔 데이터 조회를 수행하고, 응답을 Mini Redis에 30초 동안 저장합니다. 그다음 호출은 캐시에서 응답을 가져옵니다. 쿼리 `?cache=off`를 붙이면 매번 원본 조회를 수행합니다. Mini Redis의 `/v1/keys/sample-report`에 `DELETE`를 보내면 다음 호출이 원본에서 다시 읽습니다.

```powershell
python -m examples.benchmark --requests 30
python -m unittest discover -s tests -v
```

벤치마크는 캐시를 먼저 채우고, 캐시 미사용 요청과 캐시 적중 요청을 번갈아 실행합니다. 같은 응답 데이터인지 확인한 뒤 각 중앙값과 배율을 출력합니다. 측정치는 로컬 HTTP 왕복과 인위적인 원본 조회 지연을 포함합니다.

## 한계

- 데이터는 단일 프로세스의 메모리에 있으며 서버를 재시작하면 사라집니다. 영속성을 추가한다면 응답 전에 변경 로그를 디스크에 동기화하고, 재시작 시 만료 시각을 고려해 로그를 재생하는 방식이 가능합니다.
- 만료된 키는 해당 키의 조회·삭제·덮어쓰기 시에만 메모리에서 정리됩니다. 메모리 상한이나 백그라운드 만료 정리는 없습니다.
- 실습용 HTTP/JSON API입니다. Redis의 RESP 프로토콜, 인증, TLS는 제공하지 않습니다.
