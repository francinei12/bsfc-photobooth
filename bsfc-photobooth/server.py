#!/usr/bin/env python3
"""
BSFC Web Photobooth — Lightweight Kiosk Backend Server
---------------------------------------------------------------------------
Zero external dependencies (Python 3 standard library only).
Provides:
  - Static file hosting for the photobooth kiosk frontend
  - POST /api/photos     -> Stores captured full-color strip PNGs, returns QR share URL
  - GET  /s/<id>         -> Mobile-friendly download page when scanning the QR code
  - GET  /api/photos/<id>.png -> Direct PNG download
  - POST /api/sms        -> Twilio SMS delivery (or safe demo stub when unconfigured)
  - POST /api/print      -> Optional ESC/POS TCP socket relay (port 9100)
  - GET  /api/health     -> Kiosk & printer status check
"""

import base64
import html
import json
import mimetypes
import os
import re
import smtplib
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STRIPS_DIR = DATA_DIR / "strips"
SMS_LOG_PATH = DATA_DIR / "sms_log.jsonl"

STRIPS_DIR.mkdir(parents=True, exist_ok=True)

PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")

# Optional Twilio configuration via environment variables
TWILIO_SID = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_FROM = os.environ.get("TWILIO_FROM_NUMBER", "").strip()

# Optional 100% Free SMTP Email configuration (e.g., Gmail + App Password)
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASS = os.environ.get("SMTP_PASS", "").strip()

# Optional networked Epson TM-T20III IP (RAW ESC/POS port 9100)
PRINTER_IP = os.environ.get("BSFC_PRINTER_IP", "").strip()
PRINTER_PORT = int(os.environ.get("BSFC_PRINTER_PORT", "9100"))

MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8 MB cap per photo strip


def normalize_us_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if raw.strip().startswith("+") and len(digits) >= 10:
        return f"+{digits}"
    raise ValueError("Invalid mobile phone number (need at least 10 digits)")


