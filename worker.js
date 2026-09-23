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

const THRESHOLD_SECONDS = 300; // 5분

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

async function runCheck(env) {
  const result = await fetchArrivalSeconds(env);

  if (!result.found) {
    return { status: "stop-not-found", detail: result.raw, itemCount: result.itemCount };
  }

  const alertedKey = "alerted";
  const wasAlerted = (await env.BUS_STATE.get(alertedKey)) === "true";
  const seconds = result.seconds1;

  if (seconds != null && seconds > 0 && seconds <= THRESHOLD_SECONDS) {
    if (!wasAlerted) {
      const minutes = Math.round(seconds / 60);
      try {
        await sendNtfy(
          env,
          `361번 버스가 약 ${minutes}분 후 ${result.stNm || "정류소"}에 도착해요. (${result.msg1 || ""})`,
          "🚌 버스 도착 임박"
        );
        await env.BUS_STATE.put(alertedKey, "true");
        return { status: "alert-sent", seconds, msg1: result.msg1 };
      } catch (e) {
        // 알림 전송이 실패해도 화면 표시는 정상적으로 유지, 다음 체크 때 다시 시도
        return { status: "waiting", seconds, msg1: result.msg1 };
      }
    }
    return { status: "already-alerted", seconds, msg1: result.msg1 };
  }

  if (wasAlerted && (seconds == null || seconds > THRESHOLD_SECONDS)) {
    await env.BUS_STATE.put(alertedKey, "false");
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
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #08090b;
    --panel: #101215;
    --bezel: #1c1f24;
    --amber: #ffb400;
    --amber-dim: #5c4000;
    --amber-glow: rgba(255,180,0,0.35);
    --green: #23ff8c;
    --green-glow: rgba(35,255,140,0.4);
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
    font-family: 'Noto Sans KR', sans-serif;
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
  .board {
    width: 100%;
    max-width: 480px;
    background: var(--panel);
    border: 1px solid var(--bezel);
    border-radius: 18px;
    box-shadow: 0 0 0 6px var(--bezel), 0 30px 60px rgba(0,0,0,0.5);
    padding: 28px 26px 22px;
    position: relative;
    overflow: hidden;
  }
  .board::before {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      rgba(255,255,255,0.015) 0px,
      rgba(255,255,255,0.015) 1px,
      transparent 1px,
      transparent 3px
    );
    pointer-events: none;
  }
  .row-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 22px;
  }
  .route {
    font-family: 'Share Tech Mono', monospace;
    font-size: 30px;
    font-weight: 400;
    letter-spacing: 1px;
    color: var(--amber);
    text-shadow: 0 0 14px var(--amber-glow);
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
    font-family: 'Share Tech Mono', monospace;
    font-size: 76px;
    line-height: 1;
    letter-spacing: 2px;
    color: var(--amber);
    text-shadow: 0 0 22px var(--amber-glow);
    font-variant-numeric: tabular-nums;
  }
  .countdown.soon { color: var(--green); text-shadow: 0 0 24px var(--green-glow); }
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
    background: var(--bezel);
    margin: 22px 0 14px;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--text-dim);
    font-family: 'Share Tech Mono', monospace;
  }
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--blue);
    margin-right: 6px;
    box-shadow: 0 0 6px rgba(62,166,255,0.5);
    position: relative;
    top: 0.5px;
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
  #statusText { color: var(--text-dim); line-height: 1; position: relative; top: 1px; }
  #statusText.error { color: var(--red); }
  .status-group {
    display: flex;
    align-items: center;
    line-height: 1;
  }
  @media (max-width: 380px) {
    .countdown { font-size: 58px; }
    .route { font-size: 24px; }
  }
</style>
</head>
<body>
  <div class="board">
    <div class="row-top">
      <div class="route">361</div>
      <div class="stop-name">래미안그레이튼<br>아파트</div>
    </div>
    <div class="stage">
      <div class="countdown" id="countdown">--:--</div>
      <div class="unit" id="unit">불러오는 중</div>
      <div class="msg" id="msg">&nbsp;</div>
      <div class="alert-badge" id="alertBadge"><span class="bell">🔔</span><span>알림 보냈어요 — 나갈 준비하세요!</span></div>
    </div>
    <div class="divider"></div>
    <div class="footer">
      <span class="status-group"><span class="dot" id="dot"></span><span id="statusText"></span></span>
      <span id="updatedAt">--:--:--</span>
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
