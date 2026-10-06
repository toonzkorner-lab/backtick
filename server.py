"""Backtick — a developer-oriented Telegram web client.

Uses your own api_id / api_hash from https://my.telegram.org.
Session strings stay on this machine (and optionally in the browser).
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
import mimetypes
import random
import re
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from telethon import TelegramClient, events, utils
from telethon.errors import (
    FileMigrateError,
    FloodWaitError,
    PasswordHashInvalidError,
    PhoneCodeExpiredError,
    PhoneCodeInvalidError,
    SessionPasswordNeededError,
)
from telethon.tl.functions.upload import GetFileRequest, SaveBigFilePartRequest, SaveFilePartRequest
from telethon.tl.types import InputFile, InputFileBig
from telethon.sessions import StringSession
from telethon.tl.functions.account import (
    GetAuthorizationsRequest,
    GetPrivacyRequest,
    ResetAuthorizationRequest,
    SetPrivacyRequest,
    UpdateProfileRequest,
)
from telethon.tl.functions.users import GetFullUserRequest
from telethon.tl.functions.channels import GetFullChannelRequest
from telethon.tl.types import (
    InputPrivacyKeyAbout,
    InputPrivacyKeyAddedByPhone,
    InputPrivacyKeyChatInvite,
    InputPrivacyKeyForwards,
    InputPrivacyKeyPhoneCall,
    InputPrivacyKeyPhoneNumber,
    InputPrivacyKeyPhoneP2P,
    InputPrivacyKeyProfilePhoto,
    InputPrivacyKeyStatusTimestamp,
    InputPrivacyKeyVoiceMessages,
    InputPrivacyValueAllowAll,
    InputPrivacyValueAllowContacts,
    InputPrivacyValueDisallowAll,
    DocumentAttributeAudio,
    DocumentAttributeFilename,
    DocumentAttributeSticker,
    MessageMediaDocument,
    MessageMediaPhoto,
    User,
)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
SESSION_DIR = ROOT / "sessions"
SESSION_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Backtick", version="0.6.0")

# Uploads are buffered in RAM, so cap a single upload to protect the server.
# Raise this if the machine has headroom; Telegram user accounts allow up to 2 GB.
MAX_UPLOAD_BYTES = 200 * 1024 * 1024


@app.middleware("http")
async def _security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; "
        "connect-src 'self' ws: wss:; "
        "font-src 'self'; "
        "frame-ancestors 'none'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response

CODE_EXTS = {
    ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs",
    ".rb", ".php", ".swift", ".scala", ".sh", ".bash", ".zsh", ".fish",
    ".sql", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css",
    ".scss", ".md", ".rs", ".lua", ".ex", ".exs", ".hs", ".ml", ".vue",
    ".svelte", ".dart", ".dockerfile", ".tf", ".gradle", ".ini", ".env",
    ".diff", ".patch", ".log",
}

LANG_BY_EXT = {
    ".py": "python", ".pyi": "python", ".js": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".mjs": "javascript",
    ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
    ".rb": "ruby", ".php": "php", ".swift": "swift", ".sh": "bash",
    ".bash": "bash", ".zsh": "bash", ".sql": "sql", ".json": "json",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".xml": "xml",
    ".html": "html", ".css": "css", ".scss": "scss", ".md": "markdown",
    ".lua": "lua", ".vue": "xml", ".dart": "dart", ".diff": "diff",
    ".patch": "diff",
}


class AuthState:
    def __init__(self) -> None:
        self.client: TelegramClient | None = None
        self.api_id: int | None = None
        self.api_hash: str | None = None
        self.phone: str | None = None
        self.phone_code_hash: str | None = None
        self.lock = asyncio.Lock()

    @property
    def ready(self) -> bool:
        return self.client is not None


state = AuthState()


class LiveState:
    """Tracks browser tabs listening for live Telegram updates."""

    def __init__(self) -> None:
        self.sockets: set[WebSocket] = set()
        self.handler_client: TelegramClient | None = None


live = LiveState()


async def _broadcast(payload: dict[str, Any]) -> None:
    dead = []
    for ws in live.sockets:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        live.sockets.discard(ws)


async def _on_new_message(event) -> None:
    """Push every new message (incoming and outgoing) to listening tabs."""
    try:
        data = _serialize_message(event.message)
        if not data["sender"]:
            try:
                sender = await event.get_sender()
                data["sender"] = utils.get_display_name(sender) or None
            except Exception:
                pass
        # event.chat_id is the marked peer id, matching dialog ids from /api/dialogs.
        await _broadcast({"type": "message", "peer": str(event.chat_id), "message": data})
    except Exception:
        pass


def _ensure_live_handler(client: TelegramClient) -> None:
    if live.handler_client is client:
        return
    if live.handler_client is not None:
        try:
            live.handler_client.remove_event_handler(_on_new_message)
        except Exception:
            pass
    client.add_event_handler(_on_new_message, events.NewMessage())
    live.handler_client = client


def _drop_live_handler() -> None:
    if live.handler_client is not None:
        try:
            live.handler_client.remove_event_handler(_on_new_message)
        except Exception:
            pass
    live.handler_client = None


class SendCodeIn(BaseModel):
    api_id: int
    api_hash: str = Field(min_length=8)
    phone: str


class SignInIn(BaseModel):
    code: str = ""
    password: str = ""


class RestoreIn(BaseModel):
    api_id: int
    api_hash: str
    session: str


class SendIn(BaseModel):
    peer: str
    text: str
    reply_to: int | None = None


class BotCall(BaseModel):
    token: str
    method: str
    params: dict[str, Any] = {}


BOT_METHODS = {
    "getMe", "getWebhookInfo", "getUpdates", "sendMessage", "deleteWebhook",
    "setWebhook", "getChat", "getChatMember", "getChatAdministrators",
    "getChatMemberCount", "getMyCommands", "setMyCommands",
    "deleteMessage", "getMyDefaultAdministratorRights",
    "editMessageText", "answerCallbackQuery", "sendDocument",
}


class SearchIn(BaseModel):
    peer: str
    query: str
    regex: bool = False
    limit: int = 30


def _require_client() -> TelegramClient:
    if state.client is None:
        raise HTTPException(401, "Not signed in")
    return state.client


PART = 512 * 1024
TRANSFER_WORKERS = 8


async def _fast_download(client: TelegramClient, message) -> bytes:
    size = message.file.size if message.file else 0
    if not size or size < PART:
        buf = BytesIO()
        await client.download_media(message, file=buf)
        return buf.getvalue()
    dc_id, location = utils.get_input_location(message.media)
    sender = None
    if dc_id:
        try:
            sender = await client._borrow_exported_sender(dc_id)
        except Exception:
            sender = None
    sem = asyncio.Semaphore(TRANSFER_WORKERS)

    async def grab(offset: int) -> tuple[int, bytes]:
        nonlocal sender
        limit = min(PART, size - offset)
        req = GetFileRequest(location, offset, limit)
        async with sem:
            for _ in range(4):
                try:
                    result = await sender.send(req) if sender else await client(req)
                    return offset, result.bytes
                except FileMigrateError as exc:
                    if sender:
                        await client._return_exported_sender(sender)
                    sender = await client._borrow_exported_sender(exc.new_dc)
            raise HTTPException(502, "Telegram download failed")

    parts = await asyncio.gather(*(grab(offset) for offset in range(0, size, PART)))
    if sender:
        await client._return_exported_sender(sender)
    blob = bytearray(size)
    for offset, data in parts:
        blob[offset:offset + len(data)] = data
    return bytes(blob)


async def _fast_upload(client: TelegramClient, data: bytes, name: str):
    file_id = random.randrange(1, 2**62)
    total = max(1, (len(data) + PART - 1) // PART)
    big = len(data) > 10 * 1024 * 1024
    sem = asyncio.Semaphore(TRANSFER_WORKERS)

    async def put(index: int) -> None:
        chunk = data[index * PART:(index + 1) * PART]
        async with sem:
            if big:
                await client(SaveBigFilePartRequest(file_id, index, total, chunk))
            else:
                await client(SaveFilePartRequest(file_id, index, chunk))

    await asyncio.gather(*(put(index) for index in range(total)))
    if big:
        return InputFileBig(id=file_id, parts=total, name=name)
    return InputFile(id=file_id, parts=total, name=name, md5_checksum="")


def _filename(message) -> str | None:
    if not message.media or not isinstance(message.media, MessageMediaDocument):
        return None
    doc = message.media.document
    if not doc:
        return None
    for attr in doc.attributes or []:
        if isinstance(attr, DocumentAttributeFilename):
            return attr.file_name
    return None


def _serialize_message(message) -> dict[str, Any]:
    name = _filename(message)
    ext = Path(name).suffix.lower() if name else ""
    text = message.message or ""
    media_kind = None
    if isinstance(message.media, MessageMediaPhoto):
        media_kind = "photo"
    elif isinstance(message.media, MessageMediaDocument):
        media_kind = "file"
        if name and ext in CODE_EXTS:
            media_kind = "code"
    sender = None
    if message.sender:
        sender = utils.get_display_name(message.sender) or "Unknown"
    sticker = False
    voice = False
    voice_duration = None
    if isinstance(message.media, MessageMediaDocument):
        attrs = getattr(message.media.document, "attributes", None) or []
        sticker = any(isinstance(a, DocumentAttributeSticker) for a in attrs)
        for a in attrs:
            if isinstance(a, DocumentAttributeAudio) and getattr(a, "voice", False):
                voice = True
                voice_duration = getattr(a, "duration", None)
                break
    return {
        "id": message.id,
        "text": text,
        "date": message.date.isoformat() if message.date else None,
        "out": bool(message.out),
        "sender": sender,
        "reply_to": getattr(message, "reply_to_msg_id", None),
        "file_name": name,
        "file_ext": ext,
        "lang": LANG_BY_EXT.get(ext),
        "media_kind": media_kind,
        "sticker": sticker,
        "voice": voice,
        "voice_duration": voice_duration,
        "views": getattr(message, "views", None),
        "edited": bool(message.edit_date),
    }


def _attach_reply_context(rows: list[dict[str, Any]]) -> None:
    """Fill reply_sender/reply_text when the quoted message is in the same batch."""
    by_id = {r["id"]: r for r in rows}
    for r in rows:
        rid = r.get("reply_to")
        target = by_id.get(rid) if rid else None
        if not target:
            continue
        r["reply_sender"] = target.get("sender") or ("you" if target.get("out") else "them")
        text = target.get("text") or ""
        if not text and target.get("file_name"):
            text = f"[{target['file_name']}]"
        r["reply_text"] = text.replace("\n", " ")[:120]


SEND_LIMIT = 4000  # Telegram's hard cap is 4096; stay safely under it.


def _split_text(text: str, limit: int = SEND_LIMIT) -> list[str]:
    """Split an over-long message on paragraph/line boundaries."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = rest.rfind("\n\n", 0, limit)
        if cut <= 0:
            cut = rest.rfind("\n", 0, limit)
        if cut <= 0:
            cut = limit
        chunks.append(rest[:cut])
        rest = rest[cut:].lstrip("\n")
        if not rest:
            break
    if rest:
        chunks.append(rest)
    return chunks


