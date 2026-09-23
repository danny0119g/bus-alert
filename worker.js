/**
 * 361번 버스 (래미안그레이튼아파트 정류소) 도착 5분 전 알림
 *
 * Cloudflare 대시보드에서 설정할 것:
 * 1) Settings > Variables and Secrets:
 *    - SERVICE_KEY (Secret): 서울 열린데이터광장에서 받은 인증키
 *    - BUS_ROUTE_ID (Variable): 100100454
 *    - ARS_ID (Variable): 23297
 *    - NTFY_TOPIC (Variable): bus-1fae3aa855471c34
 * 2) Bindings: KV Namespace BUS_STATE
 * 3) Trigger: Cron * * * * *
 */

const THRESHOLD_SECONDS = 300; // 정확히 5분 (정밀 타이밍은 Durable Object Alarm이 담당)

async function fetchArrivalSeconds(env) {
  const url = `http://ws.bus.go.kr/api/rest/arrive/getArrInfoByRouteAll?serviceKey=${env.SERVICE_KEY}&busRouteId=${env.BUS_ROUTE_ID}`;
  const res = await fetch(url);
  const text = await res.text();

  // XML 파싱 (정규식 기반)
  const blocks = text.match(/<itemList>[\s\S]*?<\/itemList>/g) || [];
  const items = blocks.map((block) => {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1] : null;
    };
    return {
      arsId: get("arsId"),
      arrmsg1: get("arrmsg1"),
      traTime1: get("traTime1"),
      stNm: get("stNm"),
    };
  });

  const match = items.find((it) => String(it.arsId).trim() === String(env.ARS_ID).trim());
  if (!match) {
    return { found: false, raw: text.slice(0, 800), itemCount: items.length };
  }

  const seconds1 = match.traTime1 != null ? parseInt(match.traTime1, 10) : null;

  return {
    found: true,
    seconds1,
    msg1: match.arrmsg1,
    stNm: match.stNm,
  };
}

async function sendNtfy(env, message, title) {
  const body = JSON.stringify({
    topic: env.NTFY_TOPIC,
    message: message,
    title: title || "버스 알림",
    priority: 5,
    tags: ["bus"],
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
    });
    if (res.ok) return;
    if (attempt === 1) {
      const errText = await res.text();
      throw new Error(`ntfy 전송 실패 (${res.status}): ${errText}`);
    }
  }
}

async function armPreciseAlarm(env, delayMs) {
  try {
    const id = env.PRECISE_ALARM.idFromName("singleton");
    const stub = env.PRECISE_ALARM.get(id);
    await stub.fetch("https://precise-alarm/arm", {
      method: "POST",
      body: JSON.stringify({ delayMs }),
    });
  } catch (e) {
    // Durable Object 호출 실패해도 1분 주기 크론이 백업으로 계속 돌아가니 무시
  }
}

async function clearPreciseAlarm(env) {
  try {
    const id = env.PRECISE_ALARM.idFromName("singleton");
    const stub = env.PRECISE_ALARM.get(id);
    await stub.fetch("https://precise-alarm/clear", { method: "POST" });
  } catch (e) {}
}

// DO 알람이 울렸을 때 호출됨: 남은 시간 재는 것 없이 무조건 바로 전송
async function fireAlertWithResult(env, result) {
  const seconds = result.found ? result.seconds1 : null;
  const minutes = seconds != null ? Math.round(seconds / 60) : 5;
  try {
    await sendNtfy(
      env,
      `361번 버스가 약 ${minutes}분 후 ${(result.found && result.stNm) || "정류소"}에 도착해요. (${(result.found && result.msg1) || ""})`,
      "🚌 버스 도착 임박"
    );
    await env.BUS_STATE.put("alerted", "true");
  } catch (e) {
    // 전송 실패 시 alerted는 false로 남겨둬서 다음 체크(runCheck 안전망)가 재시도함
  }
  await env.BUS_STATE.put("armed", "false");
}

async function fireAlert(env) {
  const result = await fetchArrivalSeconds(env);
  await fireAlertWithResult(env, result);
}

