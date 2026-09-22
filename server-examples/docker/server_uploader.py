#!/usr/bin/env python3
"""
FetchStream Universal Server-Side Stream Downloader & Cloud Uploader.
Handles:
1. M3U8/HLS stream downloading with On-The-Fly Sequential Piping (Hybrid Zero-Disk).
2. Universal cloud uploading via optimized Curl C-Engine and Boto3 Parallel Multipart.
"""

import sys
import os
import time
import json
import re
import argparse
import subprocess
import threading
import concurrent.futures
import tempfile
import shutil
import io
import urllib.parse
import hashlib
import hmac
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import mimetypes
import ssl
import requests
import requests.adapters

# ─── TLS 1.2 Adapter ────────────────────────────────────────────────────────
class TLS12Adapter(requests.adapters.HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        kwargs['ssl_context'] = ctx
        return super().init_poolmanager(*args, **kwargs)

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    HAS_CRYPTOGRAPHY = True
except ImportError:
    HAS_CRYPTOGRAPHY = False

try:
    import pyrogram.utils
    pyrogram.utils.MIN_CHANNEL_ID = -10099999999999
    pyrogram.utils.MAX_CHANNEL_ID = -1000000000000
except Exception:
    pass

# ─── Progress Callback Helper ───────────────────────────────────────────────

_global_callback_url = ""
_global_job_id = ""
_callback_session = None

def get_callback_session():
    global _callback_session
    if _callback_session is None:
        _callback_session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=10, pool_maxsize=10, max_retries=0)
        _callback_session.mount("http://", adapter)
        _callback_session.mount("https://", adapter)
    return _callback_session

class JobCancelledError(Exception):
    pass

def send_callback(callback_url, job_id, status, stage=None, progress=None, speed=None, url=None, links=None, service=None, file_name=None, file_size=None, error=None):
    if not callback_url: return
    payload = {
        "jobId": job_id, "status": status, "stage": stage or status,
        "progress": progress, "speed": speed, "url": url,
        "links": links or [], "service": service,
        "fileName": file_name, "fileSize": file_size, "error": error
    }
    
    max_retries = 3 if status in ("COMPLETED", "FAILED") else 1
    for attempt in range(max_retries):
        try:
            sess = get_callback_session()
            resp = sess.post(callback_url, json=payload, timeout=5)
            if resp.status_code == 200:
                try:
                    data = resp.json()
                    if data.get("status") == "CANCELLED":
                        print("[!] User cancelled job via UI. Aborting...", flush=True)
                        raise JobCancelledError("Cancelled by user")
                except ValueError: pass
            break
        except JobCancelledError: raise
        except Exception as e:
            if attempt == max_retries - 1 and status in ("COMPLETED", "FAILED"):
                print(f"[!] Warning: Failed to send terminal callback state '{status}': {e}", flush=True)
            elif status in ("COMPLETED", "FAILED"):
                time.sleep(2)
            else:
                pass

def urljoin_keep_query(base, url):
    resolved = urllib.parse.urljoin(base, url)
    base_parts = urllib.parse.urlparse(base)
    resolved_parts = urllib.parse.urlparse(resolved)
    if base_parts.query:
        from urllib.parse import parse_qsl, urlencode
        base_q = dict(parse_qsl(base_parts.query))
        res_q = dict(parse_qsl(resolved_parts.query))
        for k, v in base_q.items():
            if k not in res_q:
                res_q[k] = v
        resolved = resolved_parts._replace(query=urlencode(res_q)).geturl()
    return resolved

# ─── Local EdgeProxy Forwarding Proxy ──────────────────────────────────────

DISALLOWED_FORWARD_HEADERS = {
    "host", "connection", "content-length", "content-type", "range",
    "transfer-encoding", "accept-encoding", "access-control-request-method",
    "access-control-request-headers", "sec-fetch-mode", "sec-fetch-site",
    "sec-fetch-dest", "sec-fetch-user", "priority"
}

def sanitize_headers(headers_dict):
    clean = {}
    for k, v in (headers_dict or {}).items():
        lk = str(k).lower().strip()
        if not v or lk in DISALLOWED_FORWARD_HEADERS or lk.startswith("sec-ch-") or lk.startswith("access-control-"):
            continue
        if lk == "origin" and ("chrome-extension://" in str(v) or "pages.dev" in str(v)):
            continue
        clean[str(k).strip()] = str(v).strip().replace("\r", "").replace("\n", "")
    return clean

_proxy_session = None
def get_proxy_session():
    global _proxy_session
    if _proxy_session is None:
        _proxy_session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=25, pool_maxsize=25, max_retries=requests.adapters.Retry(total=2, backoff_factor=0.2))
        _proxy_session.mount("http://", adapter)
        _proxy_session.mount("https://", adapter)
    return _proxy_session