def _serialize_dialog(dialog) -> dict[str, Any]:
    entity = dialog.entity
    kind = "chat"
    username = None
    if isinstance(entity, User):
        kind = "bot" if entity.bot else "user"
        username = entity.username
    else:
        username = getattr(entity, "username", None)
        if getattr(entity, "broadcast", False):
            kind = "channel"
        elif getattr(entity, "megagroup", False):
            kind = "group"
        else:
            kind = "group"
    last = ""
    if dialog.message and dialog.message.message:
        last = dialog.message.message.replace("\n", " ")[:140]
    elif dialog.message and dialog.message.media:
        last = "[file]"
    return {
        "id": str(dialog.id),
        "name": dialog.name or "Untitled",
        "username": username,
        "kind": kind,
        "unread": dialog.unread_count or 0,
        "last": last,
        "date": dialog.date.isoformat() if dialog.date else None,
        "pinned": bool(dialog.pinned),
    }


@app.get("/api/health")
async def health():
    me = None
    if state.client and await state.client.is_user_authorized():
        user = await state.client.get_me()
        me = {
            "id": user.id,
            "name": utils.get_display_name(user),
            "username": user.username,
            "phone": user.phone,
        }
    return {"ok": True, "authorized": me is not None, "me": me}


@app.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket):
    """Live Telegram updates for open browser tabs. Pushes new messages as they arrive."""
    await ws.accept()
    if state.client is None:
        await ws.send_json({"type": "error", "detail": "not signed in"})
        await ws.close()
        return
    live.sockets.add(ws)
    try:
        await ws.send_json({"type": "hello"})
        while True:
            await ws.receive_text()  # keep-alive; the server only pushes
    except WebSocketDisconnect:
        pass
    finally:
        live.sockets.discard(ws)


