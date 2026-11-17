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

// ======================================================================
// SQL + 캐시 탭
//   POST /sql 로 SQL 을 실행하고, 결과마다 캐시 HIT / MISS / BYPASS 와 처리 시간을 보여준다.
//   GET /sql/stats (통계), GET /sql/cache (캐시 키 목록)로 캐시 상태를 함께 보여준다.
//   CSV 값은 사용자가 넣은 문자열이므로 화면에 넣을 때는 항상 텍스트 노드로 넣는다 (innerHTML 금지 → XSS 방지).
// ======================================================================

const MAX_ROWS = 100;   // 결과 표에 그리는 최대 행 수 (그 이상은 "외 N행"으로 표시)

const EXAMPLES = [
  { label: "전체 스캔", sql: "SELECT name, age FROM users WHERE age > 30;" },
  { label: "id 인덱스", sql: "SELECT * FROM users WHERE id = 3;" },
  { label: "id 범위", sql: "SELECT id, name FROM users WHERE id >= 2 AND id <= 4;" },
  { label: "INSERT", sql: "INSERT INTO users (name, age, email) VALUES ('테스트', 33, 'test@example.com');" },
  { label: "오류 예시", sql: "SELECT * FROM no_such_table;\nSELEC * FROM users;\nSELECT * FROM users WHERE id = 1;" },
];

// 요소 만들기 도우미. 자식으로 문자열을 주면 텍스트 노드로 들어간다.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child !== undefined && child !== null && child !== false) node.append(child);
  }
  return node;
}

function formatMs(ms) {
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;
}

const CACHE_LABEL = { hit: "HIT", miss: "MISS", bypass: "BYPASS" };

// ----------------------------------------------------------------------
// 탭 전환 (주소의 #redis / #sql 로 기억 → 새로고침해도 유지)
// ----------------------------------------------------------------------
const TABS = ["redis", "sql"];

function selectTab(name) {
  if (!TABS.includes(name)) name = "redis";
  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).hidden = tab !== name;
  }
  for (const button of document.querySelectorAll(".tabs .tab")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  document.getElementById("main").classList.toggle("wide", name === "sql");
  if (name === "sql") refreshSqlSide();
}

for (const button of document.querySelectorAll(".tabs .tab")) {
  button.addEventListener("click", () => { location.hash = button.dataset.tab; });
}
window.addEventListener("hashchange", () => selectTab(location.hash.slice(1)));

function sqlTabVisible() {
  return !document.getElementById("tab-sql").hidden && !document.hidden;
}

// ----------------------------------------------------------------------
// SQL 실행
// ----------------------------------------------------------------------
const sqlForm = document.getElementById("sql-form");

const examples = document.getElementById("sql-examples");
for (const example of EXAMPLES) {
  const button = el("button", { type: "button", class: "small ghost" }, example.label);
  button.title = example.sql;
  button.addEventListener("click", () => {
    sqlForm.sql.value = example.sql;
    sqlForm.sql.focus();
  });
  examples.append(button);
}

// Ctrl+Enter (맥은 Cmd+Enter) 로 실행
sqlForm.sql.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sqlForm.requestSubmit();
  }
});

sqlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const sql = sqlForm.sql.value;
  if (!sql.trim()) return;

  const submit = sqlForm.querySelector("button[type=submit]");
  submit.disabled = true;
  const timing = document.getElementById("sql-timing");
  const results = document.getElementById("sql-results");
  const started = performance.now();
  try {
    const data = await api("POST", "/sql", { sql, use_cache: sqlForm.use_cache.checked });
    renderTiming(data, performance.now() - started);
    renderResults(data.results);
  } catch (err) {
    // 400(닫히지 않은 문자열 등 스크립트 전체를 못 읽는 오류), 422(body 형식 오류) 등
    timing.textContent = "";
    results.replaceChildren(
      el("div", { class: "stmt error" },
        el("div", { class: "stmt-body err" }, (err.status ? `[${err.status}] ` : "") + err.message)),
    );
  } finally {
    submit.disabled = false;
    refreshSqlSide();
  }
});

// 서버 처리 시간(elapsed_ms)과 브라우저에서 잰 시간(네트워크 + JSON 처리 포함)을 함께 보여준다
function renderTiming(data, clientMs) {
  const timing = document.getElementById("sql-timing");
  timing.replaceChildren(
    "서버 ", el("strong", {}, formatMs(data.elapsed_ms)),
    " · 브라우저 ", el("strong", {}, formatMs(clientMs)), " (네트워크·JSON 포함)",
    ` · 문장 ${data.results.length}개`,
    data.errors ? `, 오류 ${data.errors}개` : "",
  );
}

function renderResults(results) {
  const container = document.getElementById("sql-results");
  container.replaceChildren(...results.map((result, i) => renderStatement(result, i + 1)));
}

function renderStatement(result, n) {
  const head = el("div", { class: "stmt-head" },
    el("span", { class: "mono" }, `[${n}]`),
    el("span", { class: "stmt-sql mono" }, result.statement ?? "(문법 오류)"),
  );
  let body;

  if (result.type === "select") {
    head.append(
      el("span", { class: `badge ${result.cache}` }, CACHE_LABEL[result.cache] ?? result.cache),
      el("span", { class: result.used_index ? "badge index" : "badge bypass" },
        result.used_index ? "id 인덱스" : "전체 스캔"),
    );
    body = el("div", { class: "stmt-body" }, renderRows(result));
  } else if (result.type === "insert") {
    const ids = result.ids.length > 20
      ? `${result.ids.slice(0, 20).join(", ")}, … (${result.ids.length}개)`
      : result.ids.join(", ");
    body = el("div", { class: "stmt-body" },
      `${result.count}개 행이 '${result.table}' 에 추가됨`, ids ? ` (id: ${ids})` : "");
  } else if (result.type === "create") {
    body = el("div", { class: "stmt-body" }, result.created
      ? `테이블 '${result.table}' 생성됨 (컬럼: ${result.columns.join(", ")})`
      : `테이블 '${result.table}' 이(가) 이미 있어서 건너뜀`);
  } else {
    head.append(el("span", { class: "badge error" }, "오류"));
    body = el("div", { class: "stmt-body err" }, result.error);
  }

  head.append(el("span", { class: "ms" }, formatMs(result.elapsed_ms)));
  return el("div", { class: `stmt ${result.type}` }, head, body);
}

