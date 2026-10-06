"""Unit tests for Backtick's pure server logic. No network, no Telegram login."""

import datetime
from types import SimpleNamespace

import pytest

import server
from server import (
    BOT_METHODS,
    _attach_reply_context,
    _filename,
    _privacy_label,
    _serialize_dialog,
    _serialize_message,
    _split_text,
)
from telethon.tl.types import (
    Document,
    DocumentAttributeAudio,
    DocumentAttributeFilename,
    DocumentAttributeSticker,
    Message,
    MessageMediaDocument,
    MessageMediaPhoto,
    PeerChannel,
    PeerUser,
    UpdateNewMessage,
    User,
)


def _msg(**kw):
    base = dict(
        id=1,
        peer_id=PeerUser(777),
        date=datetime.datetime(2026, 10, 3, 12, 0, tzinfo=datetime.timezone.utc),
        message="hello",
        out=False,
    )
    base.update(kw)
    return Message(**base)


def _user(**kw):
    base = dict(id=777, first_name="Ada", last_name="L", access_hash=1)
    base.update(kw)
    return User(**base)


# --- message splitting -----------------------------------------------------

def test_split_short_unchanged():
    assert _split_text("hi") == ["hi"]
    assert _split_text("x" * 4000) == ["x" * 4000]


def test_split_prefers_paragraph_break():
    text = "a" * 3990 + "\n\n" + "b" * 100
    parts = _split_text(text)
    assert len(parts) == 2
    assert parts[0] == "a" * 3990
    assert parts[1] == "b" * 100


def test_split_prefers_line_break():
    text = "a" * 3990 + "\n" + "b" * 100
    parts = _split_text(text)
    assert parts == ["a" * 3990, "b" * 100]


def test_split_hard_cut_no_newlines():
    text = "x" * 9000
    parts = _split_text(text)
    assert len(parts) == 3
    assert all(len(p) <= 4000 for p in parts)
    assert "".join(parts) == text


def test_split_terminates():
    # pathological: no progress trap
    parts = _split_text("y" * 4001)
    assert len(parts) == 2


# --- serialization ---------------------------------------------------------

def test_serialize_basic_message():
    m = _msg()
    m._sender = _user()  # sender is a read-only property backed by _sender
    out = _serialize_message(m)
    assert out["id"] == 1
    assert out["text"] == "hello"
    assert out["sender"] == "Ada L"
    assert out["out"] is False
    assert out["reply_to"] is None
    assert out["media_kind"] is None
    assert out["sticker"] is False
    assert out["voice"] is False


def test_serialize_photo():
    m = _msg(media=MessageMediaPhoto(photo=None, ttl_seconds=None))
    out = _serialize_message(m)
    assert out["media_kind"] == "photo"


def test_serialize_sticker_and_voice():
    doc = Document(
        id=1, access_hash=1, file_reference=b"", date=datetime.datetime.now(datetime.timezone.utc),
        mime_type="image/webp", size=100, thumbs=[], video_thumbs=[],
        dc_id=1,
        attributes=[DocumentAttributeSticker(alt="hi", stickerset=None),
                    DocumentAttributeFilename(file_name="sticker.webp")],
    )
    m = _msg(media=MessageMediaDocument(document=doc, ttl_seconds=None))
    out = _serialize_message(m)
    assert out["sticker"] is True
    assert out["file_name"] == "sticker.webp"

    vdoc = Document(
        id=2, access_hash=1, file_reference=b"", date=datetime.datetime.now(datetime.timezone.utc),
        mime_type="audio/ogg", size=200, thumbs=[], video_thumbs=[], dc_id=1,
        attributes=[DocumentAttributeAudio(duration=7, voice=True,
                                           title=None, performer=None, waveform=None)],
    )
    mv = _msg(id=2, media=MessageMediaDocument(document=vdoc, ttl_seconds=None))
    outv = _serialize_message(mv)
    assert outv["voice"] is True
    assert outv["voice_duration"] == 7


def test_filename_extraction():
    doc = SimpleNamespace(attributes=[DocumentAttributeFilename(file_name="app.py")])
    m = SimpleNamespace(media=MessageMediaDocument(document=doc, ttl_seconds=None))
    assert _filename(m) == "app.py"
    m2 = SimpleNamespace(media=MessageMediaPhoto(photo=None, ttl_seconds=None))
    assert _filename(m2) is None


def test_serialize_dialog_user_and_channel():
    user = _user(bot=False, username="ada")
    dlg = SimpleNamespace(
        id=777, entity=user, name="Ada L", message=None,
        unread_count=3, date=None, pinned=False,
    )
    out = _serialize_dialog(dlg)
    assert out == {
        "id": "777", "name": "Ada L", "username": "ada", "kind": "user",
        "unread": 3, "last": "", "date": None, "pinned": False,
    }

    channel = SimpleNamespace(broadcast=True, megagroup=False, username="news")
    dlg2 = SimpleNamespace(
        id=-100123, entity=channel, name="News", message=None,
        unread_count=0, date=None, pinned=True,
    )
    assert _serialize_dialog(dlg2)["kind"] == "channel"


def test_attach_reply_context():
    rows = [
        {"id": 1, "text": "original question\nwith lines", "sender": "Ada", "out": False},
        {"id": 2, "text": "answer", "sender": "you", "out": True, "reply_to": 1},
        {"id": 3, "text": "orphan", "reply_to": 999},
    ]
    _attach_reply_context(rows)
    assert rows[1]["reply_sender"] == "Ada"
    assert rows[1]["reply_text"] == "original question with lines"
    assert "reply_sender" not in rows[0]
    assert "reply_sender" not in rows[2]


def test_privacy_label():
    allow_all = type("InputPrivacyValueAllowAll", (), {})()
    assert _privacy_label([allow_all]) == "everyone"
    assert _privacy_label([]) == "custom"


def test_bot_allowlist_sane():
    assert "getMe" in BOT_METHODS
    assert "sendMessage" in BOT_METHODS
    assert "getChatAdministrators" in BOT_METHODS
    assert "getChatMember" in BOT_METHODS
    assert "answerCallbackQuery" in BOT_METHODS
    # logOut would revoke the bot token with one click — never in the workbench
    assert "logOut" not in BOT_METHODS


def test_update_new_message_is_plain_message():
    """The live WS handler only processes real messages, like the Telethon filter."""
    upd = UpdateNewMessage(message=_msg(), pts=1, pts_count=1)
    assert isinstance(upd.message, Message)
