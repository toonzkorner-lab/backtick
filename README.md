# Backtick

A Telegram web client for developers. It signs in as you over MTProto (Telethon), then adds the tools official clients leave out: fenced code, diffs, file preview, regex search, a command palette, a Bot API workbench, message inspection, snippets, and Markdown export.

Your `api_id` and `api_hash` never leave this machine. The session string is saved in `sessions/backtick.session.txt` and in browser localStorage.

## Run

```bash
cd backtick
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

Open http://127.0.0.1:8787. Add `?demo=1` to walk the UI without signing in.

Run with a single worker (the default). Auth state lives in process memory, so `--workers 2+` will break logins.

Tests: `python -m pytest` from this directory (14 tests, no network or login needed).

## 0.6.0 — media, replies, mobile, hardening

- **Inline media.** Photos render as thumbnails (tap for full size), stickers show inline, voice notes get a playable bar with duration. New endpoints: `GET /api/media` (inline bytes) and `GET /api/thumb` (small preview).
- **Reply context.** Messages quote the message they reply to — tap to jump to the original.
- **Day dividers + grouped messages.** Threads read like a chat app now, not a wall of cards.
- **Drag-and-drop uploads** onto the thread.
- **Long messages auto-split** at 4000 characters instead of failing. Telegram rate limits now show a retry countdown and retry once automatically.
- **Bot workbench:** parse_mode selector (MarkdownV2/HTML), link-preview toggle, `getChatAdministrators`, `answerCallbackQuery`. `logOut` was removed from the method allowlist — it revoked the bot token with one click.
- **Mobile layout.** Below 1100px the rail becomes a slide-over Panel; below 760px the sidebar becomes a slide-over chat list, with Chats/Panel buttons in the top bar.
- **Privacy.** highlight.js and the IBM Plex fonts are vendored under `static/vendor/` — the page makes zero third-party requests now. Every response carries a Content-Security-Policy plus `X-Content-Type-Options: nosniff`.
- **Stability.** Dependencies pinned to tested versions; `tests/` covers splitting, serialization, reply context, privacy labels, and the bot allowlist.

## 0.4.1 fixes

- Saving Backtick settings no longer throws (`applyPrivacyChrome` is defined now); notification and idle-lock prefs apply immediately.
- Links containing `&` (query strings) are escaped once, not twice — they open correctly.
- Timestamps in non-relative mode use your local timezone, not UTC.
- Profile bio saves up to 255 characters (was silently cut at 70).
- Peer inspector shows the bio again (`/api/peer` uses the full-user/channel request).
- Click-to-reveal hides every paragraph of a message, not just the first.
- The quote action has a real button on each message now.
- Uploads are capped at 200 MB per file (configurable via `MAX_UPLOAD_BYTES` in `server.py`); the session file is written with `0600` permissions.
- Demo mode uses a neutral "Demo User" identity instead of a personal handle.
- JWT base64url decode no longer uses deprecated `escape`/`unescape`.

Note: the session, api_id, api_hash, and bot token are kept in browser localStorage as plaintext. Fine on your own machine; don't sign in from a shared one.

## 0.5.0 features

- **Live updates.** New messages arrive instantly over a WebSocket (`/api/ws`) fed by Telethon update events — no more waiting on the 20-second poll. The open thread appends in place, other chats bump to the top with fresh unread counts, and edits made on another device update live. The old poll stays as a silent fallback and only sends desktop notifications when the socket is down.
- **Load older.** Threads page backwards 60 messages at a time with scroll position preserved.
- **Edit and delete.** Your own messages get edit/del buttons. Edit loads the text into the composer (Send becomes Save, Esc cancels); delete asks once and removes it.
- **Search everywhere.** The thread search has an "everywhere" checkbox backed by Telegram server-side global search (`POST /api/gsearch`); results show which chat they're in and jump straight there. Also in the command palette.
- Fixed along the way: `python-multipart` was missing from `requirements.txt`, which would have crashed the server at startup as soon as the upload route loaded.

Get api_id and api_hash from https://my.telegram.org under API development tools. Phone must be international (`+15551234567`).

## Developer tools

- Chat filters: all, unread, bots, groups, channels, people.
- Composer inserts: python, ts, json, diff, sql, shell, stack trace. `Ctrl+\`` fences a selection.
- Command palette: `Ctrl+P`. Chat filter: `Ctrl+K`. Move chats with `j` / `k`.
- Code preview for text attachments under 200 KB, with syntax highlighting.
- Inspector: selected message plus raw MTProto JSON.
- Bot workbench: allowlisted Bot API methods (`getMe`, webhook info, updates, commands, `sendMessage`). Token stays in this browser and is only sent to the local server.
- Workflow rail: GitHub and GitLab links in the open thread.
- Tools rail: thread stats, regex over loaded messages, JSON pretty/minify, JWT decode (no signature check), Base64, SHA-256, unix time, peer-id explainer, inline keyboard JSON.
- Local pins, per-chat drafts, and a bot call log in this browser.
- Fence copies a message into the composer as a code block.
- Backtick privacy, notifications, and session controls are local: hide phone, usernames, and previews, click-to-reveal text, desktop alerts, mute bots or channels, remember-browser, idle lock, and forget the browser or server session file. They do not change Telegram account privacy.

Keep the server on localhost. Anyone who can reach the port can use the signed-in session.
