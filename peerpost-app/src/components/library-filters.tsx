"use client";

// Shared "date / language / user" filters for the Library galleries.

export type FilterMeta = {
	lang: string | null;
	author: string;
	createdAt: string;
};

// "Date generated" presets (days back; 0 = all time).
export const DATE_PRESETS: [string, number][] = [
	["All dates", 0],
	["Last 24 hours", 1],
	["Last 7 days", 7],
	["Last 30 days", 30],
	["Last 90 days", 90],
];

export function passesMeta(
	i: FilterMeta,
	lang: string,
	user: string,
	date: number,
): boolean {
	if (lang !== "all" && i.lang !== lang) return false;
	if (user !== "all" && i.author !== user) return false;
	if (date && new Date(i.createdAt).getTime() < Date.now() - date * 86_400_000)
		return false;
	return true;
}

const SELECT_CLASS = "rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm";

/** Distinct, sorted languages / authors present in a set of items. */
export function metaOptions(items: FilterMeta[]): {
	langs: string[];
	users: string[];
} {
	const langs = [
		...new Set(items.map((i) => i.lang).filter((l): l is string => !!l)),
	].sort();
	const users = [...new Set(items.map((i) => i.author).filter(Boolean))].sort();
	return { langs, users };
}

export function LibraryFilters({
	langs,
	users,
	lang,
	setLang,
	user,
	setUser,
	date,
	setDate,
}: {
	langs: string[];
	users: string[];
	lang: string;
	setLang: (v: string) => void;
	user: string;
	setUser: (v: string) => void;
	date: number;
	setDate: (v: number) => void;
}) {
	return (
		<>
			{langs.length > 0 && (
				<select
					value={lang}
					onChange={(e) => setLang(e.target.value)}
					className={SELECT_CLASS}
					title="Filter by language"
				>
					<option value="all">All languages</option>
					{langs.map((l) => (
						<option key={l} value={l}>
							{l}
						</option>
					))}
				</select>
			)}
			{users.length > 1 && (
				<select
					value={user}
					onChange={(e) => setUser(e.target.value)}
					className={SELECT_CLASS}
					title="Filter by who generated / translated it"
				>
					<option value="all">All users</option>
					{users.map((u) => (
						<option key={u} value={u}>
							{u}
						</option>
					))}
				</select>
			)}
			<select
				value={date}
				onChange={(e) => setDate(Number(e.target.value))}
				className={SELECT_CLASS}
				title="Filter by date generated"
			>
				{DATE_PRESETS.map(([label, days]) => (
					<option key={days} value={days}>
						{label}
					</option>
				))}
			</select>
		</>
	);
}
