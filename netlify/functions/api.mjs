import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const T_USER = process.env.TEACHER_USER || "Umid@";
const T_PASS = process.env.TEACHER_PASS || "UmidjonSamadov";
const DURATION = 2 * 3600 * 1000; // 2 soat
const store = getStore({ name: "online-test", consistency: "strong" });
const retry = async f => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 200 * (i + 1) + Math.random() * 150)); } } };
const get = k => retry(() => store.get(k, { type: "json" }));
const set = (k, v) => retry(() => store.setJSON(k, v));
const list = pre => retry(() => store.list({ prefix: pre }));
const A_USER = process.env.ADMIN_USER || "admin";
const A_PASS = process.env.ADMIN_PASS || "Admin#2026";

const rid = () => crypto.randomBytes(16).toString("hex");
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pad = n => String(n).padStart(15, "0");
const send = (c, o) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json" } });

const norm = x => String(x ?? "").replace(/\r/g, "").split("\n").map(l => l.trimEnd()).join("\n").trim().toLowerCase();
const ok = (q, a) => { const t = q.type || "mcq"; if (t === "mcq") return a === q.correct; if (t === "practice") return norm(a) !== ""; return norm(a) === norm(q.answer); };
async function finish(s) {
  const qs = (await get("q")) || [], ans = (await get("ans:" + s.login)) || {};
  s.n = qs.length; s.correct = qs.filter(q => ok(q, ans[q.id])).length; s.total = qs.reduce((a, q) => a + (q.pts || 1), 0); s.score = qs.filter(q => ok(q, ans[q.id])).reduce((a, q) => a + (q.pts || 1), 0); s.submitted = true;
  await set("s:" + s.login, s);
  const t = Date.now(); await set("r:" + pad(t) + "-" + s.login, { t, login: s.login, name: s.name, score: s.score, total: s.total, correct: s.correct, n: s.n });
}
async function check(s) { if (s.startedAt && !s.submitted && Date.now() > s.startedAt + DURATION) await finish(s); }
async function view(s) {
  await check(s);
  const run = s.startedAt && !s.submitted;
  const qs = run ? ((await get("q")) || []) : [];
  return {
    name: s.name, started: !!s.startedAt, submitted: !!s.submitted,
    score: s.submitted ? s.score : null, correct: s.correct || 0, n: s.n || 0, total: s.total || 0,
    remaining: run ? Math.max(0, s.startedAt + DURATION - Date.now()) : DURATION,
    questions: qs.map(q => ({ id: q.id, text: q.text, options: q.options, type: q.type || "mcq", starter: q.starter, pts: q.pts || 1 })),
    answers: (await get("ans:" + s.login)) || {}
  };
}

const ALIVE = 15 * 60 * 1000; // admin: 15 daqiqa faolsizlikdan keyin o‘rin bo‘shaydi
const adminBusy = async () => { const a = await get("alock"); return !!a && Date.now() - a.t < ALIVE; };
const adminOk = async tok => { const a = await get("alock"); if (!a || a.token !== tok || Date.now() - a.t > ALIVE) return false; await set("alock", { token: tok, t: Date.now() }); return true; };

async function studentsList() {
  return Promise.all((await list("s:")).blobs.map(async b => {
    const s = await get(b.key); await check(s);
    return { name: s.name, login: s.login, left: (await get("l:" + s.login)) || 0, score: s.score, total: s.total,
      status: s.submitted ? "done" : s.startedAt ? "running" : "waiting",
      remaining: s.startedAt && !s.submitted ? Math.max(0, s.startedAt + DURATION - Date.now()) : null };
  }));
}