class EdgeProxyHlsProxyHandler(BaseHTTPRequestHandler):
    proxy_url = ""
    custom_headers = {}
    segment_counter = 0

    def log_message(self, format, *args): pass

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed_path.query)
        target_url = query.get("url", [""])[0]

        if not target_url:
            self.send_response(400)
            self.send_header("Connection", "close")
            self.end_headers()
            return

        try:
            req_headers = sanitize_headers(self.custom_headers)
            session = get_proxy_session()
            resp = session.post(self.proxy_url, json={"url": target_url, "headers": req_headers}, timeout=45)

            content_type = resp.headers.get("content-type", "").lower()
            is_m3u8 = ("mpegurl" in content_type or "m3u8" in target_url.lower() or parsed_path.path == "/m3u8")

            if resp.status_code == 200 and is_m3u8:
                playlist_text = resp.content.decode("utf-8", errors="replace")
                rewritten_lines = []
                port = self.server.server_address[1]
                effective_base_url = resp.headers.get("x-final-url") or resp.url or target_url

                for line in playlist_text.splitlines():
                    trimmed = line.strip()
                    if not trimmed:
                        rewritten_lines.append(line)
                        continue
                    if trimmed.startswith("#"):
                        if 'URI=' in trimmed:
                            def rewrite_uri(match):
                                orig = match.group(2)
                                resolved = urljoin_keep_query(effective_base_url, orig)
                                proxied = f"http://127.0.0.1:{port}/segment?url={urllib.parse.quote(resolved)}"
                                return f'URI="{proxied}"'
                            rewritten_lines.append(re.sub(r'URI=(["\']?)([^"\',\s>]+)\1', rewrite_uri, trimmed))
                        else:
                            rewritten_lines.append(line)
                    else:
                        resolved_seg = urljoin_keep_query(effective_base_url, trimmed)
                        rewritten_lines.append(f"http://127.0.0.1:{port}/segment?url={urllib.parse.quote(resolved_seg)}")

                body_bytes = "\n".join(rewritten_lines).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body_bytes)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body_bytes)
                self.close_connection = 1
                return

            EdgeProxyHlsProxyHandler.segment_counter += 1
            body_bytes = resp.content
            self.send_response(resp.status_code)
            self.send_header("Content-Type", resp.headers.get("content-type") or "video/MP2T")
            self.send_header("Content-Length", str(len(body_bytes)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body_bytes)
            self.close_connection = 1

        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as err:
            try:
                self.send_response(502)
                self.send_header("Connection", "close")
                self.end_headers()
            except Exception: pass

class SilentThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        exc_type, _, _ = sys.exc_info()
        if exc_type in (ConnectionResetError, BrokenPipeError): return
        super().handle_error(request, client_address)

def start_local_proxy_forwarder(proxy_url, custom_headers, port=8889):
    EdgeProxyHlsProxyHandler.proxy_url = proxy_url
    EdgeProxyHlsProxyHandler.custom_headers = custom_headers
    EdgeProxyHlsProxyHandler.segment_counter = 0
    server = SilentThreadingHTTPServer(("127.0.0.1", port), EdgeProxyHlsProxyHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server

# ─── M3U8 / HLS Stream Processing ──────────────────────────────────────────

def format_ffmpeg_headers(headers_dict):
    valid_lines = []
    clean_dict = sanitize_headers(headers_dict)
    has_ua = False
    for k, v in clean_dict.items():
        if k.lower() == "user-agent": has_ua = True
        valid_lines.append(f"{k}: {v}\r\n")
    if not has_ua:
        valid_lines.append("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36\r\n")
    return "".join(valid_lines)

def build_ffmpeg_cmd(input_url, headers_str, output_path):
    cmd = [
        "ffmpeg", "-y", "-reconnect", "1", "-reconnect_at_eof", "1",
        "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
        "-analyzeduration", "10M", "-probesize", "10M",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto,data"
    ]
    if headers_str:
        cmd.extend(["-headers", headers_str])
    
    is_mp3 = output_path.lower().endswith(".mp3")
    is_m4a = output_path.lower().endswith(".m4a")
    if is_mp3 or is_m4a:
        codec = "mp3" if is_mp3 else "aac"
        cmd.extend(["-i", input_url, "-vn", "-c:a", codec, "-b:a", "192k", "-movflags", "+faststart", "-fflags", "+genpts+discardcorrupt", output_path])
    else:
        cmd.extend(["-i", input_url, "-c", "copy", "-movflags", "+faststart", "-fflags", "+genpts+discardcorrupt", output_path])
    
    return cmd

def extract_ffmpeg_error(stderr_lines):
    meaningful = [l.strip() for l in stderr_lines if l.strip() and not any(l.strip().startswith(p) for p in (
        "ffmpeg version", "built with", "configuration:", "libavutil", "libavcodec", "libavformat", "libavdevice", "libavfilter", "libswscale", "libswresample", "libpostproc"
    ))]
    return " | ".join(meaningful[-6:]) if meaningful else "".join(stderr_lines[-3:]).strip()

def parse_hls_key_tag(tag_line, base_url):
    method_match = re.search(r'METHOD=([^,\s]+)', tag_line)
    if not method_match or method_match.group(1).upper() == "NONE": return None
    uri_match = re.search(r'URI=(["\']?)([^"\',\s>]+)\1', tag_line)
    iv_match = re.search(r'IV=(0x[0-9a-fA-F]+)', tag_line)
    return {
        "method": method_match.group(1).upper(),
        "uri": urljoin_keep_query(base_url, uri_match.group(2)) if uri_match else None,
        "iv": bytes.fromhex(iv_match.group(1)[2:].zfill(32)) if iv_match else None,
        "key_bytes": None
    }

def decrypt_hls_segment(data, key_bytes, iv_bytes):
    if not HAS_CRYPTOGRAPHY: raise RuntimeError("cryptography required for AES-128 HLS")
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv_bytes))
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(data) + decryptor.finalize()
    if len(decrypted) > 0:
        pad_len = decrypted[-1]
        if 1 <= pad_len <= 16 and decrypted[-pad_len:] == bytes([pad_len]) * pad_len:
            decrypted = decrypted[:-pad_len]
    return decrypted