def send_twilio_sms(to_number: str, body_text: str) -> dict:
    if not (TWILIO_SID and TWILIO_TOKEN and TWILIO_FROM):
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "to": to_number,
            "body": body_text,
            "mode": "stub",
        }
        with open(SMS_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        print(f"[SMS STUB] To {to_number}: {body_text}")
        return {"ok": True, "mode": "stub", "message": "Demo SMS logged on server"}

    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json"
    form = urllib.parse.urlencode(
        {"To": to_number, "From": TWILIO_FROM, "Body": body_text}
    ).encode("utf-8")

    auth = base64.b64encode(f"{TWILIO_SID}:{TWILIO_TOKEN}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        data=form,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
        return {"ok": True, "mode": "twilio", "sid": payload.get("sid")}


def send_free_email(to_email: str, share_url: str, photo_id: str) -> dict:
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", to_email or ""):
        raise ValueError("Invalid email address")

    if not (SMTP_USER and SMTP_PASS):
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "to": to_email,
            "shareUrl": share_url,
            "mode": "stub",
        }
        with open(SMS_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        print(f"[EMAIL STUB] To {to_email}: {share_url}")
        return {"ok": True, "mode": "stub", "message": "Demo email logged on server"}

    msg = EmailMessage()
    msg["Subject"] = "Your BSFC Storefront Photobooth Strip!"
    msg["From"] = SMTP_USER
    msg["To"] = to_email
    msg.set_content(
        "Thanks for visiting the Berkeley Student Food Collective!\n\n"
        f"View or download your photostrip: {share_url}\n"
        "Tag us @bsfcollective · 2440 Bancroft Way #102, Berkeley, CA 94704\n"
    )
    img_path = STRIPS_DIR / f"{photo_id}.png"
    if photo_id and img_path.is_file():
        msg.add_attachment(
            img_path.read_bytes(),
            maintype="image",
            subtype="png",
            filename=f"bsfc-photostrip-{photo_id}.png",
        )

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=12) as server:
        server.starttls()
        server.login(SMTP_USER, SMTP_PASS)
        server.send_message(msg)
    return {"ok": True, "mode": "smtp"}


class PhotoboothHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def send_json(self, code: int, payload: dict):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            raise ValueError("Invalid or oversized request body")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            count = len(list(STRIPS_DIR.glob("*.png")))
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "storedPhotos": count,
                    "smsConfigured": bool(TWILIO_SID and TWILIO_TOKEN and TWILIO_FROM),
                    "printerRelayConfigured": bool(PRINTER_IP),
                },
            )
            return

        # Serve individual saved PNG strip: /api/photos/<id>.png
        m_img = re.fullmatch(r"/api/photos/([a-f0-9]{8,32})\.png", path)
        if m_img:
            photo_id = m_img.group(1)
            img_path = STRIPS_DIR / f"{photo_id}.png"
            if not img_path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND, "Photo strip not found")
                return
            data = img_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.send_header(
                "Content-Disposition", f'inline; filename="bsfc-photostrip-{photo_id}.png"'
            )
            self.end_headers()
            self.wfile.write(data)
            return

        # Serve mobile QR landing page: /s/<id>
        m_share = re.fullmatch(r"/s/([a-f0-9]{8,32})", path)
        if m_share:
            photo_id = m_share.group(1)
            img_path = STRIPS_DIR / f"{photo_id}.png"
            if not img_path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND, "Photo strip not found or expired")
                return
            safe_id = html.escape(photo_id)
            page = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your BSFC Photostrip</title>
  <style>
    body {{
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: #FBF6F3; color: #1E1B18; display: flex; flex-direction: column;
      align-items: center; padding: 24px 16px; text-align: center;
    }}
    h1 {{ font-size: 1.4rem; margin: 0 0 8px; color: #E63423; }}
    p {{ margin: 0 0 18px; color: #5E5650; font-size: 0.95rem; }}
    img {{
      max-width: 420px; width: 100%; border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0,0,0,0.16); border: 1px solid #DCDAD2;
    }}
    .btn {{
      display: inline-block; margin-top: 20px; background: #E63423; color: #FFF;
      text-decoration: none; font-weight: 800; padding: 14px 26px; border-radius: 12px;
      box-shadow: 0 4px 14px rgba(230,52,35,0.3);
    }}
  </style>
</head>
<body>
  <h1>Berkeley Student Food Collective</h1>
  <p>Too good not to snap! Tap below to save your strip to your phone.</p>
  <img src="/api/photos/{safe_id}.png" alt="BSFC Photostrip" />
  <a class="btn" href="/api/photos/{safe_id}.png" download="bsfc-photostrip-{safe_id}.png">
    Download Photo Strip
  </a>
</body>
</html>"""
            raw = page.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        # Prevent exposing /data directory over static handler
        if path.startswith("/data"):
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/photos":
            try:
                body = self.read_json_body()
                b64 = body.get("imageBase64", "")
                if "," in b64:
                    b64 = b64.split(",", 1)[1]
                img_bytes = base64.b64decode(b64, validate=True)
                if not img_bytes.startswith(b"\x89PNG"):
                    raise ValueError("Uploaded image must be a valid PNG")
                photo_id = uuid.uuid4().hex[:12]
                (STRIPS_DIR / f"{photo_id}.png").write_bytes(img_bytes)
                self.send_json(
                    HTTPStatus.CREATED,
                    {
                        "ok": True,
                        "id": photo_id,
                        "shareUrl": f"/s/{photo_id}",
                        "downloadUrl": f"/api/photos/{photo_id}.png",
                    },
                )
            except Exception as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if path == "/api/sms":
            try:
                body = self.read_json_body()
                share_url = str(body.get("shareUrl", "")).strip()
                email_addr = str(body.get("email", "")).strip()
                photo_id = str(body.get("photoId", "")).strip()
                if email_addr:
                    result = send_free_email(email_addr, share_url, photo_id)
                else:
                    to_num = normalize_us_phone(body.get("phone", ""))
                    msg = (
                        f"Thanks for visiting Berkeley Student Food Collective! "
                        f"Save your photobooth strip here: {share_url} (@bsfcollective)"
                    )
                    result = send_twilio_sms(to_num, msg)
                self.send_json(HTTPStatus.OK, result)
            except urllib.error.HTTPError as exc:
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"ok": False, "error": f"Twilio error HTTP {exc.code}"},
                )
            except Exception as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if path == "/api/print":
            if not PRINTER_IP:
                self.send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"ok": False, "error": "Backend printer IP not configured (BSFC_PRINTER_IP)"},
                )
                return
            try:
                body = self.read_json_body()
                raw_escpos = base64.b64decode(body.get("escposBase64", ""), validate=True)
                with socket.create_connection((PRINTER_IP, PRINTER_PORT), timeout=4) as sock:
                    sock.sendall(raw_escpos)
                self.send_json(
                    HTTPStatus.OK,
                    {"ok": True, "message": f"Sent {len(raw_escpos)} bytes to {PRINTER_IP}:{PRINTER_PORT}"},
                )
            except Exception as exc:
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"ok": False, "error": f"Network printer error: {exc}"},
                )
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown API endpoint"})

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        m_img = re.fullmatch(r"/api/photos/([a-f0-9]{8,32})", parsed.path)
        if not m_img:
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown API endpoint"})
            return
        photo_id = m_img.group(1)
        img_path = STRIPS_DIR / f"{photo_id}.png"
        if not img_path.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Photo ID not found"})
            return
        try:
            body = self.read_json_body()
            b64 = body.get("imageBase64", "")
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            img_bytes = base64.b64decode(b64, validate=True)
            if not img_bytes.startswith(b"\x89PNG"):
                raise ValueError("Uploaded image must be a valid PNG")
            img_path.write_bytes(img_bytes)
            self.send_json(HTTPStatus.OK, {"ok": True, "id": photo_id})
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})


def main():
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer((HOST, PORT), PhotoboothHandler)
    print(f"BSFC Photobooth Server running on http://{HOST}:{PORT}")
    print(f"Saved strips directory: {STRIPS_DIR}")
    print(
        "SMS mode:",
        "Twilio Live" if (TWILIO_SID and TWILIO_TOKEN and TWILIO_FROM) else "Demo Stub (set TWILIO_* env vars for live SMS)",
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.server_close()


if __name__ == "__main__":
    main()
