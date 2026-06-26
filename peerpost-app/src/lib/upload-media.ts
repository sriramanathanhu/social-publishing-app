/**
 * Upload a file to object storage via the server-side /api/media/upload route and
 * return its public URL. Single source of truth for the browser→storage upload
 * contract (form field "file", JSON `{ publicUrl }` response) used by the shorts
 * studio (reference face) and shorts assets (overlay/transition/end card).
 */
export async function uploadMedia(file: File): Promise<string> {
	const fd = new FormData();
	fd.append("file", file);
	const res = await fetch("/api/media/upload", { method: "POST", body: fd });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? "Upload failed");
	return data.publicUrl as string;
}