@app.post("/api/auth/send-code")
async def send_code(body: SendCodeIn):
    async with state.lock:
        if state.client:
            await state.client.disconnect()
        client = TelegramClient(StringSession(), body.api_id, body.api_hash)
        await client.connect()
        try:
            sent = await client.send_code_request(body.phone)
        except FloodWaitError as exc:
            await client.disconnect()
            raise HTTPException(429, f"Telegram rate limit. Wait {exc.seconds}s") from exc
        except Exception as exc:  # noqa: BLE001 — surface Telegram errors to the UI
            await client.disconnect()
            raise HTTPException(400, str(exc)) from exc
        state.client = client
        state.api_id = body.api_id
        state.api_hash = body.api_hash
        state.phone = body.phone
        state.phone_code_hash = sent.phone_code_hash
    return {"ok": True, "phone": body.phone}


@app.post("/api/auth/sign-in")
async def sign_in(body: SignInIn):
    client = _require_client()
    if not state.phone or not state.phone_code_hash:
        raise HTTPException(400, "Request a login code first")
    try:
        if body.password and not body.code.strip():
            await client.sign_in(password=body.password)
        else:
            await client.sign_in(
                phone=state.phone,
                code=body.code.strip(),
                phone_code_hash=state.phone_code_hash,
            )
    except SessionPasswordNeededError:
        if not body.password:
            return {"ok": False, "needs_password": True}
        await client.sign_in(password=body.password)
    except PhoneCodeInvalidError as exc:
        raise HTTPException(400, "That code is invalid") from exc
    except PhoneCodeExpiredError as exc:
        raise HTTPException(400, "That code expired. Request a new one") from exc
    except PasswordHashInvalidError as exc:
        raise HTTPException(400, "Wrong 2FA password") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc)) from exc
    session = client.session.save()
    session_path = SESSION_DIR / "backtick.session.txt"
    session_path.write_text(session, encoding="utf-8")
    os.chmod(session_path, 0o600)  # session string grants full account access
    _ensure_live_handler(client)
    user = await client.get_me()
    return {
        "ok": True,
        "session": session,
        "me": {
            "id": user.id,
            "name": utils.get_display_name(user),
            "username": user.username,
            "phone": user.phone,
        },
    }


