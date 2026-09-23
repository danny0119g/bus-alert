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
