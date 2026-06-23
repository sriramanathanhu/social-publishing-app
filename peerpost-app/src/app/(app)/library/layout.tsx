import { LibraryTabs } from "@/components/library-tabs";
import { requirePageUser } from "@/lib/page-auth";

/** Library shell: a header with sub-section tabs over a scrollable body. */
export default async function LibraryLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requirePageUser();
	return (
		<div className="flex h-full flex-col">
			<div className="border-slate-200 border-b px-6 py-3">
				<h1 className="font-bold text-slate-900 text-xl">Library</h1>
				<LibraryTabs />
			</div>
			<div className="flex-1 overflow-y-auto p-6">{children}</div>
		</div>
	);
}