@app.post("/api/auth/restore")
async def restore(body: RestoreIn):
    async with state.lock:
        if state.client:
            await state.client.disconnect()
        client = TelegramClient(StringSession(body.session), body.api_id, body.api_hash)
        await client.connect()
        if not await client.is_user_authorized():
            await client.disconnect()
            raise HTTPException(401, "Session is not authorized")
        state.client = client
        state.api_id = body.api_id
        state.api_hash = body.api_hash
        _ensure_live_handler(client)
        user = await client.get_me()
    return {
        "ok": True,
        "me": {
            "id": user.id,
            "name": utils.get_display_name(user),
            "username": user.username,
            "phone": user.phone,
        },
    }


@app.post("/api/auth/logout")
async def logout():
    async with state.lock:
        _drop_live_handler()
        if state.client:
            try:
                await state.client.log_out()
            except Exception:
                await state.client.disconnect()
        state.client = None
        state.phone = None
        state.phone_code_hash = None
    path = SESSION_DIR / "backtick.session.txt"
    if path.exists():
        path.unlink()
    return {"ok": True}


@app.get("/api/dialogs")
async def dialogs(limit: int = 80, q: str = ""):
    client = _require_client()
    limit = max(1, min(limit, 200))
    items = []
    async for dialog in client.iter_dialogs(limit=limit):
        item = _serialize_dialog(dialog)
        if q:
            blob = f"{item['name']} {item.get('username') or ''} {item['last']}".lower()
            if q.lower() not in blob:
                continue
        items.append(item)
    return {"dialogs": items}


@app.get("/api/messages")
async def messages(peer: str, limit: int = 40, offset_id: int = 0):
    client = _require_client()
    try:
        entity = await client.get_entity(int(peer))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, f"Chat not found: {exc}") from exc
    rows = []
    kwargs: dict[str, Any] = {"limit": min(limit, 100)}
    if offset_id:
        kwargs["offset_id"] = offset_id
    async for message in client.iter_messages(entity, **kwargs):
        rows.append(_serialize_message(message))
    rows.reverse()
    _attach_reply_context(rows)
    return {"messages": rows}


