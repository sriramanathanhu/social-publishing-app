// Global reconcile: sync every queued/running shorts job's DB status to the
// sidecar's actual state (persisting clips for done ones). No restart, no
// re-doing work — just makes the UI honest. Reports orphans (sidecar 404).
import postgres from "/root/peerpost/peerpost-app/node_modules/postgres/src/index.js";

const TOKEN = process.env.DUBBER_SERVICE_TOKEN;
const DB = process.env.DATABASE_URL;
const SIDECAR = "http://127.0.0.1:8800";
const auth = { Authorization: `Bearer ${TOKEN}` };
const sql = postgres(DB, { prepare: false });
const round = (v) => (v == null ? null : Math.round(v));

const jobs = await sql`
	select id, shorts_job_id from shorts_jobs
	where status in ('queued','running') and shorts_job_id is not null`;

let done = 0, running = 0, queued = 0, failed = 0, orphan = 0;
const orphanIds = [];
for (const j of jobs) {
	let res;
	try {
		res = await fetch(`${SIDECAR}/shorts/${j.shorts_job_id}`, { headers: auth });
	} catch {
		continue;
	}
	if (res.status === 404) { orphan++; orphanIds.push(j.id); continue; }
	if (!res.ok) continue;
	const st = await res.json();
	const status = st.status;
	if (status === "done") {
		try {
			const cr = await fetch(`${SIDECAR}/shorts/${j.shorts_job_id}/clips`, { headers: auth });
			const { clips = [] } = await cr.json();
			await sql`delete from shorts_clips where job_id = ${j.id}`;
			for (const c of clips) {
				await sql`insert into shorts_clips
					(job_id, idx, title, description, hashtags, start_sec, end_sec, duration_sec, viral_score, public_url)
					values (${j.id}, ${c.idx}, ${c.youtube_title ?? c.title ?? null},
					        ${c.youtube_description ?? null}, ${sql.json(c.hashtags ?? [])},
					        ${round(c.start_seconds)}, ${round(c.end_seconds)}, ${round(c.duration)},
					        ${c.viral_score ?? null}, ${c.public_url ?? null})`;
			}
			await sql`update shorts_jobs set status='done', pct=100, completed_at=now(), updated_at=now() where id=${j.id}`;
			done++;
		} catch (e) {
			console.log("clip persist error", j.id, e.message);
		}
	} else if (status === "failed") {
		await sql`update shorts_jobs set status='failed', error=${st.error ?? "failed"}, completed_at=now(), updated_at=now() where id=${j.id}`;
		failed++;
	} else {
		await sql`update shorts_jobs set status=${status}, pct=${st.pct ?? 0}, stage=${st.stage ?? null}, message=${st.message ?? null}, updated_at=now() where id=${j.id}`;
		if (status === "running") running++; else queued++;
	}
}
console.log(JSON.stringify({ scanned: jobs.length, done, running, queued, failed, orphan }));
if (orphanIds.length) console.log("orphan job ids:", orphanIds.join(","));
await sql.end();