async function runCheck(env) {
  const result = await fetchArrivalSeconds(env);

  if (!result.found) {
    return { status: "stop-not-found", detail: result.raw, itemCount: result.itemCount };
  }

  const wasAlerted = (await env.BUS_STATE.get("alerted")) === "true";
  const wasArmed = (await env.BUS_STATE.get("armed")) === "true";
  const seconds = result.seconds1;

  // 이미 5분 이내인데 아직 안 보냈다면 (DO가 놓쳤을 때의 안전망) 바로 전송
  if (seconds != null && seconds > 0 && seconds <= THRESHOLD_SECONDS && !wasAlerted) {
    const minutes = Math.round(seconds / 60);
    try {
      await sendNtfy(
        env,
        `361번 버스가 약 ${minutes}분 후 ${result.stNm || "정류소"}에 도착해요. (${result.msg1 || ""})`,
        "🚌 버스 도착 임박"
      );
      await env.BUS_STATE.put("alerted", "true");
      await env.BUS_STATE.put("armed", "false");
      await clearPreciseAlarm(env);
      return { status: "alert-sent", seconds, msg1: result.msg1 };
    } catch (e) {
      return { status: "waiting", seconds, msg1: result.msg1 };
    }
  }

  if (wasAlerted) {
    // 버스가 다시 멀어졌으면(다음 운행 주기) 상태 초기화
    if (seconds == null || seconds > THRESHOLD_SECONDS) {
      await env.BUS_STATE.put("alerted", "false");
      await env.BUS_STATE.put("armed", "false");
    }
    return { status: seconds != null && seconds <= THRESHOLD_SECONDS ? "already-alerted" : "waiting", seconds, msg1: result.msg1 };
  }

  // 6~7분(420초) 구간에 막 들어왔고, 아직 예약 안 해뒀으면 "딱 한 번만" 예약
  if (!wasArmed && seconds != null && seconds > THRESHOLD_SECONDS && seconds <= 420) {
    await armPreciseAlarm(env, (seconds - THRESHOLD_SECONDS) * 1000);
    await env.BUS_STATE.put("armed", "true");
  }

  return { status: "waiting", seconds, msg1: result.msg1 };
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>361 · 래미안그레이튼아파트</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Doto:wght,ROND@100..900,0..100&family=IBM+Plex+Sans+KR:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #030303;
    --panel: #050505;
    --case: #212226;
    --case-light: #34353a;
    --seam: #000;
    --plate-blue: #1a56db;
    --amber: #ffb400;
    --amber-glow: rgba(255,180,0,0.25);
    --green: #23ff8c;
    --green-glow: rgba(35,255,140,0.3);
    --blue: #3ea6ff;
    --red: #ff4d4d;
    --text-dim: #6b7076;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--amber);
    font-family: 'IBM Plex Sans KR', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    padding-top: max(24px, env(safe-area-inset-top));
    padding-bottom: max(24px, env(safe-area-inset-bottom));
    min-height: 100%;
  }
  .case {
    width: 100%;
    max-width: 480px;
    background: linear-gradient(155deg, var(--case-light), var(--case) 40%, #17181b);
    border-radius: 3px;
    padding: 14px;
    position: relative;
    box-shadow: 0 10px 28px rgba(0,0,0,0.55);
  }
  .screw {
    position: absolute;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #8a8c92, #3a3b3f 60%, #1c1d20);
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.5);
  }
  .screw.tl { top: 8px; left: 8px; }
  .screw.tr { top: 8px; right: 8px; }
  .screw.bl { bottom: 8px; left: 8px; }
  .screw.br { bottom: 8px; right: 8px; }
  .board {
    background: var(--panel);
    border: 1px solid var(--seam);
    border-radius: 1px;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03), inset 0 2px 10px rgba(0,0,0,0.8);
    padding: 26px 24px 20px;
    position: relative;
    overflow: hidden;
  }
  .board::before {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      rgba(255,255,255,0.02) 0px,
      rgba(255,255,255,0.02) 1px,
      transparent 1px,
      transparent 3px
    );
    pointer-events: none;
  }
  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 24px;
  }
  .route-plate {
    background: var(--plate-blue);
    color: #fff;
    font-family: 'Doto', monospace;
    font-weight: 900;
    font-variation-settings: 'ROND' 100;
    font-size: 26px;
    padding: 4px 6px 4px 12px;
    border-radius: 2px;
  }
  .stop-name {
    font-size: 14px;
    color: var(--text-dim);
    text-align: right;
    line-height: 1.4;
  }
  .stage {
    text-align: center;
    padding: 18px 0 8px;
  }
  .countdown {
    font-family: 'Doto', monospace;
    font-weight: 900;
    font-variation-settings: 'ROND' 100;
    font-size: 78px;
    line-height: 1;
    color: var(--amber);
    text-shadow: 0 0 6px var(--amber-glow);
    font-variant-numeric: tabular-nums;
  }
  .countdown.soon { color: var(--green); text-shadow: 0 0 8px var(--green-glow); }
  .unit.soon { color: var(--green); opacity: 0.8; }
  .alert-badge {
    margin-top: 14px;
    display: none;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 500;
    color: var(--green);
    background: rgba(35,255,140,0.08);
    border: 1px solid rgba(35,255,140,0.35);
    border-radius: 10px;
    padding: 10px 14px;
  }
  .alert-badge.show { display: flex; }
  .alert-badge .bell { font-size: 16px; }
  .unit {
    font-size: 15px;
    color: var(--text-dim);
    margin-top: 6px;
    letter-spacing: 1px;
  }
  .msg {
    margin-top: 14px;
    font-size: 15px;
    color: var(--amber);
    opacity: 0.85;
    min-height: 20px;
  }
  .divider {
    height: 1px;
    background: #000;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04);
    margin: 22px 0 14px;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--text-dim);
    font-family: 'IBM Plex Mono', monospace;
  }
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--blue);
    margin-right: 6px;
    box-shadow: 0 0 6px rgba(62,166,255,0.5);
  }
  .dot.error {
    background: var(--red);
    box-shadow: 0 0 8px rgba(255,77,77,0.6);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  #statusText { color: var(--text-dim); line-height: 1; position: relative; top: 0.5px; }
  #statusText.error { color: var(--red); }
  .status-group {
    display: flex;
    align-items: center;
    line-height: 1;
  }
  .layout {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    width: 100%;
    max-width: 480px;
  }
  .companion {
    width: 100%;
    max-width: 480px;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 10px 28px rgba(0,0,0,0.4);
  }
  .companion img {
    display: block;
    width: 100%;
    height: auto;
  }
  @media (min-width: 760px) {
    .layout {
      flex-direction: row;
      align-items: flex-start;
      max-width: 760px;
    }
    .companion {
      width: 260px;
      flex-shrink: 0;
    }
  }
  @media (max-width: 380px) {
    .countdown { font-size: 58px; }
    .route-plate { font-size: 17px; padding: 4px 9px 3px; }
  }
</style>
</head>
<body>
  <div class="layout">
  <div class="case">
    <span class="screw tl"></span>
    <span class="screw tr"></span>
    <span class="screw bl"></span>
    <span class="screw br"></span>
  <div class="board">
    <div class="row-top">
      <div class="route-plate">361</div>
      <div class="stop-name">래미안그레이튼<br>아파트</div>
    </div>
    <div class="stage">
      <div class="countdown" id="countdown">--:--</div>
      <div class="unit" id="unit">불러오는 중</div>
      <div class="msg" id="msg">&nbsp;</div>
      <div class="alert-badge" id="alertBadge">알림 전송됨</div>
    </div>
    <div class="divider"></div>
    <div class="footer">
      <span class="status-group"><span class="dot" id="dot"></span><span id="statusText"></span></span>
      <span id="updatedAt">--:--:--</span>
    </div>
  </div>
  </div>
  <div class="companion">
    <img src="data:image/jpeg;base64,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" alt="">
  </div>
  </div>

<script>
  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtClock(d) {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  }

  const els = {
    dot: document.getElementById('dot'),
    statusText: document.getElementById('statusText'),
    countdown: document.getElementById('countdown'),
    unit: document.getElementById('unit'),
    msg: document.getElementById('msg'),
    alertBadge: document.getElementById('alertBadge'),
    updatedAt: document.getElementById('updatedAt'),
  };

  // 로컬에서 매초 감소시키기 위한 기준값
  let baseSeconds = null;   // 마지막으로 서버가 알려준 남은 초
  let baseTimestamp = null; // 그 값을 받은 시각 (ms)
  let isAlerted = false;
  let stopsText = '';       // "7정류장 전" 같은 문구 (시간과 안 겹치게 정류장 수만)

  function render() {
    // 하단 시계는 항상 매초 살아있게
    els.updatedAt.textContent = fmtClock(new Date());

    if (baseSeconds == null) return;
    const elapsed = Math.floor((Date.now() - baseTimestamp) / 1000);
    const remaining = Math.max(0, baseSeconds - elapsed);
    const isSoon = remaining <= 300;

    els.countdown.textContent = remaining > 0 ? fmt(remaining) : '도착';
    els.countdown.classList.toggle('soon', isSoon);
    els.unit.classList.toggle('soon', isSoon);
    els.unit.textContent = remaining > 0 ? '도착까지' : '';
    els.msg.textContent = stopsText;

    els.alertBadge.classList.toggle('show', isSoon && isAlerted);
  }

  async function poll() {
    // 미리보기용: 주소 끝에 ?demo=error 붙이면 실제 오류 없이 오류 화면을 볼 수 있음
    if (new URLSearchParams(location.search).get('demo') === 'error') {
      els.dot.classList.add('error');
      els.statusText.classList.add('error');
      els.statusText.textContent = '일시적인 오류 · 다시 불러오는 중';
      els.unit.textContent = '';
      stopsText = '';
      baseSeconds = null;
      els.countdown.textContent = '--:--';
      render();
      return;
    }
    try {
      const res = await fetch('/api', { cache: 'no-store' });
      const data = await res.json();

      if (data.status === 'waiting' || data.status === 'alert-sent' || data.status === 'already-alerted') {
        els.dot.classList.remove('error');
        els.statusText.classList.remove('error');
        els.statusText.textContent = '';
        isAlerted = data.status === 'alert-sent' || data.status === 'already-alerted';

        const raw = data.msg1 || '';
        const stopsMatch = raw.match(/(\\d+)번째\\s*전/);
        stopsText = stopsMatch ? \`\${stopsMatch[1]} 정류장 전\` : raw;

        if (data.seconds != null) {
          baseSeconds = data.seconds;
          baseTimestamp = Date.now();
        }
      } else if (data.status === 'stop-not-found') {
        els.dot.classList.add('error');
        els.statusText.classList.add('error');
        els.statusText.textContent = '정류소 정보를 찾을 수 없음 · 다시 불러오는 중';
        els.unit.textContent = '';
        stopsText = '';
        baseSeconds = null;
        els.countdown.textContent = '--:--';
        scheduleRetry();
      } else {
        els.dot.classList.add('error');
        els.statusText.classList.add('error');
        els.statusText.textContent = '일시적인 오류 · 다시 불러오는 중';
        els.unit.textContent = '';
        stopsText = '';
        baseSeconds = null;
        els.countdown.textContent = '--:--';
        scheduleRetry();
      }
    } catch (e) {
      els.dot.classList.add('error');
      els.statusText.classList.add('error');
      els.statusText.textContent = '서버에 연결할 수 없음 · 다시 불러오는 중';
      scheduleRetry();
    }
    render();
  }

  let retryTimer = null;
  function scheduleRetry() {
    if (retryTimer) return; // 이미 재시도 예약돼 있으면 중복 예약 안 함
    retryTimer = setTimeout(() => {
      retryTimer = null;
      poll();
    }, 4000);
  }

  poll();
  setInterval(poll, 20000);   // 20초마다 서버에서 실제 값 다시 받아오기 (보정)
  setInterval(render, 1000);  // 매초 화면 전체(숫자/문구/시계) 로컬로 갱신
</script>
</body>
</html>`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/test-notify") {
      try {
        await sendNtfy(env, "테스트 알림입니다.", "🚌 테스트");
        return new Response("테스트 알림을 보냈어요. ntfy 앱을 확인하세요.");
      } catch (e) {
        return new Response(`전송 실패: ${e.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/api") {
      try {
        const result = await runCheck(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ status: "exception", message: e.message, stack: e.stack }, null, 2),
          { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
    }

    return new Response(renderPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};

// 정확히 지정된 시각에 딱 한 번 깨어나서 버스 체크를 실행하는 Durable Object.
// 1분 주기 크론만으로는 "정확히 5분 남는 순간"을 놓칠 수 있어서(최대 1분 오차),
// 매 체크마다 그 정확한 순간까지 남은 시간을 계산해 여기에 예약해둔다.
export class PreciseAlarm {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/clear") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete("retried");
      return new Response("cleared");
    }
    const { delayMs } = await request.json();
    await this.state.storage.delete("retried"); // 새로 예약하는 거면 재시도 카운트 리셋
    if (delayMs > 0 && delayMs < 30 * 60 * 1000) {
      await this.state.storage.setAlarm(Date.now() + delayMs);
    }
    return new Response("armed");
  }

  async alarm() {
    const result = await fetchArrivalSeconds(this.env);
    const seconds = result.found ? result.seconds1 : null;
    const alreadyRetried = await this.state.storage.get("retried");

    if (seconds != null && seconds > THRESHOLD_SECONDS && !alreadyRetried) {
      // 아직 5분 전이 안 됐고, 재조정도 안 해봤으면 딱 한 번만 재조정
      await this.state.storage.put("retried", true);
      await this.state.storage.setAlarm(Date.now() + (seconds - THRESHOLD_SECONDS) * 1000);
      return;
    }

    // 이미 5분 전이거나, 재조정을 한 번 했으면 더 재지 않고 바로 전송
    await fireAlertWithResult(this.env, result);
    await this.state.storage.delete("retried");
  }
}