function renderRows(result) {
  const fragment = document.createDocumentFragment();
  fragment.append(el("div", { class: "more" }, `${result.count}개 행`));
  if (result.count === 0) return fragment;

  const thead = el("thead", {}, el("tr", {}, ...result.columns.map((c) => el("th", {}, c))));
  const tbody = el("tbody", {}, ...result.rows.slice(0, MAX_ROWS).map(
    (row) => el("tr", {}, ...row.map((cell) => el("td", {}, cell))),
  ));
  fragment.append(el("div", { class: "table-wrap" }, el("table", { class: "data" }, thead, tbody)));
  if (result.count > MAX_ROWS) {
    fragment.append(el("div", { class: "more" }, `처음 ${MAX_ROWS}행만 표시 (외 ${result.count - MAX_ROWS}행)`));
  }
  return fragment;
}

// ----------------------------------------------------------------------
// 캐시 통계 / 캐시 키 목록
// ----------------------------------------------------------------------
async function refreshStats() {
  const s = await api("GET", "/sql/stats");
  const stat = (label, value) => el("div", { class: "stat" },
    el("div", { class: "label" }, label), el("div", { class: "value" }, String(value)));
  document.getElementById("sql-stats").replaceChildren(
    stat("hit률", `${(s.hit_rate * 100).toFixed(1)}%`),
    stat("HIT", s.hits),
    stat("MISS", s.misses),
    stat("BYPASS", s.bypassed),
    stat("무효화", s.invalidations),
    stat("TTL", `${s.ttl}+${s.ttl_jitter}s`),
  );
}

// 버전은 time_ns 로 시작해서 길기 때문에 뒷자리만 보여준다 (INSERT 하면 마지막 자리가 바뀜)
function shortVersion(version) {
  return version.length > 6 ? `…${version.slice(-6)}` : version;
}

async function refreshCache() {
  const { versions, entries } = await api("GET", "/sql/cache");

  const chips = Object.entries(versions).map(([table, version]) => {
    const del = el("button", { type: "button", class: "small ghost", title: "버전 키만 지우기 (새 세대로 다시 시작)" }, "DEL");
    del.addEventListener("click", () => deleteKey(`dbcache:ver:${table}`));
    return el("span", { class: "chip", title: `dbcache:ver:${table} = ${version}` },
      el("span", {}, table), el("span", { class: "mono" }, `v${shortVersion(version)}`), del);
  });
  document.getElementById("cache-versions").replaceChildren(
    ...(chips.length ? chips : [el("span", { class: "note" }, "버전 키 없음")]),
  );

  const tbody = document.querySelector("#cache-table tbody");
  if (entries.length === 0) {
    tbody.replaceChildren(el("tr", {}, el("td", { class: "empty", colspan: "6" }, "캐시된 결과 없음")));
    return;
  }
  tbody.replaceChildren(...entries.map((entry) => {
    const del = el("button", { type: "button", class: "small ghost" }, "DEL");
    del.addEventListener("click", () => deleteKey(entry.key));
    return el("tr", { class: entry.current ? null : "stale", title: entry.key },
      el("td", {}, el("span", { class: entry.current ? "badge hit" : "badge stale" },
        entry.current ? "현재" : "이전 버전")),
      el("td", {}, entry.table),
      el("td", { class: "mono" }, `v${shortVersion(entry.version)}`),
      el("td", { class: "mono" }, `${entry.ttl}s`),
      el("td", { class: "sql mono" }, entry.sql ?? ""),
      el("td", {}, del),
    );
  }));
}

let refreshing = false;
async function refreshSqlSide() {
  if (refreshing) return;   // 앞의 새로고침이 끝나기 전에 또 요청하지 않음
  refreshing = true;
  try {
    await Promise.all([refreshStats(), refreshCache()]);
    show("cache-result", "", true);
  } catch (err) {
    show("cache-result", `새로고침 실패: ${err.message}`, false);
  } finally {
    refreshing = false;
  }
}

async function deleteKey(key) {
  try {
    await api("DELETE", keyPath(key));
  } catch (err) {
    show("cache-result", `DEL 실패: ${err.message}`, false);
  }
  refreshSqlSide();
}

document.getElementById("cache-refresh").addEventListener("click", refreshSqlSide);

document.getElementById("cache-flushall").addEventListener("click", async () => {
  if (!confirm("Redis의 모든 키(캐시가 아닌 일반 키 포함)를 지웁니다. 계속할까요?")) return;
  try {
    await api("POST", "/flushall");
  } catch (err) {
    show("cache-result", `FLUSHALL 실패: ${err.message}`, false);
  }
  refreshSqlSide();
});

// TTL 이 줄어드는 것을 보이게 1초마다 새로고침 (SQL 탭이 보이고 체크되어 있을 때만)
setInterval(() => {
  if (document.getElementById("cache-auto").checked && sqlTabVisible()) refreshSqlSide();
}, 1000);

selectTab(location.hash.slice(1));