def download_hls_parallel(media_url, headers_dict, output_path, callback_url, job_id, threads=8, proxy_url=None, target_service="", audio_only=False):
    threads = max(2, min(int(threads), 24))
    print(f"[*] Commencing Parallel HLS Downloader with {threads} concurrent threads...", flush=True)

    user_variant_url = None
    for k in list(headers_dict.keys()):
        if k.lower() == 'x-fs-variant-url':
            user_variant_url = headers_dict.pop(k)
            break

    clean_headers = sanitize_headers(headers_dict)
    session = requests.Session()
    session.mount("https://", TLS12Adapter(pool_connections=threads+5, pool_maxsize=threads+5, max_retries=requests.adapters.Retry(total=3, backoff_factor=0.3)))
    session.mount("http://", requests.adapters.HTTPAdapter(pool_connections=threads+5, pool_maxsize=threads+5, max_retries=requests.adapters.Retry(total=3, backoff_factor=0.3)))
    session.headers.update(clean_headers)
    if not any(k.lower() == "user-agent" for k in clean_headers):
        session.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    resp = None
    for attempt in range(3):
        try:
            resp = session.get(media_url, timeout=25)
            if resp.status_code == 200: break
            time.sleep(0.5 * (attempt + 1))
        except Exception:
            time.sleep(0.5 * (attempt + 1))

    if (resp is None or resp.status_code != 200) and proxy_url:
        try: resp = session.post(proxy_url, json={"url": media_url, "headers": clean_headers}, timeout=45)
        except Exception: pass

    if resp is None or resp.status_code != 200:
        raise RuntimeError(f"Failed to fetch M3U8 playlist")

    effective_url = resp.url or media_url
    playlist_text = resp.text
    audio_playlist_text, audio_effective_url = None, None

    if "#EXT-X-STREAM-INF:" in playlist_text:
        lines = playlist_text.splitlines()
        best_bw, variant_url, audio_group_id = -1, None, None
        for i, line in enumerate(lines):
            line_str = line.strip()
            if line_str.startswith("#EXT-X-STREAM-INF:"):
                bw_match = re.search(r'BANDWIDTH=(\d+)', line_str)
                audio_match = re.search(r'AUDIO="([^"]+)"', line_str)
                bw = int(bw_match.group(1)) if bw_match else 0
                for next_line in lines[i+1:]:
                    nxt = next_line.strip()
                    if nxt and not nxt.startswith("#"):
                        v_u = urljoin_keep_query(effective_url, nxt)
                        is_match = False
                        if user_variant_url:
                            u_str = user_variant_url.split('?')[0]
                            v_str = v_u.split('?')[0]
                            if v_str == u_str or u_str.endswith(nxt.split('?')[0]) or v_str.endswith(u_str.split('/')[-1]):
                                is_match = True
                        
                        if is_match:
                            variant_url = v_u
                            audio_group_id = audio_match.group(1) if audio_match else None
                            best_bw = float('inf')
                        elif best_bw != float('inf') and bw >= best_bw:
                            best_bw = bw
                            variant_url = v_u
                            audio_group_id = audio_match.group(1) if audio_match else None
                        break
                        
        audio_url = None
        if audio_only:
            for line in lines:
                line_str = line.strip()
                if line_str.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line_str:
                    uri_match = re.search(r'URI=["\']?([^"\']+)["\']?', line_str)
                    if uri_match:
                        audio_url = urljoin_keep_query(effective_url, uri_match.group(1))
                        break
        elif audio_group_id:
            for line in lines:
                line_str = line.strip()
                if line_str.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line_str:
                    grp_match = re.search(r'GROUP-ID="([^"]+)"', line_str)
                    if grp_match and grp_match.group(1) == audio_group_id:
                        uri_match = re.search(r'URI="([^"]+)"', line_str)
                        if uri_match:
                            audio_url = urljoin_keep_query(effective_url, uri_match.group(1))
                            break

        if variant_url and not audio_only:
            v_resp = None
            for v_attempt in range(3):
                try:
                    v_resp = session.get(variant_url, timeout=25)
                    if v_resp.status_code == 200: break
                except Exception: time.sleep(0.5)
            if (v_resp is None or v_resp.status_code != 200) and proxy_url:
                try: v_resp = session.post(proxy_url, json={"url": variant_url, "headers": clean_headers}, timeout=45)
                except Exception: pass
            if v_resp and v_resp.status_code == 200:
                effective_url = v_resp.url or variant_url
                playlist_text = v_resp.text
                
        audio_playlist_text, audio_effective_url = None, None
        if audio_url:
            a_resp = None
            for a_attempt in range(3):
                try:
                    a_resp = session.get(audio_url, timeout=25)
                    if a_resp.status_code == 200: break
                except Exception: time.sleep(0.5)
            if (a_resp is None or a_resp.status_code != 200) and proxy_url:
                try: a_resp = session.post(proxy_url, json={"url": audio_url, "headers": clean_headers}, timeout=45)
                except Exception: pass
            if a_resp and a_resp.status_code == 200:
                audio_playlist_text = a_resp.text
                audio_effective_url = a_resp.url or audio_url

        if audio_only and audio_playlist_text:
            playlist_text = audio_playlist_text
            effective_url = audio_effective_url
            audio_playlist_text, audio_effective_url = None, None
    if "#EXT-X-STREAM-INF:" in playlist_text:
        raise ValueError("Failed to resolve a media playlist; stuck with master playlist. This usually happens if the requested audio/video track could not be found.")

    def parse_playlist(p_text, p_url, is_aud):
        segs, cur_key, cur_init, cur_init_range, kc = [], None, None, None, {}
        cur_offset = 0
        cur_range = None
        for line in p_text.splitlines():
            trimmed = line.strip()
            if not trimmed: continue
            if trimmed.startswith("#EXT-X-KEY:"):
                parsed_key = parse_hls_key_tag(trimmed, p_url)
                if parsed_key and parsed_key.get("uri"):
                    k_uri = parsed_key["uri"]
                    if k_uri not in kc:
                        kr = None
                        try: kr = session.get(k_uri, timeout=15)
                        except Exception: pass
                        if (not kr or kr.status_code != 200 or len(kr.content) != 16) and proxy_url:
                            try: kr = session.post(proxy_url, json={"url": k_uri, "headers": clean_headers}, timeout=30)
                            except Exception: pass
                        if kr and kr.status_code == 200 and len(kr.content) == 16: kc[k_uri] = kr.content
                        else: raise RuntimeError(f"Could not retrieve AES key from {k_uri}")
                    parsed_key["key_bytes"] = kc.get(k_uri)
                cur_key = parsed_key
            elif trimmed.startswith("#EXT-X-MAP:"):
                map_match = re.search(r'URI=(["\']?)([^"\',\s>]+)\1', trimmed)
                if map_match: 
                    cur_init = urljoin_keep_query(p_url, map_match.group(2))
                    br_match = re.search(r'BYTERANGE=(["\']?)([^"\',\s>]+)\1', trimmed)
                    if br_match:
                        br_parts = br_match.group(2).split('@')
                        length = int(br_parts[0])
                        offset = int(br_parts[1]) if len(br_parts) > 1 else 0
                        cur_init_range = f"bytes={offset}-{offset + length - 1}"
            elif trimmed.startswith("#EXT-X-BYTERANGE:"):
                b_match = re.search(r'(\d+)(?:@(\d+))?', trimmed.split(":")[1])
                length = int(b_match.group(1))
                if b_match.group(2):
                    cur_offset = int(b_match.group(2))
                cur_range = f"bytes={cur_offset}-{cur_offset + length - 1}"
                cur_offset += length
            elif not trimmed.startswith("#"):
                segs.append({
                    "index": len(segs),
                    "url": urljoin_keep_query(p_url, trimmed),
                    "key": cur_key, "init_map": cur_init, "init_range": cur_init_range, "is_audio": is_aud, "range": cur_range
                })
                cur_range = None
        return segs, cur_init, cur_init_range

    segments, current_init_map, current_init_range = parse_playlist(playlist_text, effective_url, False)
    audio_segments, audio_init_map, audio_init_range = ([], None, None)
    if audio_playlist_text:
        audio_segments, audio_init_map, audio_init_range = parse_playlist(audio_playlist_text, audio_effective_url, True)

    total_segs = len(segments)
    if total_segs == 0: raise ValueError("No media segments found in parsed M3U8 playlist.")

    temp_dir = tempfile.mkdtemp(prefix=f"fs_{job_id}_")
    try:
        def fetch_init(init_url, filename, init_range=None):
            if not init_url: return False
            h_dict = dict(clean_headers)
            if init_range: h_dict["Range"] = init_range
            try: resp = session.get(init_url, headers=h_dict, timeout=20)
            except Exception: resp = None
            if (not resp or resp.status_code not in [200, 206]) and proxy_url:
                try: resp = session.post(proxy_url, json={"url": init_url, "headers": h_dict}, timeout=30)
                except Exception: pass
            if resp and resp.status_code in [200, 206]:
                with open(os.path.join(temp_dir, filename), "wb") as f_init:
                    f_init.write(resp.content)
                return True
            return False

        has_init = fetch_init(current_init_map, "init.mp4", current_init_range)
        has_audio_init = fetch_init(audio_init_map, "ainit.mp4", audio_init_range) if audio_segments else False

        def fetch_segment(seg_info):
            s_idx, s_url, k_info, is_aud = seg_info["index"], seg_info["url"], seg_info["key"], seg_info["is_audio"]
            s_range = seg_info.get("range")
            for attempt in range(4):
                try:
                    h_dict = dict(clean_headers)
                    if s_range: h_dict["Range"] = s_range
                    s_res = session.get(s_url, headers=h_dict, timeout=30)
                    if s_res.status_code in (200, 206): seg_data = s_res.content
                    elif (s_res.status_code in (401, 403)) and proxy_url:
                        proxied_res = session.post(proxy_url, json={"url": s_url, "headers": h_dict}, timeout=45)
                        if proxied_res.status_code in (200, 206): seg_data = proxied_res.content
                        else: raise RuntimeError(f"Proxy HTTP {proxied_res.status_code}")
                    else: raise RuntimeError(f"HTTP {s_res.status_code}")

                    if k_info and k_info.get("method") == "AES-128" and k_info.get("key_bytes"):
                        iv = k_info.get("iv") or s_idx.to_bytes(16, byteorder="big")
                        seg_data = decrypt_hls_segment(seg_data, k_info["key_bytes"], iv)

                    prefix = "aseg" if is_aud else "seg"
                    dest_file = os.path.join(temp_dir, f"{prefix}_{s_idx:06d}.ts")
                    with open(dest_file, "wb") as sf: sf.write(seg_data)
                    return s_idx, len(seg_data), is_aud
                except (requests.RequestException, IOError, RuntimeError) as ex:
                    if attempt == 3: raise RuntimeError(f"Failed to fetch segment #{s_idx}")
                    time.sleep(0.25 * (attempt + 1))

        downloaded_video, downloaded_audio = set(), set()
        next_v_to_pipe, next_a_to_pipe = 0, 0
        next_v_to_pipe = 0
        total_a = len(audio_segments)
        
        audio_server_port = 0
        stop_event = threading.Event()
        if total_a > 0:
            from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
            
            class AudioHandler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4" if has_audio_init else "video/MP2T")
                    self.end_headers()
                    if has_audio_init:
                        try:
                            with open(os.path.join(temp_dir, "ainit.mp4"), "rb") as ai:
                                shutil.copyfileobj(ai, self.wfile)
                        except BrokenPipeError:
                            return
                    next_a_to_serve = 0
                    while next_a_to_serve < total_a and not stop_event.is_set():
                        if next_a_to_serve in downloaded_audio:
                            seg_p = os.path.join(temp_dir, f"aseg_{next_a_to_serve:06d}.ts")
                            if os.path.exists(seg_p):
                                try:
                                    with open(seg_p, "rb") as in_seg:
                                        shutil.copyfileobj(in_seg, self.wfile)
                                except BrokenPipeError:
                                    break
                                os.remove(seg_p)
                            downloaded_audio.remove(next_a_to_serve)
                            next_a_to_serve += 1
                        else:
                            time.sleep(0.05)

                def log_message(self, format, *args): pass

            audio_server = ThreadingHTTPServer(('127.0.0.1', 0), AudioHandler)
            audio_server_port = audio_server.server_port
            audio_server_thread = threading.Thread(target=audio_server.serve_forever, daemon=True)
            audio_server_thread.start()

        remux_cmd = ["ffmpeg", "-y", "-probesize", "50M", "-analyzeduration", "50M"]
        if segments:
            first_seg = segments[0]["url"].split('?')[0].lower()
            if first_seg.endswith('.aac'):
                remux_cmd.extend(["-f", "aac"])
            elif first_seg.endswith('.m4s') or first_seg.endswith('.mp4'):
                remux_cmd.extend(["-f", "mp4"])
            else:
                remux_cmd.extend(["-f", "mpegts"])
        remux_cmd.extend(["-i", "pipe:0"])
        if audio_server_port:
            ext = ".mp4" if has_audio_init else ".ts"
            remux_cmd.extend(["-i", f"http://127.0.0.1:{audio_server_port}/audio{ext}"])
            remux_cmd.extend(["-map", "0:v:0", "-map", "1:a:0?", "-map", "0:a?"])
        is_mp3_out = output_path.lower().endswith(".mp3")
        is_m4a_out = output_path.lower().endswith(".m4a")
        
        if audio_only or is_mp3_out or is_m4a_out:
            codec = "mp3" if is_mp3_out else "aac"
            remux_cmd.extend(["-vn", "-c:a", codec, "-b:a", "192k", "-movflags", "+faststart", "-fflags", "+genpts+discardcorrupt", output_path])
        else:
            remux_cmd.extend(["-c", "copy", "-movflags", "+faststart", "-fflags", "+genpts+discardcorrupt", output_path])
        
        stderr_log_path = os.path.join(temp_dir, 'ffmpeg.log')
        stderr_file = open(stderr_log_path, 'w')
        p2 = subprocess.Popen(remux_cmd, cwd=temp_dir, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=stderr_file)
        target_stdin = p2.stdin
        
        completed_count, total_downloaded_bytes = 0, 0
        start_time, last_cb_time = time.time(), time.time()
        all_segments = segments + audio_segments
        total_tasks = len(all_segments)

        with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as executor:
            future_to_idx = {executor.submit(fetch_segment, seg): seg for seg in all_segments}
            
            def video_writer_thread_func():
                nonlocal next_v_to_pipe
                try:
                    if has_init:
                        with open(os.path.join(temp_dir, "init.mp4"), "rb") as in_init:
                            shutil.copyfileobj(in_init, target_stdin, length=4*1024*1024)
                    
                    while next_v_to_pipe < len(segments) and not stop_event.is_set():
                        if next_v_to_pipe in downloaded_video:
                            seg_p = os.path.join(temp_dir, f"seg_{next_v_to_pipe:06d}.ts")
                            if os.path.exists(seg_p):
                                with open(seg_p, "rb") as in_seg:
                                    shutil.copyfileobj(in_seg, target_stdin, length=4*1024*1024)
                                os.remove(seg_p)
                            downloaded_video.remove(next_v_to_pipe)
                            next_v_to_pipe += 1
                        else:
                            time.sleep(0.05)
                except BrokenPipeError:
                    pass
                finally:
                    target_stdin.close()

            video_thread = threading.Thread(target=video_writer_thread_func, daemon=True)
            video_thread.start()

            for future in concurrent.futures.as_completed(future_to_idx):
                s_idx, s_bytes, is_aud = future.result()
                completed_count += 1
                total_downloaded_bytes += s_bytes
                if is_aud: downloaded_audio.add(s_idx)
                else: downloaded_video.add(s_idx)
                
                if "telegram" in (target_service or "").lower() and total_downloaded_bytes > 2000 * 1024 * 1024:
                    stop_event.set()
                    raise RuntimeError("Aborted: Stream exceeds Telegram's 2GB absolute limit.")

                now = time.time()
                if (now - last_cb_time >= 1.5) or (completed_count == total_tasks):
                    last_cb_time = now
                    progress_pct = 12 + int((completed_count / total_tasks) * 58)
                    elapsed = max(now - start_time, 0.05)
                    speed_mb = (total_downloaded_bytes / (1024 * 1024)) / elapsed
                    speed_str = f"Processing {completed_count}/{total_tasks} • {speed_mb:.1f} MB/s"
                    send_callback(callback_url, job_id, "RUNNING", stage="DOWNLOADING", progress=progress_pct, speed=speed_str)

        video_thread.join(timeout=30)
        p2.wait()
        stderr_file.close()
        if audio_server_port: audio_server.shutdown()

        if p2.returncode != 0:
            err_log = ""
            if os.path.exists(stderr_log_path):
                with open(stderr_log_path, 'r') as f:
                    err_log = f.read()
            raise RuntimeError(f"FFmpeg crashed (code {p2.returncode})! Log: {err_log}")

        total_time = max(time.time() - start_time, 0.1)
        out_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"[+] Hybrid Download & Remux completed in {total_time:.1f}s! Size: {out_size_mb:.2f} MB", flush=True)
        return True
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

