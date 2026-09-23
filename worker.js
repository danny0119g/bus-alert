/**
 * 361번 버스 (래미안그레이튼아파트 정류소) 도착 5분 전 알림
 *
 * 배포 전 Cloudflare 대시보드에서 아래를 설정하세요:
 *
 * 1) Settings > Variables and Secrets 에 추가:
 *    - SERVICE_KEY   : data.go.kr에서 받은 디코딩 인증키
 *    - ARS_ID        : 23297
 *    - ROUTE_NAME    : 361
 *    - NTFY_TOPIC    : bus-1fae3aa855471c34   (원하면 바꿔도 됨, 단 ntfy 앱에도 똑같이 등록)
 *
 * 2) Workers KV 네임스페이스를 만들고 이름을 BUS_STATE 로 바인딩
 *    (Settings > Bindings > KV Namespace 추가, Variable name: BUS_STATE)
 *
 * 3) Settings > Triggers > Cron Trigger 추가: 매 1분마다 실행
 *    표현식: * * * * *
 */

const THRESHOLD_SECONDS = 300; // 5분

async function fetchArrivalSeconds(env) {
  const url = `http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid?serviceKey=${env.SERVICE_KEY}&arsId=${env.ARS_ID}&resultType=json`;
  const res = await fetch(url);
  const text = await res.text();

  let items = [];

  // 1) JSON 응답 시도
  try {
    const data = JSON.parse(text);
    items = data?.msgBody?.itemList ?? [];
    if (!Array.isArray(items)) items = [items];
  } catch (e) {
    // 2) XML 응답으로 폴백 (정규식으로 간단 파싱)
    const blocks = text.match(/<itemList>[\s\S]*?<\/itemList>/g) || [];
    items = blocks.map((block) => {
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return m ? m[1] : null;
      };
      return {
        rtNm: get("rtNm"),
        arrmsg1: get("arrmsg1"),
        traTime1: get("traTime1"),
        arrmsg2: get("arrmsg2"),
        traTime2: get("traTime2"),
      };
    });
  }

  const match = items.find((it) => String(it.rtNm).trim() === String(env.ROUTE_NAME).trim());
  if (!match) {
    return { found: false, raw: text.slice(0, 500) };
  }

  const seconds1 = match.traTime1 != null ? parseInt(match.traTime1, 10) : null;
  const seconds2 = match.traTime2 != null ? parseInt(match.traTime2, 10) : null;

  return {
    found: true,
    seconds1,
    seconds2,
    msg1: match.arrmsg1,
    msg2: match.arrmsg2,
  };
}

async function sendNtfy(env, message, title) {
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      topic: env.NTFY_TOPIC,
      message: message,
      title: title || "버스 알림",
      priority: 5,
      tags: ["bus"],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ntfy 전송 실패 (${res.status}): ${errText}`);
  }
}

async function runCheck(env) {
  const result = await fetchArrivalSeconds(env);

  if (!result.found) {
    return { status: "route-not-found", detail: result.raw };
  }

  const alertedKey = "alerted";
  const wasAlerted = (await env.BUS_STATE.get(alertedKey)) === "true";
  const seconds = result.seconds1;

  if (seconds != null && seconds > 0 && seconds <= THRESHOLD_SECONDS) {
    if (!wasAlerted) {
      const minutes = Math.round(seconds / 60);
      await sendNtfy(
        env,
        `361번 버스가 약 ${minutes}분 후 래미안그레이튼아파트에 도착해요. (${result.msg1 || ""})`,
        "🚌 버스 도착 임박"
      );
      await env.BUS_STATE.put(alertedKey, "true");
      return { status: "alert-sent", seconds };
    }
    return { status: "already-alerted", seconds };
  }

  // 버스가 다시 멀어졌으면 (새 운행 주기) 알림 상태 초기화
  if (wasAlerted && (seconds == null || seconds > THRESHOLD_SECONDS)) {
    await env.BUS_STATE.put(alertedKey, "false");
  }

  return { status: "waiting", seconds };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },

  // 브라우저에서 워커 URL로 직접 접속하면 즉시 1회 점검 (디버그용)
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
    const result = await runCheck(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
