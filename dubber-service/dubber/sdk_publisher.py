"""
Simple Zernio SDK Publisher
Replaces complex custom publishing with official SDK
"""

import os
import mimetypes
import subprocess
import time
from zernio import (
    Zernio,
    ZernioAPIError,
    ZernioAuthenticationError,
    ZernioConnectionError,
    ZernioRateLimitError,
    ZernioTimeoutError,
)
from dubber.config import get_platform_accounts
from dubber.bluesky_poster import get_bluesky_poster
from dubber.publish_guard import reserve_publish_attempt
from dubber.youtube_poster import get_selected_youtube_targets, publish_direct_youtube
from dubber.utils import log, PLATFORM_LIMITS

TWITTER_RETRY_ATTEMPTS = 3
TWITTER_RETRY_BACKOFF_SECONDS = (5, 15)


def _dedupe_platform_names(platforms):
    """Return platform list without duplicates, preserving original order."""
    out = []
    seen = set()
    for p in platforms or []:
        key = str(p or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def _dedupe_platform_entries(entries):
    """Return platform entries without duplicates, preserving original order."""
    out = []
    seen = set()
    for entry in entries or []:
        key = str((entry or {}).get("platform", "")).strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(entry)
    return out


def _extract_public_url(upload_result):
    """Handle SDK upload responses returned as dicts or typed objects."""
    if isinstance(upload_result, dict):
        if upload_result.get("publicUrl") or upload_result.get("public_url"):
            return upload_result.get("publicUrl") or upload_result.get("public_url")
        files = upload_result.get("files")
        if isinstance(files, list) and files:
            first = files[0]
            if isinstance(first, dict):
                return (
                    first.get("url")
                    or first.get("publicUrl")
                    or first.get("public_url")
                )
    direct = getattr(upload_result, "publicUrl", None) or getattr(
        upload_result, "public_url", None
    )
    if direct:
        return direct
    files_attr = getattr(upload_result, "files", None)
    if isinstance(files_attr, list) and files_attr:
        first = files_attr[0]
        if isinstance(first, dict):
            return first.get("url") or first.get("publicUrl") or first.get("public_url")
        url_attr = (
            getattr(first, "url", None)
            or getattr(first, "publicUrl", None)
            or getattr(first, "public_url", None)
        )
        if url_attr:
            return str(url_attr)
    return None


def _fit_platform_content(platform, text):
    """Clamp content to platform hard limits."""
    content = str(text or "").strip()
    limit = PLATFORM_LIMITS.get(platform)
    if not limit or len(content) <= limit:
        return content
    ellipsis = "..."
    cut = max(0, limit - len(ellipsis))
    return content[:cut].rstrip() + ellipsis


def _is_unconfirmed_publish_error(exc):
    """Errors that may happen after the server accepted a publish request."""
    text = str(exc or "").strip().lower()
    return any(
        token in text
        for token in (
            "jsondecodeerror",
            "expecting value: line 1 column 1 (char 0)",
            "forcibly closed by the remote host",
            "winerror 10054",
            "connection reset",
            "remote host closed",
        )
    )


# Meta's API (Instagram, Facebook, Threads) routinely accepts a publish
# request and then drops the connection before sending the ack. When we see
# a WinError 10054 / connection reset mid-call on these platforms, the post
# has almost always landed. Treat it as "likely_live" so the user is guided
# to verify the dashboard instead of republishing and creating duplicates.
_META_LIKELY_LIVE_ON_RESET = {"instagram", "facebook", "threads"}


def _make_unconfirmed_results(platforms, reason, progress_cb=None, done=0, total=None):
    """Return per-platform unconfirmed results and surface progress.

    Meta platforms with a mid-call connection reset get reclassified as
    "likely_live" (see _META_LIKELY_LIVE_ON_RESET). Other platforms stay
    "unconfirmed" — their APIs don't have the same drop-after-accept pattern.
    """
    total = total or len(platforms)
    results = {}
    for idx, platform in enumerate(platforms, start=1):
        platform_l = str(platform or "").lower()
        is_meta_live_like = platform_l in _META_LIKELY_LIVE_ON_RESET
        if is_meta_live_like:
            status = "likely_live"
            message = (
                f"{platform_l.title()} connection reset after submit — the post likely went live. "
                "Verify the dashboard/feed before retrying to avoid duplicates."
            )
        else:
            status = "unconfirmed"
            message = reason
        if progress_cb:
            progress_cb(min(done + idx, total), total, platform, status)
        results[platform] = {
            "status": status,
            "platform": platform,
            "error": message,
            "error_message": message,
        }
    return results


def _probe_video_duration_seconds(path):
    if not path or not os.path.exists(path):
        return None
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return float((result.stdout or "").strip())
    except Exception:
        return None


def _publish_direct_bluesky(
    content,
    guard_media_path,
    progress_cb=None,
    total_platforms=1,
    done_offset=0,
    image_paths=None,
    video_path=None,
):
    """Publish directly to Bluesky using env-based credentials."""
    if progress_cb:
        progress_cb(done_offset, total_platforms, "bluesky", "posting")

    poster = get_bluesky_poster()
    if not getattr(poster, "enabled", False):
        msg = "Skipped: direct Bluesky credentials are missing or login failed."
        log("BLUESKY", msg)
        if progress_cb:
            progress_cb(done_offset + 1, total_platforms, "bluesky", "skipped")
        return {
            "bluesky": {
                "status": "skipped",
                "platform": "bluesky",
                "error": msg,
                "error_message": msg,
            }
        }

    reserve = reserve_publish_attempt(
        guard_media_path,
        {"bluesky": {"caption": content}},
        "bluesky",
        note="Direct Bluesky publish reserved",
    )
    if reserve.get("blocked"):
        msg = (
            f"Skipped duplicate publish attempt: previous {reserve.get('status')} "
            f"at {reserve.get('timestamp')}"
        )
        log("BLUESKY", msg)
        if progress_cb:
            progress_cb(done_offset + 1, total_platforms, "bluesky", "skipped")
        return {
            "bluesky": {
                "status": "skipped",
                "platform": "bluesky",
                "error": msg,
                "error_message": msg,
            }
        }

    try:
        response = poster.post(
            content,
            image_paths=image_paths,
            image_alt="Flyer image",
            video_path=video_path,
        )
        post_id = (
            getattr(response, "uri", None) or getattr(response, "cid", None) or "posted"
        )
        log("BLUESKY", f"Direct post successful: {post_id}")
        if progress_cb:
            progress_cb(done_offset + 1, total_platforms, "bluesky", "ok")
        return {
            "bluesky": {
                "status": "ok",
                "platform": "bluesky",
                "post_id": str(post_id),
            }
        }
    except Exception as exc:
        log("BLUESKY", f"Direct post failed: {exc}")
        if progress_cb:
            progress_cb(done_offset + 1, total_platforms, "bluesky", "error")
        return {
            "bluesky": {
                "status": "error",
                "platform": "bluesky",
                "error": str(exc),
                "error_message": str(exc),
            }
        }


def _is_twitter_retryable_result(result):
    """Return True for transient X/Twitter media upload failures worth retrying."""
    if not isinstance(result, dict):
        return False
    if str(result.get("platform", "")).strip().lower() != "twitter":
        return False

    status = str(result.get("status", "")).strip().lower()
    error_text = str(
        result.get("error")
        or result.get("error_message")
        or ""
    ).strip().lower()

    transient_markers = (
        "service unavailable",
        '"status":503',
        "status 503",
        "chunked upload append",
        "media upload failed",
        "temporarily unavailable",
        "upstream connect error",
    )
    return status in {"error", "pending"} and any(
        marker in error_text for marker in transient_markers
    )


def _publish_direct_youtube_accounts(
    video_path,
    captions,
    selected_platforms,
    publish_now=True,
    progress_cb=None,
    total_platforms=1,
    done_offset=0,
):
    results = {}
    youtube_targets = get_selected_youtube_targets(selected_platforms)
    if not youtube_targets:
        return results

    youtube_data = (captions or {}).get("youtube", {})
    youtube_title = ""
    youtube_description = ""
    if isinstance(youtube_data, dict):
        youtube_title = youtube_data.get("title", "")
        youtube_description = youtube_data.get("caption", "")
    elif isinstance(youtube_data, str):
        youtube_description = youtube_data

    if not youtube_description:
        youtube_description = "Published via AutoDubber"

    # YouTube accounts run in parallel — each has its own OAuth context and
    # API quota bucket, so there's no contention. Historically they ran
    # serially, costing ~3m 25s × N accounts. With two channels this turns
    # ~6m 48s of wall time into ~3m 25s.
    def _publish_one(idx, alias):
        reserve = reserve_publish_attempt(
            video_path,
            captions,
            alias,
            note="Direct YouTube publish reserved",
        )
        if reserve.get("blocked"):
            msg = (
                f"Skipped duplicate publish attempt: previous {reserve.get('status')} "
                f"at {reserve.get('timestamp')}"
            )
            if progress_cb:
                progress_cb(done_offset + idx, total_platforms, alias, "skipped")
            return alias, {
                "status": "skipped",
                "platform": alias,
                "error": msg,
                "error_message": msg,
            }
        if progress_cb:
            progress_cb(done_offset + idx - 1, total_platforms, alias, "posting")
        result = publish_direct_youtube(
            alias=alias,
            video_path=video_path,
            title=youtube_title,
            description=youtube_description,
            publish_now=publish_now,
        )
        if progress_cb:
            status = str(result.get("status", "")).lower()
            if status in {"ok", "published", "success"}:
                progress_cb(done_offset + idx, total_platforms, alias, "ok")
            else:
                progress_cb(done_offset + idx, total_platforms, alias, "error")
        return alias, result

    from concurrent.futures import ThreadPoolExecutor, as_completed

    with ThreadPoolExecutor(
        max_workers=max(1, len(youtube_targets)),
        thread_name_prefix="yt-upload",
    ) as executor:
        futures = [
            executor.submit(_publish_one, idx, alias)
            for idx, alias in enumerate(youtube_targets, start=1)
        ]
        for future in as_completed(futures):
            try:
                alias, result = future.result()
                results[alias] = result
            except Exception as e:
                log("PUBLISH", f"  ❌ YouTube parallel upload failed: {e}")

    return results


def _publish_single_platform(
    api_key,
    platform_entry,
    media_items,
    platform_specific_contents,
    default_content,
    publish_now,
    scheduled_for,
):
    platform_name = platform_entry["platform"]
    single_content = platform_specific_contents.get(platform_name) or default_content

    # Threads/Meta video can exceed 120s server-side; short timeouts cause retries → duplicate-content errors.
    slow_zernio_platforms = {"bluesky", "threads"}
    client = Zernio(
        api_key=api_key,
        timeout=420.0 if str(platform_name).lower() in slow_zernio_platforms else 120.0,
    )

    log("PUBLISH", f"🚀 Starting SDK call for {platform_name}...")
    log("PUBLISH", f"  📱 Platform: {platform_name}")
    log("PUBLISH", f"  🎬 Media Items: {len(media_items) if media_items else 0} items")
    log("PUBLISH", f"  ⏰ Publish now: {publish_now}")
    log("PUBLISH", f"  📞 Calling client.posts.create()...")

    create_kwargs = {
        "content": single_content,
        "platforms": [platform_entry],
        "publish_now": publish_now,
    }
    if media_items:
        create_kwargs["media_items"] = media_items

    post_result = client.posts.create(**create_kwargs)
    log("PUBLISH", f"  ✅ SDK call successful for {platform_name}: {type(post_result)}")

    if scheduled_for and hasattr(post_result, "post"):
        log("PUBLISH", f"⚠️ Scheduling not fully implemented - using immediate publish")

    return post_result


def _run_single_platform_publish(
    api_key,
    platform_entry,
    media_items,
    platform_specific_contents,
    default_content,
    publish_now,
    scheduled_for,
    results,
    processed_count,
    total_platforms,
    progress_cb=None,
):
    """Publish a single platform and normalize the result using existing handlers."""
    platform_name = platform_entry["platform"]
    platform_key = str(platform_name).strip().lower()

    try:
        attempts = (
            TWITTER_RETRY_ATTEMPTS if platform_key == "twitter" else 1
        )
        for attempt in range(1, attempts + 1):
            post_result = _publish_single_platform(
                api_key,
                platform_entry,
                media_items,
                platform_specific_contents,
                default_content,
                publish_now,
                scheduled_for,
            )
            parsed = _extract_publish_results(
                post_result,
                [platform_name],
                progress_cb=progress_cb,
                done=processed_count,
                total=total_platforms,
            )

            retryable = _is_twitter_retryable_result(parsed.get(platform_name))
            if not retryable or attempt >= attempts:
                results.update(parsed)
                break

            wait_seconds = TWITTER_RETRY_BACKOFF_SECONDS[min(
                attempt - 1, len(TWITTER_RETRY_BACKOFF_SECONDS) - 1
            )]
            err_text = parsed.get(platform_name, {}).get("error_message") or "retryable Twitter publish failure"
            log(
                "PUBLISH",
                f"  ⚠️ twitter transient failure on attempt {attempt}/{attempts}: {err_text}",
            )
            log(
                "PUBLISH",
                f"  🔁 Retrying twitter publish in {wait_seconds}s...",
            )
            if progress_cb:
                progress_cb(processed_count, total_platforms, platform_name, "posting")
            time.sleep(wait_seconds)
    except ZernioAuthenticationError as exc:
        log("PUBLISH", f"  ❌ Authentication failed: Invalid API key - {exc}")
        raise ZernioAuthenticationError(
            "Invalid Zernio API key. Please check your API key in the settings."
        )
    except ZernioRateLimitError as exc:
        log("PUBLISH", f"  ❌ Rate limit exceeded: {exc}")
        raise ZernioRateLimitError(
            "Rate limit exceeded. Please wait before trying again."
        )
    except ZernioTimeoutError as exc:
        reason = (
            "Publish status unconfirmed: request timed out while the platform may still be processing. "
            "Verify dashboard before retrying."
        )
        log("PUBLISH", f"  ⚠️ Timeout for {platform_name}: {exc}")
        results.update(
            _make_unconfirmed_results(
                [platform_name],
                reason,
                progress_cb=progress_cb,
                done=processed_count,
                total=total_platforms,
            )
        )
    except ZernioConnectionError as exc:
        reason = (
            "Publish status unconfirmed: connection dropped after submit may have reached the server. "
            "Verify dashboard before retrying."
        )
        log("PUBLISH", f"  ⚠️ Connection error for {platform_name}: {exc}")
        results.update(
            _make_unconfirmed_results(
                [platform_name],
                reason,
                progress_cb=progress_cb,
                done=processed_count,
                total=total_platforms,
            )
        )
    except ZernioAPIError as exc:
        log("PUBLISH", f"  ❌ API error for {platform_name}: {exc}")
        if progress_cb:
            progress_cb(processed_count + 1, total_platforms, platform_name, "error")
        results[platform_name] = {
            "status": "error",
            "platform": platform_name,
            "error": f"Zernio API error: {exc}",
            "error_message": f"Zernio API error: {exc}",
        }
    except Exception as exc:
        if _is_unconfirmed_publish_error(exc):
            reason = (
                "Publish status unconfirmed: SDK connection closed after submit. "
                "Verify dashboard before retrying."
            )
            log(
                "PUBLISH", f"  ⚠️ Unconfirmed publish outcome for {platform_name}: {exc}"
            )
            results.update(
                _make_unconfirmed_results(
                    [platform_name],
                    reason,
                    progress_cb=progress_cb,
                    done=processed_count,
                    total=total_platforms,
                )
            )
        else:
            log("PUBLISH", f"  ❌ Unexpected SDK error for {platform_name}: {exc}")
            if progress_cb:
                progress_cb(
                    processed_count + 1, total_platforms, platform_name, "error"
                )
            results[platform_name] = {
                "status": "error",
                "platform": platform_name,
                "error": str(exc),
                "error_message": str(exc),
            }


def _extract_publish_results(
    post_result, requested_platforms, progress_cb=None, done=0, total=None
):
    """Normalize SDK response into the app's publish result format."""
    total = total or len(requested_platforms)
    try:
        log("PUBLISH", f"🔍 Starting response parsing...")
        log("PUBLISH", f"  📊 Response type: {type(post_result)}")
        log("PUBLISH", f"  📄 Response content: {str(post_result)[:200]}...")

        published_platforms = []
        parent_post_id = None

        if hasattr(post_result, "post"):
            log("PUBLISH", f"  🔗 Found post object")
            post_obj = post_result.post
            parent_post_id = getattr(post_obj, "id", None) or getattr(
                post_obj, "_id", None
            )
            if hasattr(post_obj, "platforms"):
                published_platforms = post_obj.platforms
                log(
                    "PUBLISH",
                    f"  📊 Got platforms from post.platforms: {len(published_platforms)}",
                )
                log("PUBLISH", f"  📋 Platform objects: {published_platforms}")
            elif hasattr(post_obj, "targets"):
                published_platforms = post_obj.targets
                log(
                    "PUBLISH",
                    f"  📊 Got platforms from post.targets: {len(published_platforms)}",
                )
            elif hasattr(post_obj, "results"):
                published_platforms = post_obj.results
                log(
                    "PUBLISH",
                    f"  📊 Got platforms from post.results: {len(published_platforms)}",
                )
            else:
                log("PUBLISH", f"  ❌ No platforms attribute on post object")
                log(
                    "PUBLISH",
                    f"  🔍 Post object attributes: {[attr for attr in dir(post_obj) if not attr.startswith('_')]}",
                )
        elif isinstance(post_result, dict):
            log("PUBLISH", f"  📦 Response is dict")
            post = post_result.get("post", {})
            parent_post_id = (
                post.get("id")
                or post.get("_id")
                or post_result.get("id")
                or post_result.get("_id")
            )
            published_platforms = (
                post.get("platforms", [])
                or post.get("targets", [])
                or post.get("results", [])
                or post_result.get("platforms", [])
                or post_result.get("targets", [])
                or post_result.get("results", [])
            )
            log("PUBLISH", f"  📊 Got platforms from dict: {len(published_platforms)}")
            log("PUBLISH", f"  📋 Dict keys: {list(post_result.keys())}")
        elif hasattr(post_result, "platforms"):
            published_platforms = getattr(post_result, "platforms")
            parent_post_id = getattr(post_result, "id", None) or getattr(
                post_result, "_id", None
            )
            log(
                "PUBLISH",
                f"  📊 Got platforms from response.platforms: {len(published_platforms)}",
            )
        elif hasattr(post_result, "targets"):
            published_platforms = getattr(post_result, "targets")
            parent_post_id = getattr(post_result, "id", None) or getattr(
                post_result, "_id", None
            )
            log(
                "PUBLISH",
                f"  📊 Got platforms from response.targets: {len(published_platforms)}",
            )
        else:
            log("PUBLISH", f"  ❌ Unknown response format: {type(post_result)}")
            log(
                "PUBLISH",
                f"  🔍 Available attributes: {[attr for attr in dir(post_result) if not attr.startswith('_')]}",
            )

        log("PUBLISH", f"  📊 Platforms in response: {len(published_platforms)}")

    except Exception as e:
        log("PUBLISH", f"  ❌ Error parsing response: {e}")
        import traceback

        traceback.print_exc()
        published_platforms = []
        parent_post_id = None

    results = {}
    for i, platform_info in enumerate(published_platforms):
        try:
            if hasattr(platform_info, "platform"):
                platform_name = platform_info.platform
                post_id = getattr(platform_info, "platformPostId", "unknown")
                status = getattr(platform_info, "status", "unknown")
                error_message = getattr(platform_info, "errorMessage", None)
            elif isinstance(platform_info, dict):
                platform_name = platform_info.get("platform", "unknown")
                post_id = platform_info.get(
                    "platformPostId",
                    platform_info.get("id", platform_info.get("_id", "unknown")),
                )
                status = platform_info.get("status", "unknown")
                error_message = platform_info.get("errorMessage") or platform_info.get(
                    "error"
                )
            else:
                platform_name = "unknown"
                post_id = "unknown"
                status = "error"
                error_message = "Unknown platform response format"

            status_l = str(status).lower()
            platform_l = str(platform_name).lower()
            error_text_l = str(error_message or "").lower()
            timeout_like = status_l in {"timeout", "timed_out", "timed-out"} or (
                "timeout" in error_text_l
            )
            duplicate_like = (
                "duplicate content" in error_text_l
                or "already published" in error_text_l
                or "being published" in error_text_l
            )
            # Meta's API (Instagram, Facebook, Threads) and Bluesky all
            # return "duplicate content" responses in cases where the post
            # actually went through but the ack timed out server-side, or
            # where a retry races an earlier successful attempt. Treating
            # these as likely_live (rather than hard-fail) prompts the user
            # to verify the feed before retrying instead of republishing
            # and creating a real duplicate.
            duplicate_live_like = (
                platform_l in {"bluesky", "threads", "instagram", "facebook"}
                and duplicate_like
            )
            bluesky_unconfirmed = platform_l == "bluesky" and timeout_like

            if progress_cb:
                log("PUBLISH", f"  📱 Updating progress: {platform_name} -> {status}")
                if status_l == "published":
                    progress_cb(min(done + i + 1, total), total, platform_name, "ok")
                elif duplicate_live_like:
                    progress_cb(
                        min(done + i + 1, total), total, platform_name, "likely_live"
                    )
                elif bluesky_unconfirmed:
                    progress_cb(
                        min(done + i + 1, total), total, platform_name, "unconfirmed"
                    )
                elif status_l == "error" or status_l == "failed":
                    progress_cb(min(done + i + 1, total), total, platform_name, "error")
                else:
                    progress_cb(
                        min(done + i + 1, total), total, platform_name, "posting"
                    )

            hard_fail = status_l in {"error", "failed", "fail", "rejected"}
            success = (not hard_fail) and (
                status_l
                in {"published", "ok", "success", "submitted", "queued", "processing"}
                or (post_id and post_id != "unknown")
            )
            if duplicate_live_like:
                success = False
            elif bluesky_unconfirmed:
                success = False

            results[platform_name] = {
                "status": (
                    "likely_live"
                    if duplicate_live_like
                    else (
                        "unconfirmed"
                        if bluesky_unconfirmed
                        else ("ok" if success else "error")
                    )
                ),
                "post_id": post_id,
                "platform": platform_name,
            }
            if duplicate_live_like:
                results[platform_name]["error"] = (
                    f"{platform_name.title()} reported duplicate content, which usually means the post is already live or still settling."
                )
                results[platform_name]["error_message"] = results[platform_name][
                    "error"
                ]
            elif bluesky_unconfirmed:
                if duplicate_like:
                    results[platform_name]["error"] = (
                        "Bluesky reported duplicate content. The post may already be live or still settling. "
                        "Verify dashboard/profile before retrying."
                    )
                else:
                    results[platform_name]["error"] = (
                        "Bluesky is taking longer than usual; status unconfirmed. "
                        "Verify dashboard before retrying."
                    )
                results[platform_name]["error_message"] = results[platform_name][
                    "error"
                ]
            elif not success:
                results[platform_name]["error"] = (
                    error_message or f"Publish failed with status={status}"
                )
                results[platform_name]["error_message"] = (
                    error_message or f"Publish failed with status={status}"
                )

            if duplicate_live_like:
                log(
                    "PUBLISH",
                    f"  ✅ {platform_name}: likely already live (duplicate response)",
                )
            elif success:
                log("PUBLISH", f"  ✅ {platform_name}: ok (ID: {post_id})")
            elif bluesky_unconfirmed:
                log("PUBLISH", f"  ⚠️ {platform_name}: unconfirmed (slow processing)")
            else:
                log(
                    "PUBLISH",
                    f"  ❌ {platform_name}: {results[platform_name]['error']}",
                )

        except Exception as e:
            log("PUBLISH", f"  ❌ Error processing platform {platform_info}: {e}")

    if not results and requested_platforms:
        log(
            "PUBLISH",
            "⚠️ No per-platform statuses returned; marking selected platforms as unconfirmed",
        )
        fallback_post_id = parent_post_id or "submitted"
        for idx, platform in enumerate(requested_platforms, start=1):
            if progress_cb:
                progress_cb(min(done + idx, total), total, platform, "unconfirmed")
            results[platform] = {
                "status": "unconfirmed",
                "post_id": fallback_post_id,
                "platform": platform,
                "error": (
                    "Publish status unconfirmed: per-platform status missing from API response. "
                    "Verify on dashboard before retrying."
                ),
                "error_message": (
                    "Publish status unconfirmed: per-platform status missing from API response. "
                    "Verify on dashboard before retrying."
                ),
            }

    return results


def upload_large_file(client, file_path):
    """Upload large file using direct REST API presigned URL flow (20-50MB support)"""

    # Check file size
    file_size = os.path.getsize(file_path)
    log(
        "PUBLISH",
        f"  📏 File size: {file_size:,} bytes ({file_size / 1024 / 1024:.1f} MB)",
    )

    try:
        # Step 1: Call REST API directly to get presigned URL
        log(
            "PUBLISH",
            f"  🔄 Getting presigned URL for {os.path.basename(file_path)}...",
        )
        import requests
        import json

        guessed_content_type = (
            mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        )
        presign_response = requests.post(
            "https://zernio.com/api/v1/media/presign",
            headers={
                "Authorization": f"Bearer {client.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "filename": os.path.basename(file_path),
                "contentType": guessed_content_type,
            },
            timeout=120,
        )
        presign_response.raise_for_status()

        presign_data = presign_response.json() or {}
        upload_url = str(presign_data.get("uploadUrl") or "").strip()
        public_url = str(presign_data.get("publicUrl") or "").strip()

        if not upload_url or not public_url:
            raise ValueError(
                f"Presign response missing uploadUrl/publicUrl "
                f"(uploadUrl={'set' if upload_url else 'EMPTY'}, "
                f"publicUrl={'set' if public_url else 'EMPTY'}): {presign_data}"
            )
        if not (public_url.startswith("http://") or public_url.startswith("https://")):
            raise ValueError(f"Presign publicUrl is not a valid http(s) URL: {public_url!r}")

        log("PUBLISH", f"  ✅ Presigned URL received: {upload_url[:50]}...")
        log("PUBLISH", f"  📍 Public URL will be: {public_url[:50]}...")

        # Step 2: Upload file bytes directly to object storage
        log("PUBLISH", f"  📤 Uploading to direct storage URL...")
        with open(file_path, "rb") as f:
            upload_response = requests.put(
                upload_url,
                data=f,
                headers={"Content-Type": guessed_content_type},
                timeout=600,  # 10 minute timeout for large uploads
            )
            upload_response.raise_for_status()

        log("PUBLISH", f"  ✅ File uploaded successfully to direct storage")
        log("PUBLISH", f"  🔗 Public URL: {public_url[:50]}...")

        # Step 3: Return the public URL for media_urls=[public_url]
        return public_url

    except Exception as e:
        log("PUBLISH", f"  ❌ Presigned upload failed: {e}")
        import traceback

        traceback.print_exc()

        # Fallback error message with external hosting option
        error_msg = f"""Direct storage upload failed ({file_size / 1024 / 1024:.1f} MB).

🚨 TECHNICAL ISSUE: {str(e)}

✅ ALTERNATIVE SOLUTIONS:

1. 🌐 EXTERNAL HOSTING (Immediate workaround):
   • Upload to: YouTube, Vimeo, S3, R2, or another public CDN/storage provider
   • Get public URL
   • Use: media_urls=[https://your-cdn.com/video.mp4]

2. 📏 COMPRESS VIDEO:
   • Reduce to under 8MB for regular upload
   • Lower resolution/bitrate

3. 📞 CONTACT ZERNIO SUPPORT:
   • Reference: /api/v1/media/presign endpoint error
   • File size: {file_size / 1024 / 1024:.1f} MB
   • Error: {str(e)}

📝 TEMPORARY: Host externally and use the public URL."""

        raise Exception(error_msg)


def publish_with_sdk(
    api_key,
    captions,
    platforms,
    upload_results=None,
    scheduled_for=None,
    publish_now=True,
    teaser_captions=None,
    output_dir="workspace",
    progress_cb=None,
    fallback_files=None,
    image_paths=None,
):
    """
    Publish to all platforms using official Zernio SDK
    """
    log("PUBLISH", f"🎯 STARTING publish_with_sdk")
    log("PUBLISH", f"  🔑 API Key: {api_key[:10]}..." if api_key else "❌ No API key")
    log("PUBLISH", f"  📱 Platforms: {platforms}")
    log(
        "PUBLISH",
        f"  📄 Upload results: {list(upload_results.keys()) if upload_results else None}",
    )
    log(
        "PUBLISH",
        f"  📄 Fallback files: {list(fallback_files.keys()) if fallback_files else None}",
    )

    try:
        selected_platforms = _dedupe_platform_names(platforms or [])
        youtube_targets = get_selected_youtube_targets(selected_platforms)
        expanded_targets = []
        for platform in selected_platforms:
            if str(platform).lower() == "youtube":
                expanded_targets.extend(youtube_targets)
            else:
                expanded_targets.append(platform)
        total_publish_targets = len(expanded_targets) or len(selected_platforms) or 1

        zernio_platforms = [
            p
            for p in selected_platforms
            if str(p).lower() not in {"bluesky", "youtube"}
        ]

        direct_default_content = ""
        direct_platform_contents = {}
        for platform, platform_data in (captions or {}).items():
            pk = str(platform or "").strip().lower()
            if not pk:
                continue
            if isinstance(platform_data, dict) and platform_data.get("caption"):
                text = _fit_platform_content(pk, platform_data["caption"])
                if not direct_default_content:
                    direct_default_content = text
                direct_platform_contents[pk] = text
            elif isinstance(platform_data, str):
                text = _fit_platform_content(pk, platform_data)
                if not direct_default_content:
                    direct_default_content = text
                direct_platform_contents[pk] = text
        if not direct_default_content:
            direct_default_content = "Published via AutoDubber"

        direct_bluesky_results = {}
        bluesky_count = 0
        if any(str(p).lower() == "bluesky" for p in selected_platforms):
            bluesky_content = (
                direct_platform_contents.get("bluesky") or direct_default_content
            )
            bluesky_video = None
            if fallback_files:
                bluesky_video = fallback_files.get("main_video")
                if bluesky_video and not os.path.exists(bluesky_video):
                    bluesky_video = None
            direct_bluesky_results = _publish_direct_bluesky(
                bluesky_content,
                bluesky_video or ((image_paths or [None])[0]),
                progress_cb=progress_cb,
                total_platforms=total_publish_targets,
                done_offset=0,
                image_paths=image_paths,
                video_path=bluesky_video,
            )
            bluesky_count = len(direct_bluesky_results)

        # Initialize Zernio client up front (before YouTube) so its media
        # upload can run in parallel with YouTube account uploads. Saves
        # ~30-60s of wall time on runs that hit both paths; the client init
        # itself is just a tiny HTTP session with no network traffic.
        client = None
        if zernio_platforms:
            # Threads (Zernio) and any in-SDK Bluesky need long HTTP timeouts for video.
            slow = {"bluesky", "threads"}
            sdk_timeout = (
                420.0
                if any(str(p).lower() in slow for p in (zernio_platforms or []))
                else 120.0
            )
            log(
                "PUBLISH",
                f"  🔧 Initializing Zernio client with timeout={sdk_timeout}s...",
            )
            client = Zernio(api_key=api_key, timeout=sdk_timeout)
            log("PUBLISH", "✅ Zernio SDK initialized")

        def _prepare_media_items():
            """Build the Zernio ``media_items`` list.

            Returns ``(media_items, error_str_or_None)``. Runs in a worker
            thread alongside YouTube uploads when both paths are active.
            Uses the pre-initialized ``client`` captured from the enclosing
            scope.
            """
            media_items_local = []
            if upload_results:
                main_video_url = upload_results.get("main_video")
                if main_video_url:
                    media_items_local.append({"type": "video", "url": main_video_url})
                    log("PUBLISH", f"  ✅ Main video: {main_video_url[:50]}...")
                for platform, teaser_url in upload_results.items():
                    if platform.startswith("teaser_") and teaser_url:
                        media_items_local.append({"type": "video", "url": teaser_url})
                        log("PUBLISH", f"  ✅ Teaser {platform}: {teaser_url[:50]}...")

            if media_items_local or not fallback_files or client is None:
                return media_items_local, None

            log("PUBLISH", "🔄 No media URLs found, need to upload files...")
            log(
                "PUBLISH",
                f"  📄 Fallback files available: {list(fallback_files.keys())}",
            )
            for key, path in fallback_files.items():
                exists = os.path.exists(path) if path else False
                size = os.path.getsize(path) if exists and path else 0
                log(
                    "PUBLISH",
                    f"  📁 {key}: {path} - {'✅' if exists else '❌'} ({size:,} bytes)",
                )

            log("PUBLISH", "🔄 Starting media file upload process...")

            main_video_path_local = fallback_files.get("main_video")
            if main_video_path_local and os.path.exists(main_video_path_local):
                try:
                    file_size = os.path.getsize(main_video_path_local)
                    log(
                        "PUBLISH",
                        f"  📏 Video file size: {file_size:,} bytes ({file_size / 1024 / 1024:.1f} MB)",
                    )
                    if file_size > 4 * 1024 * 1024:  # 4MB limit - use presigned upload
                        log(
                            "PUBLISH",
                            f"  📤 File too large for direct upload, using presigned URL...",
                        )
                        video_url = upload_large_file(client, main_video_path_local)
                    else:
                        result = client.media.upload(main_video_path_local)
                        video_url = _extract_public_url(result)
                        if not video_url:
                            raise ValueError(
                                f"Upload response missing public URL: {result}"
                            )
                    video_url = str(video_url or "").strip()
                    if not video_url or not (
                        video_url.startswith("http://") or video_url.startswith("https://")
                    ):
                        raise ValueError(
                            f"Video upload returned invalid URL: {video_url!r}"
                        )
                    media_items_local.append({"type": "video", "url": video_url})
                    log("PUBLISH", f"  ✅ Main video uploaded: {video_url[:50]}...")
                except Exception as e:
                    log("PUBLISH", f"  ❌ Upload failed: {e}")
                    return media_items_local, f"Media upload failed: {e}"
            elif not main_video_path_local:
                main_image_path = fallback_files.get("main_image")
                if main_image_path and os.path.exists(main_image_path):
                    try:
                        file_size = os.path.getsize(main_image_path)
                        log(
                            "PUBLISH", f"  📏 Main image file size: {file_size:,} bytes"
                        )
                        if file_size > 4 * 1024 * 1024:
                            log(
                                "PUBLISH",
                                f"  📤 Main image too large, using upload_large...",
                            )
                            img_url = upload_large_file(client, main_image_path)
                        else:
                            result = client.media.upload(main_image_path)
                            img_url = _extract_public_url(result)
                            if not img_url:
                                raise ValueError(
                                    f"Upload response missing public URL: {result}"
                                )
                        img_url = str(img_url or "").strip()
                        if not img_url or not (
                            img_url.startswith("http://") or img_url.startswith("https://")
                        ):
                            raise ValueError(
                                f"Main image upload returned invalid URL: {img_url!r}"
                            )
                        media_items_local.append({"type": "image", "url": img_url})
                        log("PUBLISH", f"  ✅ Main image uploaded: {img_url[:50]}...")
                    except Exception as e:
                        log("PUBLISH", f"  ❌ Upload failed: {e}")
                        return media_items_local, f"Media upload failed: {e}"

                additional_images = fallback_files.get("additional_images", [])
                for i, img_path in enumerate(additional_images):
                    if img_path and os.path.exists(img_path):
                        try:
                            file_size = os.path.getsize(img_path)
                            log(
                                "PUBLISH",
                                f"  📏 Image {i + 1} file size: {file_size:,} bytes",
                            )
                            if file_size > 4 * 1024 * 1024:
                                log(
                                    "PUBLISH",
                                    f"  📤 Image {i + 1} too large, using upload_large...",
                                )
                                img_url = upload_large_file(client, img_path)
                            else:
                                result = client.media.upload(img_path)
                                img_url = _extract_public_url(result)
                                if not img_url:
                                    raise ValueError(
                                        f"Upload response missing public URL: {result}"
                                    )
                            img_url = str(img_url or "").strip()
                            if not img_url or not (
                                img_url.startswith("http://") or img_url.startswith("https://")
                            ):
                                raise ValueError(
                                    f"Image {i + 1} upload returned invalid URL: {img_url!r}"
                                )
                            media_items_local.append({"type": "image", "url": img_url})
                            log(
                                "PUBLISH",
                                f"  ✅ Uploaded additional image {i + 1}: {img_url[:50]}...",
                            )
                        except Exception as e:
                            log(
                                "PUBLISH",
                                f"  ❌ Additional image {i + 1} upload failed: {e}",
                            )
                            # Continue with other images instead of failing completely

            return media_items_local, None

        # Run YouTube account uploads and Zernio media upload concurrently.
        # YouTube accounts each take ~3m 25s; Zernio media upload ~30-60s.
        # They share no data, so running both in parallel shaves the shorter
        # of the two off total wall time. Bluesky ran sequentially above —
        # it's only ~13s and we want its outcome in before the parallel phase
        # so its status shows promptly in the progress UI.
        direct_youtube_results = {}
        media_items = []
        media_upload_error = None

        def _run_youtube():
            if not youtube_targets:
                return {}
            yt_main_video = (
                fallback_files.get("main_video") if fallback_files else None
            )
            return _publish_direct_youtube_accounts(
                video_path=yt_main_video,
                captions=captions,
                selected_platforms=selected_platforms,
                publish_now=publish_now,
                progress_cb=progress_cb,
                total_platforms=total_publish_targets,
                done_offset=bluesky_count,
            )

        if youtube_targets and zernio_platforms:
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(
                max_workers=2, thread_name_prefix="publish-parallel"
            ) as executor:
                yt_future = executor.submit(_run_youtube)
                media_future = executor.submit(_prepare_media_items)
                try:
                    direct_youtube_results = yt_future.result() or {}
                except Exception as e:
                    log("PUBLISH", f"  ❌ YouTube parallel batch failed: {e}")
                    direct_youtube_results = {}
                try:
                    media_items, media_upload_error = media_future.result()
                except Exception as e:
                    log("PUBLISH", f"  ❌ Media upload thread crashed: {e}")
                    media_items, media_upload_error = (
                        [],
                        f"Media upload failed: {e}",
                    )
        elif youtube_targets:
            # No Zernio phase — just run YouTube. Media prep is unnecessary.
            direct_youtube_results = _run_youtube()
        elif zernio_platforms:
            # No YouTube — just prep media for the Zernio phase below.
            media_items, media_upload_error = _prepare_media_items()

        # Calculate offset for Zernio SDK phase
        sdk_offset = bluesky_count + len(direct_youtube_results)

        if not zernio_platforms:
            if progress_cb:
                progress_cb(sdk_offset, total_publish_targets, "sdk", "completed")
            direct_results = {}
            direct_results.update(direct_bluesky_results)
            direct_results.update(direct_youtube_results)
            return direct_results

        if progress_cb:
            progress_cb(sdk_offset, total_publish_targets, "sdk", "initializing")

        if media_upload_error:
            results = dict(direct_bluesky_results)
            results.update(direct_youtube_results)
            results["error"] = media_upload_error
            return results

        # Get default content (use first available caption as fallback)
        default_content = ""
        platform_specific_contents = {}

        for platform, platform_data in (captions or {}).items():
            pk = str(platform or "").strip().lower()
            if not pk:
                continue
            if isinstance(platform_data, dict) and platform_data.get("caption"):
                caption_text = _fit_platform_content(pk, platform_data["caption"])
                if not default_content:
                    default_content = caption_text  # First one becomes default
                platform_specific_contents[pk] = caption_text
            elif isinstance(platform_data, str):
                caption_text = _fit_platform_content(pk, platform_data)
                if not default_content:
                    default_content = caption_text  # First one becomes default
                platform_specific_contents[pk] = caption_text

        if not default_content:
            default_content = "Published via AutoDubber"

        # Choose a safe shared content baseline for strict platforms.
        strict_selected = [p for p in zernio_platforms if p in PLATFORM_LIMITS]
        if strict_selected:
            strictest = min(
                strict_selected, key=lambda p: PLATFORM_LIMITS.get(p, 10_000)
            )
            strict_caption = platform_specific_contents.get(strictest)
            if strict_caption:
                default_content = strict_caption
            else:
                default_content = _fit_platform_content(strictest, default_content)

        # Prepare platform list
        platform_accounts = get_platform_accounts()
        platform_list = []
        preflight_results = {}
        for platform in zernio_platforms:
            account_id = platform_accounts.get(platform)
            if account_id:
                platform_entry = {"platform": platform, "accountId": account_id}

                # Add platform-specific content if different from default
                platform_content = platform_specific_contents.get(platform, "")
                if platform_content and platform_content != default_content:
                    # Zernio / Late API: PlatformTarget.customContent (not platformSpecificContent).
                    platform_entry["customContent"] = platform_content

                # Add YouTube-specific fields
                if platform == "youtube":
                    yt_data = captions.get("youtube", {})
                    if isinstance(yt_data, dict) and yt_data.get("title"):
                        platform_entry["youtubeTitle"] = yt_data["title"]

                platform_list.append(platform_entry)
                log("PUBLISH", f"  ✅ {platform}: {account_id}")
            else:
                log("PUBLISH", f"  ❌ {platform}: No account ID configured")

        main_video_path = fallback_files.get("main_video") if fallback_files else None
        video_duration = _probe_video_duration_seconds(main_video_path)
        filtered_platforms = []
        for entry in platform_list:
            platform_name = str(entry.get("platform", "")).lower()
            if platform_name == "twitter" and video_duration and video_duration > 120:
                msg = "Skipped: X/Twitter free tier does not allow videos longer than 2 minutes."
                log("PUBLISH", f"  ⚠️ twitter: {msg}")
                preflight_results["twitter"] = {
                    "status": "skipped",
                    "platform": "twitter",
                    "error": msg,
                    "error_message": msg,
                }
                if progress_cb:
                    progress_cb(0, len(selected_platforms), "twitter", "skipped")
                continue
            filtered_platforms.append(entry)

        platform_list = _dedupe_platform_entries(filtered_platforms)

        # Bluesky is often the slowest to settle; start it first while staying sequential/controlled.
        platform_list.sort(
            key=lambda item: (
                0 if str(item.get("platform", "")).lower() == "bluesky" else 1
            )
        )

        if not platform_list:
            error_msg = "No valid platform accounts configured"
            log("PUBLISH", f"❌ {error_msg}")
            if direct_bluesky_results:
                direct_bluesky_results.update(preflight_results)
                if not preflight_results:
                    direct_bluesky_results["error"] = error_msg
                return direct_bluesky_results
            if preflight_results:
                return preflight_results
            return {"error": error_msg}

        if progress_cb:
            progress_cb(sdk_offset, total_publish_targets, "sdk", "uploading_media")

        if progress_cb:
            progress_cb(sdk_offset + 1, total_publish_targets, "sdk", "creating_post")

        log("PUBLISH", f"🚀 Creating post for {len(platform_list)} platforms...")
        log("PUBLISH", f"  Content: {default_content[:100]}...")
        log("PUBLISH", f"  Media: {len(media_items)} files")
        log("PUBLISH", f"  Platforms: {[p['platform'] for p in platform_list]}")
        log("PUBLISH", f"  Publish Now: {publish_now}")

        # Debug: Print the exact SDK call
        if media_items:
            media_items_count = len(media_items)
            log(
                "PUBLISH",
                f"  SDK Call: client.posts.create(media_items={media_items_count} items, content={len(default_content)} chars, platforms={len(platform_list)} platforms)",
            )
        else:
            log(
                "PUBLISH",
                f"  SDK Call: client.posts.create(content={len(default_content)} chars, platforms={len(platform_list)} platforms)",
            )

        if not media_items:
            video_required_platforms = ["youtube", "tiktok"]
            platforms_without_media = [
                p
                for p in platform_list
                if p["platform"] not in video_required_platforms
            ]
            skipped_video_required = [
                p
                for p in video_required_platforms
                if any(p2["platform"] == p for p2 in platform_list)
            ]
            if not platforms_without_media:
                error_msg = "No media uploaded but all selected platforms require video (youtube, tiktok)"
                log("PUBLISH", f"❌ {error_msg}")
                if direct_bluesky_results:
                    merged = dict(direct_bluesky_results)
                    merged.update(preflight_results)
                    merged["error"] = error_msg
                    return merged
                return {"error": error_msg}
            if skipped_video_required:
                log(
                    "PUBLISH",
                    f"⚠️ Skipped video-required platforms without media: {skipped_video_required}",
                )
            platform_list = platforms_without_media

        results = dict(direct_bluesky_results)
        results.update(direct_youtube_results)
        results.update(preflight_results)
        total_platforms = total_publish_targets
        processed_count = (
            len(direct_bluesky_results)
            + len(direct_youtube_results)
            + len(preflight_results)
        )

        attempted_platforms = set()
        for platform_entry in platform_list:
            platform_name = platform_entry["platform"]
            platform_key = str(platform_name).strip().lower()
            if platform_key in attempted_platforms:
                log(
                    "PUBLISH",
                    f"  ⚠️ Skipping duplicate platform entry in run: {platform_name}",
                )
                continue
            attempted_platforms.add(platform_key)

            reserve = reserve_publish_attempt(
                main_video_path
                or (fallback_files.get("main_image") if fallback_files else None),
                captions,
                platform_name,
                note="Zernio platform publish reserved",
            )
            if reserve.get("blocked"):
                msg = (
                    f"Skipped duplicate publish attempt: previous {reserve.get('status')} "
                    f"at {reserve.get('timestamp')}"
                )
                log("PUBLISH", f"  ⚠️ {platform_name}: {msg}")
                if progress_cb:
                    progress_cb(
                        processed_count + 1, total_platforms, platform_name, "skipped"
                    )
                results[platform_name] = {
                    "status": "skipped",
                    "platform": platform_name,
                    "error": msg,
                    "error_message": msg,
                }
                processed_count += 1
                continue

            if progress_cb:
                progress_cb(processed_count, total_platforms, platform_name, "posting")

            _run_single_platform_publish(
                api_key,
                platform_entry,
                media_items,
                platform_specific_contents,
                default_content,
                publish_now,
                scheduled_for,
                results,
                processed_count=processed_count,
                total_platforms=total_platforms,
                progress_cb=progress_cb,
            )
            processed_count += 1

        if progress_cb:
            progress_cb(
                total_publish_targets, total_publish_targets, "sdk", "completed"
            )

        log("PUBLISH", f"🎉 SDK publishing completed! {len(results)} platforms")
        return results
    except Exception as e:
        error_msg = f"SDK publishing failed: {str(e)}"
        log("PUBLISH", f"❌ {error_msg}")
        total = locals().get("total_publish_targets", 1)
        if progress_cb:
            progress_cb(total, total, "sdk", "error")
        if "direct_bluesky_results" in locals() and direct_bluesky_results:
            merged = dict(direct_bluesky_results)
            merged.update(locals().get("direct_youtube_results", {}))
            merged["error"] = error_msg
            return merged
        return {"error": error_msg}


# Simple wrapper function for app.py
def publish_to_platforms_sdk(
    api_key,
    video_path,
    captions,
    platforms,
    scheduled_for=None,
    publish_now=True,
    image_paths=None,
    output_dir="workspace",
    progress_cb=None,
    fallback_files=None,
):
    """
    Simplified publishing using Zernio SDK
    """
    log("PUBLISH", f"🚀 STARTING publish_to_platforms_sdk")
    log("PUBLISH", f"  📹 Video path: {video_path}")
    log("PUBLISH", f"  📱 Platforms: {platforms}")
    log(
        "PUBLISH",
        f"  📄 Fallback files: {list(fallback_files.keys()) if fallback_files else None}",
    )

    try:
        # For now, we'll use upload_results if available, otherwise fallback to direct upload
        result = publish_with_sdk(
            api_key=api_key,
            captions=captions,
            platforms=platforms,
            scheduled_for=scheduled_for,
            publish_now=publish_now,
            output_dir=output_dir,
            progress_cb=progress_cb,
            fallback_files=fallback_files,  # Pass through fallback files
            image_paths=image_paths,
        )
        if isinstance(result, dict) and "error" in result and len(result) == 1:
            log("PUBLISH", f"❌ publish_to_platforms_sdk FAILED: {result.get('error')}")
        else:
            has_unconfirmed = False
            if isinstance(result, dict):
                for v in result.values():
                    if isinstance(v, dict) and str(v.get("status", "")).lower() in {
                        "unconfirmed",
                        "submitted_unconfirmed",
                    }:
                        has_unconfirmed = True
                        break
            if has_unconfirmed:
                log(
                    "PUBLISH",
                    "⚠️ publish_to_platforms_sdk COMPLETED WITH UNCONFIRMED RESULTS",
                )
            else:
                log("PUBLISH", "✅ publish_to_platforms_sdk COMPLETED")
        return result
    except Exception as e:
        log("PUBLISH", f"❌ publish_to_platforms_sdk FAILED: {e}")
        import traceback

        traceback.print_exc()
        raise e