# ─── Universal Cloud Uploaders (Curl C-Engine & Boto3) ──────────────────────

def run_curl_upload(file_path, url, method="PUT", headers=None, multipart_fields=None, file_field="file", service_name="Cloud"):
    import subprocess, time, os, re
    
    cmd = ["curl", "--http1.1", "-S", "-#", "--noproxy", "*"]
    if _global_max_upload_speed > 0:
        cmd.extend(["--limit-rate", f"{int(_global_max_upload_speed)}M"])
    
    if headers:
        for k, v in headers.items(): cmd.extend(["-H", f"{k}: {v}"])
    
    if multipart_fields is not None:
        cmd.extend(["-X", "POST"])
        for k, v in multipart_fields.items(): cmd.extend(["-F", f"{k}={v}"])
        cmd.extend(["-F", f"{file_field}=@{file_path}"])
    else:
        cmd.extend(["-X", method, "-T", file_path])
    
    cmd.append(url)
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    
    last_cb_time = time.time()
    start_time = time.time()
    file_size = os.path.getsize(file_path)
    buffer = ""

    while True:
        char = process.stderr.read(1)
        if not char and process.poll() is not None: break
        
        # Read curl's stderr output character by character to catch carriage returns
        if char in ('\r', '\n'):
            line = buffer.strip()
            buffer = ""
            # Parse curl's native progress bar (e.g., "#####      20.5%")
            match = re.search(r'(\d+\.?\d*)%', line)
            if match:
                now = time.time()
                if now - last_cb_time >= 2.0:
                    try:
                        pct_float = float(match.group(1))
                        cb_pct = 75 + int((pct_float / 100) * 23)
                        sent_mb = (file_size * (pct_float / 100)) / (1024 * 1024)
                        tot_mb = file_size / (1024 * 1024)
                        elapsed = max(now - start_time, 0.05)
                        speed_mb = sent_mb / elapsed
                        
                        speed_str = f"{service_name} • {sent_mb:.1f}/{tot_mb:.1f} MB • {speed_mb:.1f} MB/s"
                        send_callback(_global_callback_url, _global_job_id, "RUNNING", stage="UPLOADING", progress=cb_pct, speed=speed_str)
                        last_cb_time = now
                    except JobCancelledError:
                        process.terminate()
                        raise
                    except Exception: pass
        else:
            buffer += char

    process.wait()
    out = process.stdout.read()
    err = process.stderr.read()
    
    if process.returncode != 0:
        raise RuntimeError(f"{service_name} upload failed (exit {process.returncode}): {err.strip()[-200:]}")
    return out

