import { redirect } from "next/navigation";

/** Gallery moved into the Library. */
export default function GalleryRedirect() {
	redirect("/library/photo");
}