@app.post("/api/send")
async def send(body: SendIn):
    client = _require_client()
    text = body.text
    if not text.strip():
        raise HTTPException(400, "Empty message")
    try:
        entity = await client.get_entity(int(body.peer))
        sent = []
        for i, part in enumerate(_split_text(text)):
            message = await client.send_message(
                entity, part, reply_to=body.reply_to if i == 0 else None
            )
            sent.append(_serialize_message(message))
    except FloodWaitError as exc:
        raise HTTPException(429, f"Telegram rate limit. Retry in {exc.seconds}s") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc)) from exc
    if len(sent) == 1:
        return {"message": sent[0]}
    return {"messages": sent, "split": len(sent)}


class EditIn(BaseModel):
    peer: str
    msg_id: int
    text: str


@app.post("/api/edit")
async def edit_message(body: EditIn):
    client = _require_client()
    if not body.text.strip():
        raise HTTPException(400, "Empty message")
    if len(body.text) > SEND_LIMIT:
        raise HTTPException(400, f"Message too long (max {SEND_LIMIT} characters)")
    try:
        entity = await client.get_entity(int(body.peer))
        message = await client.edit_message(entity, body.msg_id, body.text)
    except FloodWaitError as exc:
        raise HTTPException(429, f"Telegram rate limit. Retry in {exc.seconds}s") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc)) from exc
    return {"message": _serialize_message(message)}


class DeleteIn(BaseModel):
    peer: str
    msg_id: int


@app.post("/api/delete")
async def delete_message(body: DeleteIn):
    client = _require_client()
    try:
        entity = await client.get_entity(int(body.peer))
        await client.delete_messages(entity, body.msg_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


class GSearchIn(BaseModel):
    query: str
    limit: int = 20


@app.post("/api/gsearch")
async def gsearch(body: GSearchIn):
    """Full-text search across all chats (Telegram server-side global search)."""
    client = _require_client()
    q = body.query.strip()
    if not q:
        raise HTTPException(400, "Empty query")
    hits = []
    async for message in client.iter_messages(None, search=q, limit=max(1, min(body.limit, 50))):
        item = _serialize_message(message)
        try:
            item["peer"] = str(utils.get_peer_id(message.peer_id))
        except Exception:
            item["peer"] = None
        try:
            chat = await message.get_chat()
            item["peer_name"] = utils.get_display_name(chat) if chat else None
        except Exception:
            item["peer_name"] = None
        hits.append(item)
    _attach_reply_context(hits)
    return {"messages": hits}


@app.post("/api/search")
async def search(body: SearchIn):
    client = _require_client()
    entity = await client.get_entity(int(body.peer))
    hits = []
    if body.regex:
        try:
            pattern = re.compile(body.query, re.IGNORECASE)
        except re.error as exc:
            raise HTTPException(400, f"Bad regex: {exc}") from exc
        async for message in client.iter_messages(entity, limit=400):
            if message.message and pattern.search(message.message):
                hits.append(_serialize_message(message))
            if len(hits) >= body.limit:
                break
    else:
        async for message in client.iter_messages(entity, search=body.query, limit=body.limit):
            hits.append(_serialize_message(message))
    _attach_reply_context(hits)
    return {"messages": hits}


async def _media_message(client: TelegramClient, peer: str, msg_id: int):
    try:
        entity = await client.get_entity(int(peer))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, f"Chat not found: {exc}") from exc
    message = await client.get_messages(entity, ids=msg_id)
    if not message or not message.media:
        raise HTTPException(404, "No file on that message")
    return message


def _download_response(data: bytes, name: str, inline: bool):
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    disp = "inline" if inline else "attachment"
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": f'{disp}; filename="{name}"',
            "Cache-Control": "private, max-age=86400",
        },
    )


@app.get("/api/file")
async def file(peer: str, msg_id: int):
    client = _require_client()
    message = await _media_message(client, peer, msg_id)
    data = await _fast_download(client, message)
    name = _filename(message) or f"file-{msg_id}"
    # Preview text files inline for the code panel.
    if Path(name).suffix.lower() in CODE_EXTS and len(data) < 200_000:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("utf-8", errors="replace")
        return {
            "name": name,
            "lang": LANG_BY_EXT.get(Path(name).suffix.lower()),
            "text": text,
            "bytes": len(data),
        }
    return _download_response(data, name, inline=False)


