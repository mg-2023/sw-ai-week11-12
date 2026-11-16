// mini-redis 테스트 페이지 스크립트
// 페이지와 API가 같은 서버(같은 주소)에서 나오므로 fetch("/keys/...")처럼 경로만 쓰면 된다.

// ----------------------------------------------------------------------
// 공통: API 호출
//   성공이면 JSON을 돌려주고, 실패(4xx/5xx)면 서버가 준 detail로 에러를 던진다.
// ----------------------------------------------------------------------
async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(formatDetail(data.detail) || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

// FastAPI 에러 형식 정리
//   400 / 404 / 503: detail이 문자열
//   422(입력 검증 실패): detail이 [{loc, msg, ...}, ...] 배열
function formatDetail(detail) {
  if (Array.isArray(detail)) {
    return detail.map((d) => `${d.loc.join(".")}: ${d.msg}`).join("\n");
  }
  return detail;
}

// 키를 URL 경로에 넣을 때 쓴다. 공백, 한글, ?, # 같은 문자를 안전하게 바꿔준다.
// '/'는 인코딩해도 서버 라우팅에서 경로 구분자로 처리되어 404가 나므로 미리 막는다.
function keyPath(key) {
  if (key.includes("/")) {
    throw new Error("키에 '/'는 쓸 수 없습니다");
  }
  return `/keys/${encodeURIComponent(key)}`;
}

function show(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "result " + (ok ? "ok" : "err");
}

// 폼 제출 공통 처리: 새로고침 막기 → handler 실행 → 결과/에러 표시
function onSubmit(formId, resultId, handler) {
  const form = document.getElementById(formId);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const [text, ok] = await handler(form);
      show(resultId, text, ok);
    } catch (err) {
      const prefix = err.status ? `[${err.status}] ` : "";
      show(resultId, prefix + err.message, false);
    }
  });
}

// ----------------------------------------------------------------------
// SET key value [EX ttl] [NX|XX]  →  PUT /keys/{key}
// ----------------------------------------------------------------------
onSubmit("set-form", "set-result", async (form) => {
  const key = form.key.value;
  const body = {
    value: form.value.value,
    nx: form.nx.checked,
    xx: form.xx.checked,
  };
  if (form.ttl.value !== "") {
    body.ttl = Number(form.ttl.value);
  }

  const data = await api("PUT", keyPath(key), body);
  if (data.ok) {
    return [`OK  ("${key}" 저장됨${body.ttl ? `, ${body.ttl}초 뒤 만료` : ""})`, true];
  }
  // NX/XX 조건 때문에 저장하지 않은 경우
  return ["(nil)  조건(NX/XX) 때문에 저장하지 않음", false];
});

// ----------------------------------------------------------------------
// GET key  →  GET /keys/{key}   (없거나 만료됐으면 404)
// ----------------------------------------------------------------------
onSubmit("get-form", "get-result", async (form) => {
  const key = form.key.value;
  try {
    const data = await api("GET", keyPath(key));
    return [`"${data.value}"`, true];
  } catch (err) {
    if (err.status === 404) {
      return ["(nil)  키가 없거나 만료됨", false];
    }
    throw err;
  }
});

// ----------------------------------------------------------------------
// DEL key  →  DELETE /keys/{key}   (지운 개수 0 또는 1)
// ----------------------------------------------------------------------
onSubmit("del-form", "del-result", async (form) => {
  const data = await api("DELETE", keyPath(form.key.value));
  return data.deleted
    ? [`(integer) ${data.deleted}  삭제됨`, true]
    : ["(integer) 0  지울 키가 없음", false];
});

// ----------------------------------------------------------------------
// EXISTS key  →  GET /keys/{key}/exists
// ----------------------------------------------------------------------
onSubmit("exists-form", "exists-result", async (form) => {
  const data = await api("GET", keyPath(form.key.value) + "/exists");
  return data.exists
    ? ["(integer) 1  존재함", true]
    : ["(integer) 0  없음", false];
});
