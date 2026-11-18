import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const T_USER = process.env.TEACHER_USER || "Umid@";
const T_PASS = process.env.TEACHER_PASS || "UmidjonSamadov";
const A_USER = process.env.ADMIN_USER || "admin";
const A_PASS = process.env.ADMIN_PASS || "Admin#2026";
const DURATION = 2 * 3600 * 1000; // har bir oylik test uchun 2 soat
const MIN_PRACTICE = 40;          // amaliy javob uchun eng kam belgi
const store = getStore({ name: "online-test", consistency: "strong" });
const retry = async f => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 200 * (i + 1) + Math.random() * 150)); } } };
const get = k => retry(() => store.get(k, { type: "json" }));
const set = (k, v) => retry(() => store.setJSON(k, v));
const list = pre => retry(() => store.list({ prefix: pre }));
const qc = { v: null, t: 0 };
const getQ = async () => { if (qc.v && Date.now() - qc.t < 3000) return qc.v; qc.v = (await get("q")) || []; qc.t = Date.now(); return qc.v; };
const setQ = async v => { await set("q", v); qc.v = v; qc.t = Date.now(); };

const rid = () => crypto.randomBytes(16).toString("hex");
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pad = n => String(n).padStart(15, "0");
const send = (c, o) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json" } });

const r2 = x => Math.round(x * 100) / 100;
const pt = v => { const n = Number(String(v ?? "").replace(",", ".")); return n > 0 ? Math.min(100, r2(n)) : 1; };
const norm = x => String(x ?? "").replace(/\r/g, "").split("\n").map(l => l.trimEnd()).join("\n").trim().toLowerCase();
const plen = x => String(x ?? "").replace(/\s+/g, " ").trim().length;
const ok = (q, a) => { const t = q.type || "mcq"; if (t === "mcq") return a === q.correct; if (t === "practice") return plen(a) >= MIN_PRACTICE; return norm(a) === norm(q.answer); };

// ---- oylik testlar: 1 (eski ma'lumot bilan mos), 2 va 3 ----
const MS = [1, 2, 3];
const pm = v => { const k = Number(v); return k === 2 || k === 3 ? k : 1; };
const mq = (qs, k) => qs.filter(q => (q.m || 1) === k);
const akey = (k, l) => (k === 1 ? "s:" : "t" + k + ":") + l;      // urinish yozuvi (1-oy: talaba yozuvining o‘zi)
const askey = (k, l) => (k === 1 ? "ans:" : "ans" + k + ":") + l; // javoblar
const getAtt = async (k, s) => k === 1 ? s : ((await get(akey(k, s.login))) || { login: s.login, name: s.name });
const saveAtt = (k, a) => set(akey(k, a.login), a);
const scoreOf = (qs, ans) => { const good = qs.filter(q => ok(q, ans[q.id])); return { n: qs.length, correct: good.length, total: r2(qs.reduce((a, q) => a + (q.pts || 1), 0)), score: r2(good.reduce((a, q) => a + (q.pts || 1), 0)) }; };

async function finish(a, k) {
  const qs = mq(await getQ(), k), ans = (await get(askey(k, a.login))) || {};
  Object.assign(a, scoreOf(qs, ans)); a.submitted = true;
  const t = Date.now(), rkey = "r:" + pad(t) + "-" + a.login; a.rkey = rkey;
  await saveAtt(k, a);
  await set(rkey, { t, m: k, login: a.login, name: a.name, score: a.score, total: a.total, correct: a.correct, n: a.n });
}
async function check(a, k) { if (a.startedAt && !a.submitted && Date.now() > a.startedAt + DURATION) await finish(a, k); }
async function view(s, a, k) {
  await check(a, k);
  const run = a.startedAt && !a.submitted, qs = mq(await getQ(), k);
  return {
    name: s.name, m: k, count: qs.length, started: !!a.startedAt, submitted: !!a.submitted,
    score: a.submitted ? a.score : null, correct: a.correct || 0, n: a.n || 0, total: a.total || 0,
    remaining: run ? Math.max(0, a.startedAt + DURATION - Date.now()) : DURATION,
    questions: run ? qs.map(q => ({ id: q.id, text: q.text, options: q.options, type: q.type || "mcq", pts: q.pts || 1 })) : [],
    stars: a.stars || 0, answers: (await get(askey(k, s.login))) || {}
  };
}