def upload_gofile(file_path, file_name, creds):
    token = str(creds.get("token") or "").strip()
    folder_id = str(creds.get("folderId") or "").strip()

    if not token:
        try:
            acc_res = requests.post("https://api.gofile.io/accounts", timeout=15)
            if acc_res.ok and acc_res.json().get("data"):
                token = acc_res.json()["data"].get("token", "").strip()
                folder_id = folder_id or acc_res.json()["data"].get("rootFolder", "").strip()
        except Exception: pass

    upload_url = "https://upload.gofile.io/uploadfile"
    try:
        srv_res = requests.get("https://api.gofile.io/servers", timeout=10)
        if srv_res.ok and srv_res.json().get("data", {}).get("servers"):
            upload_url = f"https://{srv_res.json()['data']['servers'][0]['name']}.gofile.io/contents/uploadfile"
    except Exception: pass

    headers = {"User-Agent": "Mozilla/5.0"}
    if token: headers["Authorization"] = f"Bearer {token}"
    
    data_payload = {}
    if folder_id: data_payload["folderId"] = folder_id

    try:
        out = run_curl_upload(file_path, upload_url, method="POST", headers=headers, multipart_fields=data_payload, service_name="GoFile")
        res = json.loads(out)
    except Exception:
        out = run_curl_upload(file_path, "https://upload.gofile.io/uploadfile", method="POST", headers=headers, multipart_fields=data_payload, service_name="GoFile")
        res = json.loads(out)

    if res.get("status") == "ok" and res.get("data"):
        data = res["data"]
        page = data.get("downloadPage") or data.get("directLink")
        
        active_token = (token or data.get("guestToken") or "").strip()
        if active_token and data.get("parentFolder"):
            try:
                requests.put(f"https://api.gofile.io/contents/{data['parentFolder']}/update", headers={"Authorization": f"Bearer {active_token}"}, json={"attribute": "public", "attributeValue": "true"}, timeout=10)
            except Exception: pass
        if page: return page
    raise RuntimeError(f"GoFile upload error: {res}")

def upload_buzzheavier(file_path, file_name, creds):
    upload_url = f"https://w.buzzheavier.com/{urllib.parse.quote(file_name)}"
    headers = {"User-Agent": "Mozilla/5.0"}
    account_id = creds.get("accountId") or creds.get("token") or creds.get("apiKey")
    if account_id: headers["Authorization"] = f"Bearer {str(account_id).strip()}"

    out = run_curl_upload(file_path, upload_url, method="PUT", headers=headers, service_name="Buzzheavier")
    try:
        data = json.loads(out)
        if data.get("id") or data.get("data", {}).get("id"):
            return f"https://buzzheavier.com/{data.get('id') or data['data']['id']}"
    except Exception: pass
    return out.strip() if out.strip().startswith("http") else f"https://buzzheavier.com/{urllib.parse.quote(file_name)}"

def upload_fuckingfast(file_path, file_name, creds):
    upload_url = f"https://w.fuckingfast.net/{urllib.parse.quote(file_name)}"
    headers = {"User-Agent": "Mozilla/5.0"}
    account_id = creds.get("accountId") or creds.get("token") or creds.get("apiKey")
    if account_id: headers["Authorization"] = f"Bearer {str(account_id).strip()}"

    out = run_curl_upload(file_path, upload_url, method="PUT", headers=headers, service_name="FFast")
    try:
        data = json.loads(out)
        if data.get("id") or data.get("data", {}).get("id"):
            return f"https://fuckingfast.net/{data.get('id') or data['data']['id']}"
    except Exception: pass
    return out.strip() if out.strip().startswith("http") else f"https://fuckingfast.net/{urllib.parse.quote(file_name)}"

def upload_pixeldrain(file_path, file_name, creds):
    api_key = str(creds.get("apiKey") or creds.get("token") or "").strip()
    if not api_key: raise ValueError("Pixeldrain requires a free API key for uploads.")

    import base64
    auth_str = base64.b64encode(f":{api_key}".encode("utf-8")).decode("utf-8")
    headers = {"User-Agent": "Mozilla/5.0", "Authorization": f"Basic {auth_str}"}

    pixeldrain_hosts = ["pixeldrain.com", "pixeldrain.net", "pixeldrain.nl", "pixeldrain.biz"]
    last_err = "No response from PixelDrain"
    for host in pixeldrain_hosts:
        try:
            out = run_curl_upload(file_path, f"https://{host}/api/file", method="POST", headers=headers, multipart_fields={}, file_field="file", service_name="Pixeldrain")
            data = json.loads(out)
            if data.get("id"): return f"https://{host}/u/{data['id']}"
            last_err = f"{host}: {out.strip()[:250]}"
        except Exception as ex: last_err = ex
    raise RuntimeError(f"Pixeldrain failed: {last_err}")

def presign_s3_url(endpoint, bucket, path, region, access_key_id, secret_access_key, expires_in=604800):
    now = datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    clean_endpoint = endpoint.rstrip("/")
    parsed = urllib.parse.urlparse(clean_endpoint)
    host = parsed.netloc

    endpoint_path = parsed.path.strip("/")
    if endpoint_path:
        full_path = f"{endpoint_path}/{bucket.strip('/')}/{path.lstrip('/')}" if bucket else f"{endpoint_path}/{path.lstrip('/')}"
    else:
        full_path = f"{bucket.strip('/')}/{path.lstrip('/')}" if bucket else path.lstrip('/')
    
    canonical_uri = "/" + "/".join(urllib.parse.quote(urllib.parse.unquote(seg), safe="") for seg in full_path.split("/"))
    credential_scope = f"{date_stamp}/{region}/s3/aws4_request"

    query_params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key_id}/{credential_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires_in),
        "X-Amz-SignedHeaders": "host"
    }

    sorted_query = urllib.parse.urlencode(sorted(query_params.items()), quote_via=urllib.parse.quote)
    canonical_headers = f"host:{host}\n"
    canonical_req = f"GET\n{canonical_uri}\n{sorted_query}\n{canonical_headers}\nhost\nUNSIGNED-PAYLOAD"
    hashed_req = hashlib.sha256(canonical_req.encode("utf-8")).hexdigest()
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{hashed_req}"

    def hmac_sha256(key, val):
        return hmac.new(key, val.encode("utf-8"), hashlib.sha256).digest()

    k_date = hmac_sha256(f"AWS4{secret_access_key}".encode("utf-8"), date_stamp)
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    return f"{parsed.scheme}://{host}{canonical_uri}?{sorted_query}&X-Amz-Signature={signature}"