export default async (req) => {
  const u = new URL(req.url), P = u.pathname, M = req.method;
  let body = {};
  if (M === "POST") { try { body = await req.json(); } catch {} }
  try {
    if (P === "/api/register" && M === "POST") {
      const name = String(body.name || "").trim().slice(0, 60), login = String(body.login || "").trim().toLowerCase(), pw = String(body.password || "");
      if (name.length < 2 || !/^[a-z0-9_.@-]{3,30}$/.test(login) || pw.length < 4)
        return send(400, { error: "Ism, login (3+ belgi: harf, raqam, _ . @ -) va parol (4+) to‘g‘ri kiriting" });
      if (login === T_USER.toLowerCase() || await get("s:" + login)) return send(409, { error: "Bu login band" });
      const salt = rid();
      await set("s:" + login, { name, login, salt, hash: hash(pw, salt) });
      return send(200, { ok: true });
    }
    if (P === "/api/login" && M === "POST") {
      const login = String(body.login || "").trim().toLowerCase(), pw = String(body.password || "");
      let ok = false;
      if (body.role === "teacher") ok = login === T_USER.toLowerCase() && same(sha(pw), sha(T_PASS));
      else if (body.role === "admin") ok = login === A_USER.toLowerCase() && same(sha(pw), sha(A_PASS));
      else if (/^[a-z0-9_.@-]{3,30}$/.test(login)) { const s = await get("s:" + login); ok = !!s && same(hash(pw, s.salt), s.hash); }
      if (!ok) return send(401, { error: "Login yoki parol noto‘g‘ri" });
      if (body.role === "admin" && await adminBusy()) return send(403, { error: "Admin bo‘limi band. Faqat 1 kishi kira oladi." });
      if (body.role === "teacher" && await get("tlock")) return send(403, { error: "O‘qituvchi bo‘limi band. Faqat 1 kishi kira oladi." });
      const token = rid(), r = ["teacher", "admin"].includes(body.role) ? body.role : "student";
      await set("sess:" + token, { role: r, login });
      if (r === "teacher") await set("tlock", { token });
      if (r === "admin") await set("alock", { token, t: Date.now() });
      return send(200, { token, role: r });
    }
    if (P === "/api/status") return send(200, { teacherBusy: !!(await get("tlock")), adminBusy: await adminBusy() });
    if (P === "/api/forgot" && M === "POST") {
      const name = String(body.name || "").trim().slice(0, 60), t = Date.now();
      if (name.length < 2) return send(400, { error: "Ism familiyangizni yozing" });
      const fk = "f:" + (name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 30) || "x"), last = await get(fk);
      if (last && t - last < 600000) return send(429, { error: "So‘rov yaqinda yuborilgan, biroz kuting" });
      await set(fk, t); await set(`a:${pad(t)}-${rid().slice(0, 4)}`, { id: t, t, login: "—", name, type: "forgot", detail: "Login yoki parolni unutdi" });
      return send(200, { ok: true });
    }
    const tok = req.headers.get("x-token") || body.token;
    const ses = typeof tok === "string" && /^[a-f0-9]{32}$/.test(tok) ? await get("sess:" + tok) : null;
    if (P === "/api/logout" && ses && ses.role === "admin") { const a = await get("alock"); if (a && a.token === tok) await store.delete("alock"); return send(200, { ok: true }); }
    if (P === "/api/logout") { if (ses && ses.role === "teacher") { const lk = await get("tlock"); if (lk && lk.token === tok) await store.delete("tlock"); } return send(200, { ok: true }); }
    if (!ses) return send(401, { error: "Qaytadan kiring" });

    if (ses.role === "student") {
      const s = await get("s:" + ses.login);
      if (!s) return send(401, { error: "Qaytadan kiring" });
      if (P === "/api/rating" && M === "GET") {
        const all = await studentsList(), done = all.filter(x => x.status === "done"), allDone = all.length > 0 && done.length === all.length;
        return send(200, { allDone, done: done.length, total: all.length, list: allDone ? done.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map(x => ({ name: x.name, score: x.score, total: x.total, pct: x.total ? Math.round(x.score / x.total * 100) : 0 })) : [] });
      }
      if (P === "/api/test" && M === "GET") return send(200, await view(s));
      if (P === "/api/start" && M === "POST") {
        if (!s.startedAt) {
          if (!((await get("q")) || []).length) return send(400, { error: "O‘qituvchi hali savol qo‘shmagan" });
          s.startedAt = Date.now(); await set("s:" + s.login, s);
        }
        return send(200, await view(s));
      }
      if (P === "/api/answer" && M === "POST") {
        await check(s);
        if (!s.startedAt || s.submitted) return send(400, { error: "Test yopilgan" });
        const ans = (await get("ans:" + s.login)) || {};
        ans[String(body.qid).slice(0, 20)] = typeof body.choice === "string" ? body.choice.slice(0, 3000) : Number(body.choice); await set("ans:" + s.login, ans);
        return send(200, { ok: true });
      }
      if (P === "/api/submit" && M === "POST") { if (s.startedAt && !s.submitted) await finish(s); return send(200, await view(s)); }
      if (P === "/api/event" && M === "POST") {
        await check(s);
        if (s.startedAt && !s.submitted && ["left", "screenshot", "copy"].includes(body.type)) {
          const t = Date.now();
          await set(`a:${pad(t)}-${rid().slice(0, 4)}`, { id: t, t, login: s.login, name: s.name, type: body.type, detail: String(body.detail || "").slice(0, 100) });
          if (body.type === "left") await set("l:" + s.login, ((await get("l:" + s.login)) || 0) + 1);
        }
        return send(200, { ok: true });
      }
    }

    if (ses.role === "teacher") {
      const lk = await get("tlock"); if (!lk || lk.token !== tok) return send(401, { error: "Sessiya tugagan" });
      if (P === "/api/t/state" && M === "GET") {
        const since = Number(u.searchParams.get("since")) || 0;
        const students = await studentsList();
        const keys = (await list("a:")).blobs.map(b => b.key).filter(k => Number(k.slice(2, 17)) > since).slice(-50);
        const alerts = (await Promise.all(keys.map(k => get(k)))).filter(Boolean);
        return send(200, { students, questions: (await get("q")) || [], alerts });
      }
      if (P === "/api/t/question" && M === "POST") {
        const type = ["mcq", "text", "code", "practice"].includes(body.type) ? body.type : "mcq";
        const text = String(body.text || "").trim().slice(0, 1000);
        const q = { id: rid().slice(0, 8), type, text, pts: Math.min(100, Math.max(1, Math.round(Number(body.pts) || 1))) };
        if (type === "mcq") {
          q.options = (Array.isArray(body.options) ? body.options : []).map(o => String(o).trim().slice(0, 200)).filter(Boolean);
          q.correct = Number(body.correct);
          if (!text || q.options.length < 2 || !(q.correct >= 0 && q.correct < q.options.length)) return send(400, { error: "Savol, kamida 2 variant va to‘g‘ri javobni kiriting" });
        } else {
          q.answer = String(body.answer || "").trim().slice(0, 1000); q.starter = String(body.starter || "").slice(0, 2000);
          if (!text || (type !== "practice" && !q.answer)) return send(400, { error: "Masala matni va to‘g‘ri javobni kiriting" });
        }
        const qs = (await get("q")) || []; qs.push(q); await set("q", qs);
        return send(200, { ok: true });
      }
      if (P === "/api/t/points" && M === "POST") {
        const f = Number(body.from), t = Number(body.to), pts = Math.min(100, Math.max(1, Math.round(Number(body.points) || 1)));
        if (!(f >= 1 && t >= f)) return send(400, { error: "Oraliqni to‘g‘ri kiriting (masalan 1 dan 10 gacha)" });
        const qs = (await get("q")) || []; qs.forEach((q, i) => { if (i + 1 >= f && i + 1 <= t) q.pts = pts; }); await set("q", qs);
        return send(200, { ok: true });
      }
      if (P.startsWith("/api/t/question/") && M === "DELETE") {
        const id = P.split("/").pop();
        await set("q", ((await get("q")) || []).filter(q => q.id !== id));
        return send(200, { ok: true });
      }
    }
    if ((ses.role === "teacher" || ses.role === "admin") && P.startsWith("/api/m/")) {
      if (ses.role === "admin" && !(await adminOk(tok))) return send(401, { error: "Sessiya tugagan" });
      if (ses.role === "teacher") { const lk = await get("tlock"); if (!lk || lk.token !== tok) return send(401, { error: "Sessiya tugagan" }); }
      if (P === "/api/m/history" && M === "GET") {
        const tail = async pre => (await Promise.all((await list(pre)).blobs.map(b => b.key).slice(-200).map(k => get(k)))).filter(Boolean).reverse();
        return send(200, { results: await tail("r:"), alerts: await tail("a:") });
      }
      if (P === "/api/m/setpass" && M === "POST") {
        const l = String(body.login || ""), pw = String(body.password || ""), s = await get("s:" + l);
        if (!s) return send(404, { error: "Student topilmadi" }); if (pw.length < 4) return send(400, { error: "Parol kamida 4 belgi bo‘lsin" });
        s.salt = rid(); s.hash = hash(pw, s.salt); await set("s:" + l, s); return send(200, { ok: true });
      }
      if (P === "/api/m/retake" && M === "POST") {
        const l = String(body.login || ""), s = await get("s:" + l); if (!s) return send(404, { error: "Student topilmadi" });
        ["startedAt", "submitted", "score", "total", "n", "correct"].forEach(k => delete s[k]);
        await set("s:" + l, s); await store.delete("ans:" + l); return send(200, { ok: true });
      }
    }
    if (ses.role === "admin") {
      if (!(await adminOk(tok))) return send(401, { error: "Sessiya tugagan" });
      if (P === "/api/a/state" && M === "GET") return send(200, { students: await studentsList(), teacherBusy: !!(await get("tlock")) });
      if (P === "/api/a/release" && M === "POST") { await store.delete("tlock"); return send(200, { ok: true }); }
      if (P === "/api/a/clear" && M === "POST") { for (const pre of ["r:", "a:"]) for (const b of (await list(pre)).blobs) await store.delete(b.key); return send(200, { ok: true }); }
      if (P.startsWith("/api/a/student/") && M === "DELETE") { const l = decodeURIComponent(P.split("/").pop()); for (const k of ["s:", "ans:", "l:"]) await store.delete(k + l); return send(200, { ok: true }); }
    }
    return send(404, { error: "Topilmadi" });
  } catch (e) { console.error(e); return send(500, { error: "Server xatosi (" + ((e && e.name) || "xato") + "). Qayta urinib ko‘ring" }); }
};

export const config = { path: "/api/*" };