const ALIVE = 15 * 60 * 1000; // admin: 15 daqiqa faolsizlikdan keyin o‘rin bo‘shaydi
const adminBusy = async () => { const a = await get("alock"); return !!a && Date.now() - a.t < ALIVE; };
const adminOk = async tok => { const a = await get("alock"); if (!a || a.token !== tok || Date.now() - a.t > ALIVE) return false; if (Date.now() - a.t > 60000) await set("alock", { token: tok, t: Date.now() }); return true; };

async function rescoreAll() {
  const qs = (await get("q")) || [];
  const [S, T2, T3] = await Promise.all([list("s:"), list("t2:"), list("t3:")]);
  const items = [...S.blobs.map(b => [1, b.key]), ...T2.blobs.map(b => [2, b.key]), ...T3.blobs.map(b => [3, b.key])];
  for (let i = 0; i < items.length; i += 8) {
    await Promise.all(items.slice(i, i + 8).map(async ([k, key]) => {
      const a = await get(key); if (!a || !a.submitted) return;
      Object.assign(a, scoreOf(mq(qs, k), (await get(askey(k, a.login))) || {})); await set(key, a);
      if (a.rkey) { const r = await get(a.rkey); if (r) await set(a.rkey, { ...r, score: a.score, total: a.total, correct: a.correct, n: a.n }); }
    }));
  }
}

const rowOf = (s, a, k, left) => ({ name: s.name, login: s.login, m: k, left: left || 0, score: a.score, total: a.total, correct: a.correct, n: a.n, stars: a.stars || 0,
  status: a.submitted ? "done" : a.startedAt ? "running" : "waiting",
  remaining: a.startedAt && !a.submitted ? Math.max(0, a.startedAt + DURATION - Date.now()) : null });
