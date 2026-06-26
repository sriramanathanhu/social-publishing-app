#!/usr/bin/env sh
# Download the OpenCV Zoo face re-identification models (YuNet detector + SFace
# recognizer) into assets/models, verifying SHA-256. Idempotent — skips files
# that are already present and valid. Used by the Dockerfile build and for local
# (non-Docker) runs: `sh dubber-service/scripts/fetch_models.sh`.
#
# The ~38MB SFace model is intentionally NOT committed; this keeps clean builds
# self-contained without a large binary / git-LFS dependency.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DIR="${1:-$SCRIPT_DIR/../assets/models}"
mkdir -p "$DIR"

YUNET_URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
YUNET_SHA="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
SFACE_URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"
SFACE_SHA="0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"

if command -v sha256sum >/dev/null 2>&1; then
	sha_of() { sha256sum "$1" | awk '{print $1}'; }
else
	sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

fetch() {
	name="$1"; url="$2"; want="$3"; dest="$DIR/$name"
	if [ -f "$dest" ] && [ "$(sha_of "$dest")" = "$want" ]; then
		echo "ok: $name (cached)"
		return 0
	fi
	echo "downloading: $name"
	curl -fsSL -o "$dest" "$url"
	got="$(sha_of "$dest")"
	if [ "$got" != "$want" ]; then
		echo "checksum mismatch for $name: got $got, want $want" >&2
		rm -f "$dest"
		exit 1
	fi
	echo "ok: $name"
}

fetch "face_detection_yunet_2023mar.onnx" "$YUNET_URL" "$YUNET_SHA"
fetch "face_recognition_sface_2021dec.onnx" "$SFACE_URL" "$SFACE_SHA"