@app.get("/api/file/raw")
async def file_raw(peer: str, msg_id: int):
    client = _require_client()
    message = await _media_message(client, peer, msg_id)
    data = await _fast_download(client, message)
    name = _filename(message) or f"file-{msg_id}"
    return _download_response(data, name, inline=False)


@app.get("/api/media")
async def media_inline(peer: str, msg_id: int):
    """Full media bytes with an inline disposition, for <img>/<audio> tags."""
    client = _require_client()
    message = await _media_message(client, peer, msg_id)
    data = await _fast_download(client, message)
    name = _filename(message) or f"file-{msg_id}"
    return _download_response(data, name, inline=True)


@app.get("/api/thumb")
async def thumb(peer: str, msg_id: int):
    """Smallest Telegram-generated thumbnail for inline photo previews."""
    client = _require_client()
    message = await _media_message(client, peer, msg_id)
    buf = BytesIO()
    try:
        await client.download_media(message, file=buf, thumb=0)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, f"No thumbnail: {exc}") from exc
    data = buf.getvalue()
    if not data:
        raise HTTPException(404, "No thumbnail")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "Content-Disposition": "inline",
            "Cache-Control": "private, max-age=86400",
        },
    )


@app.post("/api/upload")
async def upload(peer: str = Form(...), caption: str = Form(""), upload: UploadFile = File(...)):
    client = _require_client()
    data = await upload.read()
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
    handle = await _fast_upload(client, data, upload.filename or "file")
    entity = await client.get_entity(int(peer))
    message = await client.send_file(entity, handle, caption=caption or None, force_document=True)
    return {"message": _serialize_message(message), "bytes": len(data), "parts": max(1, (len(data) + PART - 1) // PART)}


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


def _peer_blob(entity) -> dict[str, Any]:
    return {
        "id": str(utils.get_peer_id(entity)),
        "name": utils.get_display_name(entity) or "Untitled",
        "username": getattr(entity, "username", None),
        "kind": "bot" if isinstance(entity, User) and entity.bot else type(entity).__name__,
        "bot": bool(getattr(entity, "bot", False)),
        "verified": bool(getattr(entity, "verified", False)),
        "scam": bool(getattr(entity, "scam", False)),
        "about": None,
    }


@app.get("/api/peer")
async def peer_info(peer: str):
    client = _require_client()
    entity = await client.get_entity(int(peer))
    blob = _peer_blob(entity)
    try:
        if isinstance(entity, User):
            full = await client(GetFullUserRequest(entity))
            blob["about"] = getattr(full.full_user, "about", None)
        else:
            full = await client(GetFullChannelRequest(entity))
            blob["about"] = getattr(full.full_chat, "about", None)
    except Exception:
        pass
    return blob


@app.get("/api/raw")
async def raw_message(peer: str, msg_id: int):
    client = _require_client()
    entity = await client.get_entity(int(peer))
    message = await client.get_messages(entity, ids=msg_id)
    if not message:
        raise HTTPException(404, "Message not found")
    return {"message": json.loads(message.to_json())}


@app.post("/api/read")
async def mark_read(peer: str):
    client = _require_client()
    await client.send_read_acknowledge(int(peer))
    return {"ok": True}


@app.get("/api/export")
async def export_chat(peer: str, limit: int = 200):
    client = _require_client()
    entity = await client.get_entity(int(peer))
    name = utils.get_display_name(entity) or peer
    lines = [f"# {name}", "", f"peer: `{peer}`", ""]
    rows = []
    async for message in client.iter_messages(entity, limit=min(limit, 500)):
        rows.append(message)
    for message in reversed(rows):
        who = "you" if message.out else (utils.get_display_name(message.sender) if message.sender else "them")
        stamp = message.date.isoformat() if message.date else ""
        body = message.message or ""
        if message.media and not body:
            body = f"[{_filename(message) or 'file'}]"
        lines.append(f"## {who} · {stamp}")
        lines.append("")
        lines.append(body)
        lines.append("")
    data = "\n".join(lines).encode()
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "chat"
    return Response(
        content=data,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{safe}.md"'},
    )


PRIVACY_KEYS = {
    "last_seen": InputPrivacyKeyStatusTimestamp(),
    "phone": InputPrivacyKeyPhoneNumber(),
    "profile_photo": InputPrivacyKeyProfilePhoto(),
    "forwards": InputPrivacyKeyForwards(),
    "calls": InputPrivacyKeyPhoneCall(),
    "p2p": InputPrivacyKeyPhoneP2P(),
    "groups": InputPrivacyKeyChatInvite(),
    "voice": InputPrivacyKeyVoiceMessages(),
    "about": InputPrivacyKeyAbout(),
    "find_by_phone": InputPrivacyKeyAddedByPhone(),
}
PRIVACY_VALUES = {
    "everyone": InputPrivacyValueAllowAll(),
    "contacts": InputPrivacyValueAllowContacts(),
    "nobody": InputPrivacyValueDisallowAll(),
}


def _privacy_label(rules) -> str:
    names = {type(rule).__name__ for rule in rules or []}
    if "InputPrivacyValueAllowAll" in names or "PrivacyValueAllowAll" in names:
        return "everyone"
    if "InputPrivacyValueDisallowAll" in names or "PrivacyValueDisallowAll" in names:
        return "nobody"
    if "InputPrivacyValueAllowContacts" in names or "PrivacyValueAllowContacts" in names:
        return "contacts"
    return "custom"


class ProfileIn(BaseModel):
    first_name: str = ""
    last_name: str = ""
    about: str = ""


class PrivacyIn(BaseModel):
    key: str
    value: str


class SessionIn(BaseModel):
    hash: int


@app.get("/api/settings")
async def get_settings():
    client = _require_client()
    me = await client.get_me()
    full = await client(GetFullUserRequest(me))
    about = getattr(full.full_user, "about", None) or ""
    privacy = {}
    for key, tl in PRIVACY_KEYS.items():
        try:
            result = await client(GetPrivacyRequest(key=tl))
            privacy[key] = _privacy_label(result.rules)
        except Exception as exc:  # noqa: BLE001
            privacy[key] = f"unavailable: {exc}"
    auths = await client(GetAuthorizationsRequest())
    sessions = []
    for auth in auths.authorizations:
        sessions.append({
            "hash": auth.hash,
            "current": bool(auth.current),
            "device": auth.device_model,
            "platform": auth.platform,
            "app": auth.app_name,
            "country": auth.country,
            "ip": auth.ip,
            "date": auth.date_created.isoformat() if auth.date_created else None,
        })
    return {
        "profile": {
            "id": me.id,
            "first_name": me.first_name or "",
            "last_name": me.last_name or "",
            "username": me.username,
            "phone": me.phone,
            "about": about,
        },
        "privacy": privacy,
        "sessions": sessions,
    }


@app.post("/api/settings/profile")
async def set_profile(body: ProfileIn):
    client = _require_client()
    await client(UpdateProfileRequest(
        first_name=body.first_name.strip() or " ",
        last_name=body.last_name.strip(),
        about=body.about[:255],
    ))
    return {"ok": True}


@app.post("/api/settings/privacy")
async def set_privacy(body: PrivacyIn):
    if body.key not in PRIVACY_KEYS or body.value not in PRIVACY_VALUES:
        raise HTTPException(400, "Unknown privacy key or value")
    client = _require_client()
    await client(SetPrivacyRequest(key=PRIVACY_KEYS[body.key], rules=[PRIVACY_VALUES[body.value]]))
    return {"ok": True, "key": body.key, "value": body.value}


@app.post("/api/settings/sessions/terminate")
async def terminate_session(body: SessionIn):
    client = _require_client()
    await client(ResetAuthorizationRequest(hash=body.hash))
    return {"ok": True}
@app.post("/api/settings/forget-file")
async def forget_file():
    path = SESSION_DIR / "backtick.session.txt"
    if path.exists():
        path.unlink()
    return {"ok": True}


@app.post("/api/bot")
async def bot_call(body: BotCall):
    if body.method not in BOT_METHODS:
        raise HTTPException(400, "Method not on the workbench allowlist")
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", body.token):
        raise HTTPException(400, "That does not look like a bot token")

    def _call() -> dict[str, Any]:
        url = f"https://api.telegram.org/bot{body.token}/{body.method}"
        payload = json.dumps(body.params or {}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"ok": False, "description": raw}

    return await asyncio.to_thread(_call)


app.mount("/static", StaticFiles(directory=STATIC), name="static")
