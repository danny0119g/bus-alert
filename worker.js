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
      await sendNtfy(
        env,
        `361번 버스가 약 ${minutes}분 후 ${result.stNm || "정류소"}에 도착해요. (${result.msg1 || ""})`,
        "🚌 버스 도착 임박"
      );
      await env.BUS_STATE.put(alertedKey, "true");
      return { status: "alert-sent", seconds };
    }
    return { status: "already-alerted", seconds };
  }

  if (wasAlerted && (seconds == null || seconds > THRESHOLD_SECONDS)) {
    await env.BUS_STATE.put(alertedKey, "false");
  }

  return { status: "waiting", seconds, msg1: result.msg1 };
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
  },
};