async function studentsList() {
  const [S, T2, T3] = await Promise.all([list("s:"), list("t2:"), list("t3:")]), extra = {};
  await Promise.all([[2, T2], [3, T3]].flatMap(([k, L]) => L.blobs.map(async b => { const a = await get(b.key); if (a) (extra[a.login] ||= {})[k] = a; })));
  const rows = [];
  await Promise.all(S.blobs.map(async b => {
    const l = b.key.slice(2), [s, left] = await Promise.all([get(b.key), get("l:" + l)]); if (!s) return;
    let any = false;
    for (const [k, a] of [[1, s], ...Object.entries(extra[l] || {}).map(([k, a]) => [Number(k), a])]) { await check(a, k); if (!a.startedAt) continue; any = true; rows.push(rowOf(s, a, k, left)); }
    if (!any) rows.push(rowOf(s, {}, 0, left));
  }));
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.m - b.m);
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
      let good = false;
      if (body.role === "teacher") good = login === T_USER.toLowerCase() && same(sha(pw), sha(T_PASS));
      else if (body.role === "admin") good = login === A_USER.toLowerCase() && same(sha(pw), sha(A_PASS));
      else if (/^[a-z0-9_.@-]{3,30}$/.test(login)) { const s = await get("s:" + login); good = !!s && same(hash(pw, s.salt), s.hash); }
      if (!good) return send(401, { error: "Login yoki parol noto‘g‘ri" });
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
      const k = pm(body.m ?? u.searchParams.get("m"));
      if (P === "/api/months" && M === "GET") {
        const qs = await getQ();
        const months = await Promise.all(MS.map(async m => {
          const a = await getAtt(m, s); await check(a, m);
          return { m, count: mq(qs, m).length, status: a.submitted ? "done" : a.startedAt ? "running" : "waiting", correct: a.correct || 0, n: a.n || 0 };
        }));
        return send(200, { name: s.name, months });
      }
      if (P === "/api/stars" && M === "POST") {
        const a = await getAtt(k, s); await check(a, k); if (!a.submitted) return send(400, { error: "Avval testni yakunlang" });
        a.stars = Math.min(5, Math.max(1, Math.round(Number(body.stars) || 0))); await saveAtt(k, a); return send(200, { ok: true });
      }
      if (P === "/api/test" && M === "GET") return send(200, await view(s, await getAtt(k, s), k));
      if (P === "/api/start" && M === "POST") {
        const a = await getAtt(k, s);
        if (!a.startedAt) {
          if (!mq(await getQ(), k).length) return send(400, { error: "Bu oy uchun hozircha test mavjud emas" });
          for (const m2 of MS) if (m2 !== k) { const b = await getAtt(m2, s); await check(b, m2); if (b.startedAt && !b.submitted) return send(400, { error: "Avval boshlangan " + m2 + "-oylik testni tugating" }); }
          a.startedAt = Date.now(); await saveAtt(k, a);
        }
        return send(200, await view(s, a, k));
      }
      if (P === "/api/answer" && M === "POST") {
        const a = await getAtt(k, s); await check(a, k);
        if (!a.startedAt || a.submitted) return send(400, { error: "Test yopilgan" });
        const ans = (await get(askey(k, s.login))) || {};
        ans[String(body.qid).slice(0, 20)] = typeof body.choice === "string" ? body.choice.slice(0, 3000) : Number(body.choice); await set(askey(k, s.login), ans);
        return send(200, { ok: true });
      }
      if (P === "/api/submit" && M === "POST") {
        const a = await getAtt(k, s);
        if (a.startedAt && !a.submitted) {
          if (body.answers && typeof body.answers === "object" && Date.now() <= a.startedAt + DURATION + 15000) {
            const ids = new Set(mq(await getQ(), k).map(q => q.id)), ans = (await get(askey(k, s.login))) || {};
            for (const [id, v] of Object.entries(body.answers)) if (ids.has(id) && (typeof v === "number" || typeof v === "string")) ans[id] = typeof v === "string" ? v.slice(0, 3000) : v;
            await set(askey(k, s.login), ans);
          }
          await finish(a, k);
        }
        return send(200, await view(s, a, k));
      }
      if (P === "/api/event" && M === "POST") {
        const a = await getAtt(k, s); await check(a, k);
        if (a.startedAt && !a.submitted && ["left", "screenshot", "copy"].includes(body.type)) {
          const t = Date.now();
          await set(`a:${pad(t)}-${rid().slice(0, 4)}`, { id: t, t, m: k, login: s.login, name: s.name, type: body.type, detail: String(body.detail || "").slice(0, 100) });
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
        const q = { id: rid().slice(0, 8), type, text, pts: pt(body.pts), m: pm(body.m) };
        if (type === "mcq") {
          q.options = (Array.isArray(body.options) ? body.options : []).map(o => String(o).trim().slice(0, 200)).filter(Boolean);
          q.correct = Number(body.correct);
          if (!text || q.options.length < 2 || !(q.correct >= 0 && q.correct < q.options.length)) return send(400, { error: "Savol, kamida 2 variant va to‘g‘ri javobni kiriting" });
        } else {
          q.answer = String(body.answer || "").trim().slice(0, 1000);
          if (!text || (type !== "practice" && !q.answer)) return send(400, { error: "Masala matni va to‘g‘ri javobni kiriting" });
        }
        const qs = (await get("q")) || []; qs.push(q); await setQ(qs);
        return send(200, { ok: true });
      }
      if (P === "/api/t/points" && M === "POST") {
        const f = Number(body.from), t = Number(body.to), pts = pt(body.points), k = pm(body.m);
        if (!(f >= 1 && t >= f)) return send(400, { error: "Oraliqni to‘g‘ri kiriting (masalan 1 dan 10 gacha)" });
        const qs = (await get("q")) || []; let idx = 0;
        qs.forEach(q => { if ((q.m || 1) === k) { idx++; if (idx >= f && idx <= t) q.pts = pts; } });
        await setQ(qs); await rescoreAll(); return send(200, { ok: true });
      }
      if (P === "/api/t/correct" && M === "POST") {
        const qs = (await get("q")) || [], q = qs.find(x => x.id === body.id), c = Number(body.correct);
        if (!q || (q.type || "mcq") !== "mcq" || !(c >= 0 && c < q.options.length)) return send(400, { error: "Savol yoki variant topilmadi" });
        q.correct = c; await setQ(qs); await rescoreAll(); return send(200, { ok: true });
      }
      if (P === "/api/t/rescore" && M === "POST") { await rescoreAll(); return send(200, { ok: true }); }
      if (P === "/api/t/import" && M === "POST") {
        const qs = (await get("q")) || []; let added = 0;
        for (const x of (Array.isArray(body.questions) ? body.questions : []).slice(0, 200)) {
          const type = ["mcq", "text", "code", "practice"].includes(x.type) ? x.type : "mcq", text = String(x.text || "").trim().slice(0, 1000), m = pm(x.m);
          if (!text || qs.some(q => q.text === text && (q.m || 1) === m)) continue;
          const q = { id: rid().slice(0, 8), type, text, pts: pt(x.pts), m };
          if (type === "mcq") {
            q.options = (Array.isArray(x.options) ? x.options : []).map(o => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 6); q.correct = Number(x.correct);
            if (q.options.length < 2 || !(q.correct >= 0 && q.correct < q.options.length)) continue;
          } else if (type !== "practice") { q.answer = String(x.answer || "").trim().slice(0, 1000); if (!q.answer) continue; }
          qs.push(q); added++;
        }
        await setQ(qs); return send(200, { ok: true, added });
      }
      if (P === "/api/t/clear" && M === "POST") { const k = Number(body.m); await setQ(k ? ((await get("q")) || []).filter(q => (q.m || 1) !== k) : []); return send(200, { ok: true }); }
      if (P.startsWith("/api/t/question/") && M === "DELETE") {
        const id = P.split("/").pop();
        await setQ(((await get("q")) || []).filter(q => q.id !== id));
        return send(200, { ok: true });
      }
    }
    if ((ses.role === "teacher" || ses.role === "admin") && P.startsWith("/api/m/")) {
      if (ses.role === "admin" && !(await adminOk(tok))) return send(401, { error: "Sessiya tugagan" });
      if (ses.role === "teacher") { const lk = await get("tlock"); if (!lk || lk.token !== tok) return send(401, { error: "Sessiya tugagan" }); }
      if (P === "/api/m/answers" && M === "GET") {
        const l = String(u.searchParams.get("login") || "").toLowerCase(), s = await get("s:" + l), k = pm(u.searchParams.get("m"));
        if (!s) return send(404, { error: "Student topilmadi" });
        const a = await getAtt(k, s), qs = mq((await get("q")) || [], k), ans = (await get(askey(k, l))) || {};
        return send(200, { student: { name: s.name, login: s.login, m: k, status: a.submitted ? "done" : a.startedAt ? "running" : "waiting", correct: a.correct, n: a.n, score: a.score, total: a.total },
          items: qs.map(q => { const g = ans[q.id]; return { id: q.id, type: q.type || "mcq", text: q.text, options: q.options, pts: q.pts || 1, correct: q.correct, answer: q.answer, given: g, answered: g !== undefined && String(g).trim() !== "", good: ok(q, g) }; }) });
      }
      if (P === "/api/m/rating" && M === "GET") {
        const k = pm(u.searchParams.get("m")), all = await studentsList(), rows = all.filter(x => x.m === k), rated = rows.filter(x => x.stars);
        const lst = rows.filter(x => x.status === "done").map(x => ({ ...x, pct: x.total ? Math.round(x.score / x.total * 100) : 0 })).sort((a, b) => b.score - a.score || b.pct - a.pct || a.name.localeCompare(b.name));
        return send(200, { m: k, total: new Set(all.map(x => x.login)).size, done: lst.length, list: lst, rated: rated.length, avgStars: rated.length ? Math.round(rated.reduce((a, x) => a + x.stars, 0) / rated.length * 10) / 10 : 0 });
      }
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
        const l = String(body.login || ""), s = await get("s:" + l), k = pm(body.m); if (!s) return send(404, { error: "Student topilmadi" });
        if (k === 1) { ["startedAt", "submitted", "score", "total", "n", "correct", "rkey"].forEach(f => delete s[f]); await set("s:" + l, s); }
        else await store.delete(akey(k, l));
        await store.delete(askey(k, l)); return send(200, { ok: true });
      }
    }
    if (ses.role === "admin") {
      if (!(await adminOk(tok))) return send(401, { error: "Sessiya tugagan" });
      if (P === "/api/a/state" && M === "GET") return send(200, { students: await studentsList(), teacherBusy: !!(await get("tlock")) });
      if (P === "/api/a/release" && M === "POST") { await store.delete("tlock"); return send(200, { ok: true }); }
      if (P === "/api/a/clear" && M === "POST") { for (const pre of ["r:", "a:"]) for (const b of (await list(pre)).blobs) await store.delete(b.key); return send(200, { ok: true }); }
      if (P.startsWith("/api/a/student/") && M === "DELETE") { const l = decodeURIComponent(P.split("/").pop()); for (const k of ["s:", "t2:", "t3:", "ans:", "ans2:", "ans3:", "l:"]) await store.delete(k + l); return send(200, { ok: true }); }
    }
    return send(404, { error: "Topilmadi" });
  } catch (e) { console.error(e); return send(500, { error: "Server xatosi (" + ((e && e.name) || "xato") + "). Qayta urinib ko‘ring" }); }
};

export const config = { path: "/api/*" };
    