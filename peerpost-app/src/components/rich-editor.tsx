"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

/**
 * WYSIWYG article editor. Edits render as a formatted document (headings, bold,
 * lists) via a toolbar — no markdown symbols visible — but serialises back to
 * markdown so storage/download stay markdown. Remount via `key={article.id}` to
 * load a different article (content is the initial value, not a synced prop).
 */
export function RichEditor({
	markdown,
	onChange,
}: {
	markdown: string;
	onChange: (markdown: string) => void;
}) {
	const editor = useEditor({
		extensions: [
			StarterKit,
			Markdown.configure({ html: false, transformPastedText: true }),
		],
		content: markdown,
		immediatelyRender: false,
		editorProps: {
			attributes: {
				class: "article-editor min-h-[55vh] text-sm text-slate-800",
			},
		},
		onUpdate: ({ editor }) =>
			onChange(
				(
					editor.storage as unknown as {
						markdown: { getMarkdown: () => string };
					}
				).markdown.getMarkdown(),
			),
	});

	if (!editor) return null;

	const btn = (active: boolean) =>
		`rounded px-2 py-1 text-sm ${active ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`;

	return (
		<div className="rounded-lg border border-slate-300">
			<div className="flex flex-wrap items-center gap-1 border-slate-200 border-b p-1.5">
				<button
					type="button"
					title="Bold"
					onClick={() => editor.chain().focus().toggleBold().run()}
					className={btn(editor.isActive("bold"))}
				>
					<strong>B</strong>
				</button>
				<button
					type="button"
					title="Italic"
					onClick={() => editor.chain().focus().toggleItalic().run()}
					className={btn(editor.isActive("italic"))}
				>
					<em>I</em>
				</button>
				<span className="mx-1 h-5 w-px bg-slate-200" />
				<button
					type="button"
					title="Heading 1"
					onClick={() =>
						editor.chain().focus().toggleHeading({ level: 1 }).run()
					}
					className={btn(editor.isActive("heading", { level: 1 }))}
				>
					H1
				</button>
				<button
					type="button"
					title="Heading 2"
					onClick={() =>
						editor.chain().focus().toggleHeading({ level: 2 }).run()
					}
					className={btn(editor.isActive("heading", { level: 2 }))}
				>
					H2
				</button>
				<button
					type="button"
					title="Heading 3"
					onClick={() =>
						editor.chain().focus().toggleHeading({ level: 3 }).run()
					}
					className={btn(editor.isActive("heading", { level: 3 }))}
				>
					H3
				</button>
				<span className="mx-1 h-5 w-px bg-slate-200" />
				<button
					type="button"
					title="Bullet list"
					onClick={() => editor.chain().focus().toggleBulletList().run()}
					className={btn(editor.isActive("bulletList"))}
				>
					• List
				</button>
				<button
					type="button"
					title="Numbered list"
					onClick={() => editor.chain().focus().toggleOrderedList().run()}
					className={btn(editor.isActive("orderedList"))}
				>
					1. List
				</button>
				<button
					type="button"
					title="Quote"
					onClick={() => editor.chain().focus().toggleBlockquote().run()}
					className={btn(editor.isActive("blockquote"))}
				>
					&ldquo; Quote
				</button>
				<span className="mx-1 h-5 w-px bg-slate-200" />
				<button
					type="button"
					title="Undo"
					onClick={() => editor.chain().focus().undo().run()}
					className={btn(false)}
				>
					↶
				</button>
				<button
					type="button"
					title="Redo"
					onClick={() => editor.chain().focus().redo().run()}
					className={btn(false)}
				>
					↷
				</button>
			</div>
			<div className="p-3">
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