def resolve_hf_cdn_url(presigned_url):
    if not presigned_url or "s3.hf.co" not in presigned_url:
        return presigned_url
    try:
        res = requests.get(
            presigned_url,
            headers={"Range": "bytes=0-0", "User-Agent": "Mozilla/5.0"},
            allow_redirects=True,
            timeout=15,
            stream=True
        )
        if res.url and ("cdn.hf.co" in res.url or "xet-bridge" in res.url or res.url != presigned_url):
            final_url = res.url
            res.close()
            return final_url
        res.close()
    except Exception:
        pass
    return presigned_url

def upload_s3_boto3(file_path, file_name, creds, service_name="S3"):
    """Bypasses 5GB limit & guarantees maximum multipart parallel speed"""
    try:
        import boto3
        from boto3.s3.transfer import TransferConfig
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "boto3"], check=True)
        import boto3
        from boto3.s3.transfer import TransferConfig

    endpoint = creds.get("endpoint", "").strip()
    bucket = creds.get("bucket", "").strip()
    
    region = "us-east-1" if "hf.co" in endpoint else (creds.get("region", "auto").strip() or "auto")
    access_key = creds.get("accessKeyId", "").strip()
    secret_key = creds.get("secretAccessKey", "").strip()
    prefix = creds.get("prefix", "").strip()

    safe_name = os.path.basename(re.sub(r'[\?\#\&].*$', '', file_name).strip()) or "file.mp4"
    target_path = f"{prefix.strip('/')}/{safe_name}" if prefix else safe_name
    content_type = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"

    session = boto3.Session(aws_access_key_id=access_key, aws_secret_access_key=secret_key, region_name=region)
    
    try:
        from botocore.config import Config
        client_config = Config(
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required"
        )
    except ImportError:
        client_config = None
        
    s3_client = session.client('s3', endpoint_url=endpoint, config=client_config)

    file_size = os.path.getsize(file_path)
    last_cb_time = [time.time()]
    
    class ProgressPercentage(object):
        def __init__(self, filename):
            self._size = file_size
            self._seen_so_far = 0
            self._lock = threading.Lock()
            self._start_time = time.time()

        def __call__(self, bytes_amount):
            with self._lock:
                self._seen_so_far += bytes_amount
                now = time.time()
                
                if _global_max_upload_speed > 0:
                    elapsed = now - self._start_time
                    expected_elapsed = (self._seen_so_far / (1024 * 1024)) / _global_max_upload_speed
                    if elapsed < expected_elapsed:
                        time.sleep(expected_elapsed - elapsed)
                        now = time.time()
                
                if now - last_cb_time[0] >= 2.0 or self._seen_so_far >= self._size:
                    last_cb_time[0] = now
                    pct = 75 + int((self._seen_so_far / self._size) * 23)
                    sent_mb = self._seen_so_far / (1024 * 1024)
                    tot_mb = self._size / (1024 * 1024)
                    speed_mb = sent_mb / max(now - self._start_time, 0.05)
                    send_callback(_global_callback_url, _global_job_id, "RUNNING", stage="UPLOADING", progress=pct, speed=f"{service_name} • {sent_mb:.1f}/{tot_mb:.1f} MB • {speed_mb:.1f} MB/s")

    # S3 providers like MinIO/R2 strongly recommend larger chunks for very large uploads. 
    # To prevent Out-of-Memory (OOM) on standard runner limits, multipart chunks are capped at 1GB and 3 threads (max 3GB RAM overhead).
    # This also significantly reduces ETag concatenation and stitching overhead at the end of the multipart upload.
    dynamic_chunk = max(100 * 1024 * 1024, min(file_size // 10, 1024 * 1024 * 1024))
    
    config = TransferConfig(
        multipart_threshold=100*1024*1024, 
        max_concurrency=3, 
        multipart_chunksize=dynamic_chunk, 
        use_threads=True
    )
    s3_client.upload_file(file_path, bucket, target_path, ExtraArgs={'ContentType': content_type}, Config=config, Callback=ProgressPercentage(file_path))

    presigned = presign_s3_url(endpoint, bucket, target_path, region, access_key, secret_key, expires_in=604800)
    if "s3.hf.co" in endpoint or "hf.co" in endpoint:
        return resolve_hf_cdn_url(presigned)
    return presigned

def upload_catbox(file_path, file_name, creds):
    file_size = os.path.getsize(file_path)
    if file_size > 1024 * 1024 * 1024:
        raise RuntimeError(f"File size ({file_size / (1024*1024):.1f} MB) exceeds Catbox/Litterbox 1GB absolute limit.")
    headers = {"User-Agent": "Mozilla/5.0"}
    catbox_out = ""

    if file_size <= 200 * 1024 * 1024:
        payload = {"reqtype": "fileupload"}
        userhash = str(creds.get("userhash", "")).strip()
        if userhash:
            payload["userhash"] = userhash
        catbox_out = run_curl_upload(file_path, "https://catbox.moe/user/api.php", method="POST", headers=headers, multipart_fields=payload, file_field="fileToUpload", service_name="Catbox")
        if catbox_out.strip().startswith("http"):
            return catbox_out.strip()

        # Catbox can reject cloud-runner egress IPs as an invalid uploader.
        payload = {"reqtype": "fileupload", "time": "72h"}
        litterbox_out = run_curl_upload(file_path, "https://litterbox.catbox.moe/resources/internals/api.php", method="POST", headers=headers, multipart_fields=payload, file_field="fileToUpload", service_name="Litterbox")
        if litterbox_out.strip().startswith("http"):
            return litterbox_out.strip()
        raise RuntimeError(f"Catbox failed: {catbox_out[:125]}; Litterbox fallback failed: {litterbox_out[:125]}")

    payload = {"reqtype": "fileupload", "time": "72h"}
    out = run_curl_upload(file_path, "https://litterbox.catbox.moe/resources/internals/api.php", method="POST", headers=headers, multipart_fields=payload, file_field="fileToUpload", service_name="Litterbox")
    if out.strip().startswith("http"):
        return out.strip()
    raise RuntimeError(f"Litterbox failed: {out[:250]}")
def upload_storage_to(file_path, file_name, creds):
    content_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    file_size = os.path.getsize(file_path)
    ua = "Mozilla/5.0"

    init_res = requests.post("https://storage.to/api/upload/init", json={
        "filename": file_name,
        "content_type": content_type,
        "size": file_size
    }, headers={"Content-Type": "application/json", "User-Agent": ua}, timeout=60)
    if not init_res.ok: raise RuntimeError("Storage.to init failed")
    
    init_data = init_res.json()
    r2_key, upload_id = init_data.get("r2_key"), init_data.get("upload_id")

    if init_data.get("type") == "multipart":
        part_size, initial_urls = init_data.get("part_size", 10*1024*1024), init_data["initial_urls"]
        total_parts = init_data.get("total_parts") or len(initial_urls)
        multipart_parts = []
        with open(file_path, "rb") as f:
            for part_num in range(1, total_parts + 1):
                chunk = f.read(part_size)
                if not chunk: break
                
                start_time = time.time()
                part_res = requests.put(initial_urls[str(part_num)], data=chunk, headers={"User-Agent": ua}, timeout=300)
                elapsed = max(time.time() - start_time, 0.05)
                speed_mb = (len(chunk) / (1024 * 1024)) / elapsed
                
                multipart_parts.append({"partNumber": part_num, "etag": part_res.headers.get("ETag") or part_res.headers.get("etag")})
                pct = 75 + int((part_num / total_parts) * 23)
                send_callback(_global_callback_url, _global_job_id, "RUNNING", stage="UPLOADING", progress=pct, speed=f"Storage.to • Part {part_num}/{total_parts} • {speed_mb:.1f} MB/s")

        comp_headers = {"Content-Type": "application/json", "User-Agent": ua}
        if init_data.get("owner_token"): comp_headers["Authorization"] = f"Owner {init_data['owner_token']}"
        complete_res = requests.post("https://storage.to/api/upload/complete-multipart", json={"upload_id": upload_id, "parts": multipart_parts}, headers=comp_headers, timeout=60)
        if not complete_res.ok: raise RuntimeError(f"Storage.to multipart completion failed ({complete_res.status_code}): {complete_res.text[:250]}")
    else:
        run_curl_upload(file_path, init_data["upload_url"], method="PUT", headers={"Content-Type": content_type, "User-Agent": ua}, service_name="Storage.to")

    conf_res = requests.post("https://storage.to/api/upload/confirm", json={"filename": file_name, "content_type": content_type, "size": file_size, "r2_key": r2_key}, headers={"Content-Type": "application/json", "User-Agent": ua}, timeout=30)
    conf_data = conf_res.json()
    final_url = conf_data.get("file", {}).get("url") or conf_data.get("url") or (f"https://storage.to/{conf_data.get('file', {}).get('id')}" if conf_data.get("file", {}).get("id") else None)
    if final_url: return final_url
    raise RuntimeError("Storage.to confirmation returned no URL")

def upload_telegram(file_path, file_name, creds):
    bot_token = (creds.get("botToken") or "").strip()
    chat_id = (creds.get("chatId") or "").strip()
    if not bot_token or not chat_id: raise ValueError("Telegram missing Bot Token or Chat ID.")
    
    is_video = file_name.lower().endswith((".mp4", ".mkv", ".mov", ".webm", ".m4v", ".avi"))
    method_name = "sendVideo" if is_video else "sendDocument"
    field_name = "video" if is_video else "document"
    
    user_caption = creds.get("caption")
    final_caption = user_caption if user_caption else f"🎬 {file_name}"
    
    payload = {"chat_id": chat_id, "caption": final_caption}
    thumb_path = ""
    if is_video:
        payload["supports_streaming"] = "true"
        thumb_path = os.path.abspath(f"thumb_{int(time.time())}.jpg")
        try:
            subprocess.run(["ffmpeg", "-y", "-ss", "00:00:04", "-i", file_path, "-vframes", "1", "-q:v", "2", thumb_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if os.path.exists(thumb_path) and os.path.getsize(thumb_path) > 0:
                payload["thumb"] = f"@{thumb_path}"
        except Exception: pass

    def get_telegram_url(method_name):
        try:
            requests.get("http://127.0.0.1:8081", timeout=5)
            return f"http://127.0.0.1:8081/bot{bot_token}/{method_name}"
        except Exception as e:
            print(f"[-] Local Telegram API check failed: {e}. Falling back to public API...", flush=True)
            return f"https://api.telegram.org/bot{bot_token}/{method_name}"
            
    url = get_telegram_url(method_name)
    
    try:
        out = run_curl_upload(file_path, url, method="POST", multipart_fields=payload, file_field=field_name, service_name="Telegram")
    finally:
        if thumb_path and os.path.exists(thumb_path):
            try: os.remove(thumb_path)
            except: pass
    try:
        data = json.loads(out)
        if data.get("ok"):
            msg_id = data["result"]["message_id"]
            return f"https://t.me/c/{str(chat_id).replace('-100', '')}/{msg_id}"
    except Exception: pass
    raise RuntimeError(f"Telegram Bot API error: {out}")

# ─── Orchestrator ──────────────────────────────────────────────────────────

def normalize_service(service):
    s = (service or "").strip().lower()
    mapping = {"gofile": "gofile.io", "buzzheavier": "buzzheavier.com", "fuckingfast": "fuckingfast.co", "storage": "storage.to", "catbox": "catbox.moe", "pixeldrain": "pixeldrain.com", "s3": "s3_compatible"}
    return mapping.get(s, s)

def get_service_creds(service, creds):
    norm_service = normalize_service(service)
    aliases = {
        "gofile.io": ("gofile.io", "gofile"),
        "pixeldrain.com": ("pixeldrain.com", "pixeldrain")
    }
    for key in aliases.get(norm_service, (norm_service,)):
        if isinstance(creds.get(key), dict):
            return creds[key]
    return creds

def execute_upload(service, file_path, file_name, creds):
    norm_service = normalize_service(service)
    svc_creds = get_service_creds(norm_service, creds)
    if norm_service == "gofile.io": return upload_gofile(file_path, file_name, svc_creds)
    elif norm_service == "buzzheavier.com": return upload_buzzheavier(file_path, file_name, svc_creds)
    elif norm_service == "fuckingfast.co": return upload_fuckingfast(file_path, file_name, svc_creds)
    elif norm_service == "storage.to": return upload_storage_to(file_path, file_name, svc_creds)
    elif norm_service == "catbox.moe": return upload_catbox(file_path, file_name, svc_creds)
    elif norm_service == "pixeldrain.com": return upload_pixeldrain(file_path, file_name, svc_creds)
    elif norm_service == "s3_compatible": return upload_s3_boto3(file_path, file_name, svc_creds, "S3")
    elif norm_service == "telegram": return upload_telegram(file_path, file_name, svc_creds)
    elif norm_service == "all":
        services = ["gofile.io", "buzzheavier.com", "fuckingfast.co", "storage.to", "catbox.moe"]
        if get_service_creds("pixeldrain.com", creds).get("apiKey"): services.append("pixeldrain.com")
        if get_service_creds("telegram", creds).get("botToken") and get_service_creds("telegram", creds).get("chatId"): services.append("telegram")
        if get_service_creds("s3_compatible", creds).get("endpoint") and get_service_creds("s3_compatible", creds).get("bucket"): services.append("s3_compatible")
        links = []
        for target in services:
            try: links.append({"service": target, "url": execute_upload(target, file_path, file_name, creds)})
            except Exception as ex: links.append({"service": target, "url": "", "error": str(ex)})
        successful = [link["url"] for link in links if link.get("url")]
        if successful: return successful[0]
        raise RuntimeError(f"All uploads failed: {links}")
    else: raise ValueError(f"Unsupported service: {service}")

def main():
    parser = argparse.ArgumentParser(description="FetchStream Server-Side Stream Downloader & Uploader")
    parser.add_argument("--job-id", required=True, help="Job identifier")
    parser.add_argument("--media-url", required=True, help="Stream or File URL")
    parser.add_argument("--headers-json", default="{}", help="Captured request headers JSON")
    parser.add_argument("--file-name", default="media.mp4", help="Output file name")
    parser.add_argument("--type", default="hls", help="hls or direct")
    parser.add_argument("--format", default="mp4", help="Output format (mp4 or mp3)")
    parser.add_argument("--audio-only", action="store_true", help="Download only the audio segments")
    parser.add_argument("--service", default="gofile.io", help="Target upload service")
    parser.add_argument("--credentials-json", default="{}", help="Service credentials JSON")
    parser.add_argument("--callback-url", default="", help="EdgeProxy Pages callback URL")
    parser.add_argument("--proxy-url", default="", help="EdgeProxy Pages stream proxy URL")
    parser.add_argument("--use-fallback", default="true", help="Enable EdgeProxy fallback proxy")
    parser.add_argument("--threads", default="8", help="Number of parallel download threads (2 to 24)")
    parser.add_argument("--max-threads-per-job", default="auto")
    parser.add_argument("--min-free-space-gb", default="5")
    parser.add_argument("--max-file-size-gb", default="5")
    parser.add_argument("--max-download-speed-mbps", default="0")
    parser.add_argument("--max-upload-speed-mbps", default="0")
    parser.add_argument("--retries", default="3")
    parser.add_argument("--timeout", default="30")

    args = parser.parse_args()

    global _global_callback_url, _global_job_id, _global_max_download_speed, _global_max_upload_speed, _global_max_file_size
    _global_callback_url, _global_job_id = args.callback_url, args.job_id
    _global_max_download_speed = float(args.max_download_speed_mbps)
    _global_max_upload_speed = float(args.max_upload_speed_mbps)
    _global_max_file_size = float(args.max_file_size_gb)
    
    headers_dict = json.loads(args.headers_json) if args.headers_json else {}
    creds_dict = json.loads(args.credentials_json) if args.credentials_json else {}
    output_path = os.path.abspath(f"temp_{args.job_id}_{args.file_name}")

    send_callback(args.callback_url, args.job_id, "RUNNING", stage="STARTING", progress=10)

    def cancellation_heartbeat():
        import time, requests, os
        payload = {"jobId": args.job_id, "status": "RUNNING"}
        while True:
            time.sleep(5)
            try:
                if not args.callback_url: continue
                resp = requests.post(args.callback_url, json=payload, timeout=3)
                if resp.status_code == 200 and resp.json().get("status") == "CANCELLED":
                    print("\n[!] Job forcefully aborted by user via UI during blocking operation.", flush=True)
                    os._exit(1)
            except Exception: pass
            
    threading.Thread(target=cancellation_heartbeat, daemon=True).start()

    try:
        free_space = shutil.disk_usage("/").free
        if float(args.min_free_space_gb) > 0 and free_space < float(args.min_free_space_gb) * 1024 * 1024 * 1024:
            raise RuntimeError(f"Insufficient disk space. Minimum required: {args.min_free_space_gb} GB")

        active_threads = int(args.threads)
        if args.max_threads_per_job != "auto":
            active_threads = min(active_threads, int(args.max_threads_per_job))

        if args.type.lower() == "hls" or ".m3u8" in args.media_url.lower():
            download_hls_parallel(args.media_url, headers_dict, output_path, args.callback_url, args.job_id, threads=active_threads, proxy_url=args.proxy_url, target_service=args.service, audio_only=args.audio_only)
        else:
            print("[*] Commencing Direct File Download...", flush=True)
            sess = requests.Session()
            base_headers = sanitize_headers(headers_dict)
            if not any(k.lower() == "user-agent" for k in base_headers):
                base_headers["User-Agent"] = "Mozilla/5.0"
            
            downloaded = 0
            max_retries = 5
            for attempt in range(max_retries):
                try:
                    req_headers = dict(base_headers)
                    if downloaded > 0:
                        req_headers["Range"] = f"bytes={downloaded}-"
                    
                    resp = sess.get(args.media_url, stream=True, headers=req_headers, timeout=30)
                    resp.raise_for_status()
                    
                    if attempt == 0:
                        total_size = int(resp.headers.get("Content-Length", 0))
                    elif "Content-Range" in resp.headers:
                        pass # Keeping total_size
                    else:
                        total_size = downloaded + int(resp.headers.get("Content-Length", 0))
                        
                    mode = "ab" if downloaded > 0 else "wb"
                    with open(output_path, mode) as f:
                        start_time = time.time()
                        last_cb = start_time
                        for chunk in resp.iter_content(chunk_size=8192*4):
                            if not chunk: continue
                            f.write(chunk)
                            downloaded += len(chunk)
                            
                            if _global_max_file_size > 0 and downloaded > _global_max_file_size * 1024 * 1024 * 1024:
                                raise RuntimeError(f"File exceeds maximum allowed size ({_global_max_file_size} GB)")
                            
                            if _global_max_download_speed > 0:
                                elapsed = time.time() - start_time
                                expected_elapsed = (downloaded / (1024 * 1024)) / _global_max_download_speed
                                if elapsed < expected_elapsed:
                                    time.sleep(expected_elapsed - elapsed)
                            
                            now = time.time()
                            if now - last_cb > 1.5:
                                pct = 12 + int((downloaded / total_size * 58) if total_size else 0)
                                speed = (downloaded / (1024 * 1024)) / max(now - start_time, 0.1)
                                send_callback(args.callback_url, args.job_id, "RUNNING", stage="DOWNLOADING", progress=pct, speed=f"Downloading • {speed:.1f} MB/s")
                                last_cb = now
                    break # Success!
                except requests.exceptions.RequestException as e:
                    if attempt == max_retries - 1:
                        raise e
                    print(f"[-] Download interrupted ({e}). Retrying from byte {downloaded}...", flush=True)
                    time.sleep(2 * attempt)

        file_size = os.path.getsize(output_path)
        services_to_upload = [s.strip() for s in args.service.split(",") if s.strip()]
        all_links = []
        final_url = ""
        last_err = None
        
        for idx, svc in enumerate(services_to_upload):
            try:
                progress_step = 75 + int((idx / len(services_to_upload)) * 20)
                send_callback(args.callback_url, args.job_id, "RUNNING", stage="UPLOADING", progress=progress_step, speed=f"Uploading to {svc}...")
                print(f"[*] Uploading to {svc}...", flush=True)
                url_res = execute_upload(svc, output_path, args.file_name, creds_dict)
                all_links.append({"service": svc, "url": url_res})
                if not final_url: final_url = url_res
                send_callback(args.callback_url, args.job_id, "RUNNING", stage="UPLOADING", progress=75 + int(((idx + 1) / len(services_to_upload)) * 20), speed=f"Completed {svc}", links=all_links, service=svc)
            except Exception as e:
                print(f"[-] Failed to upload to {svc}: {e}", flush=True)
                all_links.append({"service": svc, "url": "", "error": str(e)})
                last_err = e
                send_callback(args.callback_url, args.job_id, "RUNNING", stage="UPLOADING", progress=75 + int(((idx + 1) / len(services_to_upload)) * 20), speed=f"Failed {svc}", links=all_links, service=svc)
                
        if not final_url:
            error_message = f"All uploads failed. Last error: {last_err}"
            send_callback(args.callback_url, args.job_id, "FAILED", stage="FAILED", progress=100, links=all_links, error=error_message)
            return
            
        send_callback(args.callback_url, args.job_id, "COMPLETED", stage="COMPLETED", progress=100, url=final_url, links=all_links)
    except Exception as err:
        import traceback
        traceback.print_exc()
        try:
            send_callback(args.callback_url, args.job_id, "FAILED", stage="FAILED", progress=0, error=str(err))
        except Exception: pass
        sys.exit(1)
    finally:
        try: os.remove(output_path)
        except Exception: pass

if __name__ == "__main__":
    main()

